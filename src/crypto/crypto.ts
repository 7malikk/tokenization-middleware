// Crypto core. Plain functions over node:crypto with no NestJS imports.
//
// Error messages here never include key material, plaintext, or any input
// bytes, so callers can surface or log them safely.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const TOKEN_BYTES = 16;
export const KEY_BYTES = 32;
export const IV_BYTES = 12;
export const AUTH_TAG_BYTES = 16;
export const WRAPPED_KEY_BYTES = 40;

const DATA_CIPHER = 'aes-256-gcm';
const WRAP_CIPHER = 'id-aes256-wrap';
// RFC 3394 section 2.2.3.1 default initial value.
const WRAP_IV = Buffer.from('A6A6A6A6A6A6A6A6', 'hex');

/**
 * A Buffer backed by a plain (non-shared) ArrayBuffer. This is what node:crypto
 * returns, and it is directly assignable to Prisma `Bytes` fields.
 */
export type Bytes = Buffer<ArrayBuffer>;

export interface EncryptedPayload {
  ciphertext: Bytes;
  iv: Bytes;
  authTag: Bytes;
}

/** Opaque 128-bit random token as 32 lowercase hex chars. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/** Fresh 32-byte data key. Caller must zeroize it after use. */
export function generateDataKey(): Bytes {
  return randomBytes(KEY_BYTES);
}

/** AES-256-GCM with a fresh 12-byte IV and a 16-byte auth tag. */
export function encrypt(plaintext: Buffer, dataKey: Buffer): EncryptedPayload {
  assertLength(dataKey, KEY_BYTES, 'data key');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(DATA_CIPHER, dataKey, iv, { authTagLength: AUTH_TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

/** Throws if the key is wrong or any of ciphertext, IV, or tag was altered. */
export function decrypt(payload: EncryptedPayload, dataKey: Buffer): Bytes {
  assertLength(dataKey, KEY_BYTES, 'data key');
  assertLength(payload.iv, IV_BYTES, 'IV');
  assertLength(payload.authTag, AUTH_TAG_BYTES, 'auth tag');
  const decipher = createDecipheriv(DATA_CIPHER, dataKey, payload.iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  decipher.setAuthTag(payload.authTag);
  try {
    return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
  } catch {
    throw new Error('decryption failed: authentication check did not pass');
  }
}

/** AES Key Wrap (RFC 3394 / NIST SP 800-38F). 32-byte key in, 40 bytes out. */
export function wrapKey(dataKey: Buffer, masterKey: Buffer): Bytes {
  assertLength(dataKey, KEY_BYTES, 'data key');
  assertLength(masterKey, KEY_BYTES, 'master key');
  const cipher = createCipheriv(WRAP_CIPHER, masterKey, WRAP_IV);
  return Buffer.concat([cipher.update(dataKey), cipher.final()]);
}

/** Throws if the wrapped key fails the RFC 3394 integrity check. */
export function unwrapKey(wrapped: Buffer, masterKey: Buffer): Bytes {
  assertLength(wrapped, WRAPPED_KEY_BYTES, 'wrapped key');
  assertLength(masterKey, KEY_BYTES, 'master key');
  const decipher = createDecipheriv(WRAP_CIPHER, masterKey, WRAP_IV);
  try {
    return Buffer.concat([decipher.update(wrapped), decipher.final()]);
  } catch {
    throw new Error('key unwrap failed: integrity check did not pass');
  }
}

/** Overwrite a buffer holding secret material. */
export function zeroize(buf: Buffer): void {
  buf.fill(0);
}

function assertLength(buf: Buffer, expected: number, name: string): void {
  if (!Buffer.isBuffer(buf) || buf.length !== expected) {
    throw new Error(`invalid ${name}: expected ${expected} bytes`);
  }
}
