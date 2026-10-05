'use strict';
// Shared helpers for the evaluation tools. These run inside the evaluator
// container (the middleware's migrate image), so they reuse the middleware's
// own compiled code: its crypto core, key file handling and Prisma client
// (with the append-only audit log extension). Databases are read only through
// Prisma. No tool prints a BVN: values are compared as hashes or booleans.

const { createHash, randomInt } = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const https = require('node:https');
const { dirname } = require('node:path');

const DIST = '/app/dist';
const crypto = require(`${DIST}/crypto/crypto.js`);
const keyFile = require(`${DIST}/keys/key-file.js`);
const { createPrismaClient } = require(`${DIST}/prisma/prisma.js`);

const env = process.env;

/** The fixed 404 body the middleware gives for unknown, foreign and erased tokens. */
const NOT_FOUND_BODY = '{"message":"token not found","error":"Not Found","statusCode":404}';

// ---------------------------------------------------------------------------
// Output

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, jsonReplacer, 2)}\n`);
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString();
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) return `hex:${Buffer.from(value.data).toString('hex')}`;
  return value;
}

function log(line) {
  process.stderr.write(`  ${line}\n`);
}

/** A list of expectations, each { name, expected, actual, pass }. */
function expectation(name, expected, actual, pass = actual === expected) {
  return { name, expected, actual, pass: Boolean(pass) };
}

function allPass(expectations) {
  return expectations.every((e) => e.pass);
}

/** Markdown table from a header row and body rows. Cells are escaped for pipes. */
function mdTable(header, rows) {
  const cell = (v) => String(v === null ? 'null' : (v ?? '')).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [
    `| ${header.map(cell).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

function expectationsTable(expectations) {
  return mdTable(
    ['Check', 'Expected', 'Observed', 'Result'],
    expectations.map((e) => [e.name, e.expected, e.actual, e.pass ? 'PASS' : 'FAIL']),
  );
}

// ---------------------------------------------------------------------------
// Data

/** Random 11-digit string shaped like a BVN. Synthetic data only. */
function syntheticBvn() {
  let bvn = '';
  for (let i = 0; i < 11; i++) bvn += randomInt(0, 10).toString();
  return bvn;
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function credentials() {
  return readJson(env.EVALUATION_CREDENTIALS_FILE);
}

// ---------------------------------------------------------------------------
// Databases (Prisma only)

/** Prisma client for VAULT_DATABASE_* or SCRATCH_DATABASE_* (built like the middleware's own). */
function database(prefix) {
  return createPrismaClient({
    DATABASE_HOST: env[`${prefix}_DATABASE_HOST`],
    DATABASE_NAME: env[`${prefix}_DATABASE_NAME`],
    DATABASE_USER: env[`${prefix}_DATABASE_USER`],
    DATABASE_SCHEMA: env[`${prefix}_DATABASE_SCHEMA`],
    DATABASE_PASSWORD_FILE: env[`${prefix}_DATABASE_PASSWORD_FILE`],
  });
}

// ---------------------------------------------------------------------------
// Keys

/** Every master key version, unwrapped with the KEK. The caller must zeroize them. */
function unlockMasterKeys() {
  const kek = keyFile.takeKek({ MASTER_KEK_FILE: env.MASTER_KEK_FILE });
  try {
    return keyFile.unlockKeyFile(keyFile.readKeyFile(env.MASTER_KEY_FILE), kek);
  } finally {
    crypto.zeroize(kek);
  }
}

/** True if AES-256-GCM decryption with this key passes authentication. */
function decrypts(payload, key) {
  try {
    crypto.zeroize(crypto.decrypt(payload, key));
    return true;
  } catch {
    return false;
  }
}

/** Decrypt and return only the SHA-256 of the plaintext, never the plaintext. */
function decryptToHash(payload, key) {
  const plaintext = crypto.decrypt(payload, key);
  try {
    return sha256(plaintext);
  } finally {
    crypto.zeroize(plaintext);
  }
}

/** True if AES-KW unwrap with this key passes its integrity check. */
function unwraps(wrapped, key) {
  try {
    crypto.zeroize(crypto.unwrapKey(wrapped, key));
    return true;
  } catch {
    return false;
  }
}

function payloadOf(record) {
  return {
    ciphertext: Buffer.from(record.ciphertext),
    iv: Buffer.from(record.iv),
    authTag: Buffer.from(record.authTag),
  };
}

// ---------------------------------------------------------------------------
// HTTP

/** HTTPS client for the middleware that trusts only its certificate. */
function middlewareClient() {
  const agent = new https.Agent({ ca: readFileSync(env.MIDDLEWARE_CA_PATH), keepAlive: true });
  const base = new URL(env.MIDDLEWARE_URL);
  return {
    post(path, payload, apiKey) {
      const data = JSON.stringify(payload);
      return new Promise((resolve, reject) => {
        const req = https.request(
          new URL(path, base),
          {
            method: 'POST',
            agent,
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(data),
              authorization: `Bearer ${apiKey}`,
            },
          },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              let json = null;
              try {
                json = JSON.parse(text);
              } catch {
                json = null;
              }
              resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
            res.on('error', reject);
          },
        );
        req.on('error', reject);
        req.end(data);
      });
    },
    close() {
      agent.destroy();
    },
  };
}

/** POST to the evaluation app (plain HTTP inside the Compose network). */
async function appPost(path, payload) {
  const res = await fetch(new URL(path, env.EVALUATION_APP_URL), {
    method: 'POST',
    headers: payload ? { 'content-type': 'application/json' } : {},
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** Tokenize a fresh synthetic BVN. Returns the token and the BVN's SHA-256 only, never the BVN. */
async function tokenizeSynthetic(client, apiKey) {
  const bvn = syntheticBvn();
  const res = await client.post('/v1/tokenize', { dataType: 'BVN', value: bvn }, apiKey);
  if (res.status !== 201 || !res.json || typeof res.json.token !== 'string') {
    throw new Error(`tokenize returned ${res.status}`);
  }
  return { token: res.json.token, bvnSha256: sha256(bvn) };
}

// ---------------------------------------------------------------------------
// pg_dump plain-format parsing (read-only inspection of dump files)

/** Undo COPY text escaping. Returns null for \N. */
function copyUnescape(field) {
  if (field === '\\N') return null;
  return field.replace(/\\(.)/g, (_m, c) => ({ t: '\t', n: '\n', r: '\r', b: '\b', f: '\f', v: '\v' })[c] ?? c);
}

/** A bytea field from COPY output (hex format, "\x..."), as a Buffer. */
function copyBytea(field) {
  const value = copyUnescape(field);
  if (value === null) return null;
  if (!value.startsWith('\\x')) throw new Error('unexpected bytea format in dump');
  return Buffer.from(value.slice(2), 'hex');
}

/**
 * Split a plain pg_dump into its COPY blocks. Each block has the table, its
 * column names, the line number of the COPY statement, and its rows as raw
 * (still escaped) field arrays.
 */
function parseCopyBlocks(dump) {
  const lines = dump.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^COPY ([^ ]+) \((.*)\) FROM stdin;$/.exec(lines[i]);
    if (!m) continue;
    const block = { table: m[1], columns: m[2].split(', ').map((c) => c.replace(/"/g, '')), line: i + 1, rows: [] };
    for (i++; i < lines.length && lines[i] !== '\\.'; i++) {
      block.rows.push({ line: i + 1, fields: lines[i].split('\t') });
    }
    blocks.push(block);
  }
  return blocks;
}

/** Column definitions of a table from the dump's CREATE TABLE statement. */
function tableColumns(dump, table) {
  const start = dump.indexOf(`CREATE TABLE ${table} (`);
  if (start < 0) return [];
  const end = dump.indexOf('\n);', start);
  return dump
    .slice(dump.indexOf('\n', start) + 1, end)
    .split('\n')
    .map((l) => l.trim().replace(/,$/, ''))
    .filter((l) => l.length > 0 && !l.startsWith('CONSTRAINT'))
    .map((l) => {
      const [name, ...type] = l.split(' ');
      return { name: name.replace(/"/g, ''), type: type.join(' ') };
    });
}

/**
 * Find BVNs known only by their SHA-256 in a text, without holding the BVNs:
 * every 11-digit window is hashed and compared, both as digits and as the hex
 * of their ASCII bytes (how a bytea column would show them in a dump).
 * Returns how many windows matched in each form.
 */
function findBvnHashes(text, hashes) {
  const found = { decimal: 0, hexEncoded: 0 };
  const scan = (pattern, width, decode, key) => {
    for (const m of text.matchAll(pattern)) {
      // Every offset, so a hex run that starts mid-byte is still covered.
      for (let i = 0; i + width <= m[0].length; i++) {
        if (hashes.has(sha256(decode(m[0].slice(i, i + width))))) found[key]++;
      }
    }
  };
  scan(/[0-9]{11,}/g, 11, (w) => w, 'decimal');
  scan(/(?:3[0-9]){11,}/g, 22, (w) => Buffer.from(w, 'hex').toString('latin1'), 'hexEncoded');
  return found;
}

/** Count how many of the given strings occur in the text. */
function countPresent(text, values) {
  let n = 0;
  for (const v of values) if (text.includes(v)) n++;
  return n;
}

module.exports = {
  NOT_FOUND_BODY,
  allPass,
  appPost,
  copyBytea,
  copyUnescape,
  countPresent,
  credentials,
  crypto,
  database,
  decryptToHash,
  decrypts,
  env,
  expectation,
  expectationsTable,
  findBvnHashes,
  keyFile,
  log,
  mdTable,
  middlewareClient,
  parseCopyBlocks,
  payloadOf,
  readJson,
  sha256,
  syntheticBvn,
  tableColumns,
  tokenizeSynthetic,
  unlockMasterKeys,
  unwraps,
  writeJson,
  writeText,
};
