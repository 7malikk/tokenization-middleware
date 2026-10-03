// Master key file and KEK handling. Plain functions with no NestJS imports.
//
// Every error message here is a fixed string or names only a version number
// or setting name. None includes key material, wrapped keys, or file content.

import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Bytes, KEY_BYTES, WRAPPED_KEY_BYTES, unwrapKey, wrapKey, zeroize } from '../crypto/crypto';

/** Key layer failure. Messages are safe to show: they never contain key material. */
export class KeyLayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyLayerError';
  }
}

export interface KeyFile {
  active: number;
  keys: { version: number; wrapped: string }[];
}

type MutableEnv = Record<string, string | undefined>;

const MAX_VERSION = 32767; // master_key_version is a smallint
const KEK_HEX = /^[0-9a-fA-F]{64}$/;
const WRAPPED_HEX = new RegExp(`^[0-9a-f]{${WRAPPED_KEY_BYTES * 2}}$`);

/**
 * Read the KEK from exactly one of MASTER_KEK or MASTER_KEK_FILE. A KEK taken
 * from MASTER_KEK is deleted from the given env and from process.env. The
 * caller owns the returned buffer and must zeroize it.
 */
export function takeKek(env: MutableEnv): Buffer {
  const inline = env.MASTER_KEK;
  const filePath = env.MASTER_KEK_FILE;
  if (inline !== undefined) {
    delete env.MASTER_KEK;
    delete process.env.MASTER_KEK;
  }
  const hasInline = inline !== undefined && inline !== '';
  const hasFile = filePath !== undefined && filePath !== '';
  if (hasInline && hasFile) {
    throw new KeyLayerError('set only one of MASTER_KEK and MASTER_KEK_FILE');
  }
  if (!hasInline && !hasFile) {
    throw new KeyLayerError('no KEK: set MASTER_KEK or MASTER_KEK_FILE');
  }

  let hex: string;
  if (hasInline) {
    hex = inline as string;
  } else {
    let raw: Buffer;
    try {
      raw = readFileSync(filePath as string);
    } catch {
      throw new KeyLayerError('MASTER_KEK_FILE could not be read');
    }
    hex = raw.toString('latin1').trim();
    zeroize(raw);
  }
  if (!KEK_HEX.test(hex)) {
    throw new KeyLayerError(`the KEK must be ${KEY_BYTES * 2} hex characters`);
  }
  return Buffer.from(hex, 'hex');
}

/** A new random KEK as 64 hex chars. */
export function generateKekHex(): string {
  const kek = randomBytes(KEY_BYTES);
  const hex = kek.toString('hex');
  zeroize(kek);
  return hex;
}

export function readKeyFile(path: string | undefined): KeyFile {
  if (!path) {
    throw new KeyLayerError('MASTER_KEY_FILE is not set');
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new KeyLayerError('master key file is missing or unreadable (MASTER_KEY_FILE)');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new KeyLayerError('master key file is malformed: not valid JSON');
  }
  return validateKeyFile(parsed);
}

function validateKeyFile(value: unknown): KeyFile {
  const fail = (why: string): never => {
    throw new KeyLayerError(`master key file is malformed: ${why}`);
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('expected an object');
  const { active, keys, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) fail('unexpected fields');
  if (!isVersion(active)) fail('"active" must be a version number');
  if (!Array.isArray(keys) || keys.length === 0) fail('"keys" must be a non-empty list');

  const seen = new Set<number>();
  const entries = (keys as unknown[]).map((entry) => {
    if (typeof entry !== 'object' || entry === null) fail('each key must be an object');
    const { version, wrapped, ...extra } = entry as Record<string, unknown>;
    if (Object.keys(extra).length > 0) fail('unexpected fields in a key');
    if (!isVersion(version)) fail('each key needs a version number');
    if (seen.has(version as number)) fail('duplicate key version');
    seen.add(version as number);
    if (typeof wrapped !== 'string' || !WRAPPED_HEX.test(wrapped)) fail('each wrapped key must be 80 hex chars');
    return { version: version as number, wrapped: wrapped as string };
  });
  if (!seen.has(active as number)) fail('the active version has no key');
  return { active: active as number, keys: entries };
}

function isVersion(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_VERSION;
}

/**
 * Unwrap every master key version. Throws, naming only the version, if any
 * fails the AES-KW integrity check (wrong KEK or tampered file).
 */
export function unlockKeyFile(file: KeyFile, kek: Buffer): Map<number, Bytes> {
  const keys = new Map<number, Bytes>();
  for (const { version, wrapped } of file.keys) {
    try {
      keys.set(version, unwrapKey(Buffer.from(wrapped, 'hex'), kek));
    } catch {
      zeroizeAll(keys);
      throw new KeyLayerError(`master key version ${version} failed to unwrap: wrong KEK or tampered key file`);
    }
  }
  return keys;
}

export function zeroizeAll(keys: Map<number, Buffer>): void {
  for (const key of keys.values()) {
    zeroize(key);
  }
  keys.clear();
}

/** Wrap a master key under the KEK for storage in the file. */
export function wrapMasterKey(version: number, masterKey: Buffer, kek: Buffer): KeyFile['keys'][number] {
  return { version, wrapped: wrapKey(masterKey, kek).toString('hex') };
}

/** Create the key file with version 1. Refuses if the file already exists. */
export function initKeyFile(path: string | undefined, kek: Buffer): void {
  if (!path) {
    throw new KeyLayerError('MASTER_KEY_FILE is not set');
  }
  if (existsSync(path)) {
    throw new KeyLayerError('master key file already exists; refusing to overwrite it');
  }
  const masterKey = randomBytes(KEY_BYTES);
  try {
    const file: KeyFile = { active: 1, keys: [wrapMasterKey(1, masterKey, kek)] };
    // "wx" fails if the file appeared since the check above.
    writeDurably(path, serialize(file), 'wx');
  } finally {
    zeroize(masterKey);
  }
}

/** Replace the key file atomically: write a temp file, fsync, rename over. */
export function replaceKeyFile(path: string, file: KeyFile): void {
  const temp = join(dirname(path), `.${process.pid}.${randomBytes(4).toString('hex')}.keyfile.tmp`);
  writeDurably(temp, serialize(file), 'wx');
  renameSync(temp, path);
}

function serialize(file: KeyFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

function writeDurably(path: string, content: string, flag: string): void {
  const fd = openSync(path, flag, 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
