'use strict';
// Final check of every run: no secret may appear anywhere in the results folder.
//
//   node secret-scan.js <resultsDir> <secretsDir>
//
// Secrets searched for: the KEK, every master key version (unwrapped with the
// KEK, in memory only), every API key and every password in the secrets
// folder (database passwords, the demo password), and the TLS private key.
// Each is searched for in every encoding a tool could plausibly have written
// it: as stored, hex (both cases), base64, base64url and URL-encoded, and raw
// bytes for binary keys. Writes <resultsDir>/secret-scan.json naming only the
// secret, its encoding and the file. Never prints a secret. Exit 3 if any is found.

const { readdirSync, readFileSync, statSync } = require('node:fs');
const { basename, join, relative } = require('node:path');
const { crypto, log, unlockMasterKeys, writeJson } = require('./lib');

// Not secrets: the public certificate and an application id.
const NOT_SECRET = new Set(['tls-cert.pem', 'reference-app-id']);
const MIN_LENGTH = 16; // every real secret is longer; shorter strings would match by chance

/** Every searchable form of one secret, as { encoding, bytes }. */
function forms(text, raw) {
  const out = [{ encoding: 'as stored', bytes: Buffer.from(text, 'utf8') }];
  if (encodeURIComponent(text) !== text) out.push({ encoding: 'URL-encoded', bytes: Buffer.from(encodeURIComponent(text)) });
  if (raw) {
    out.push(
      { encoding: 'raw bytes', bytes: raw },
      { encoding: 'hex', bytes: Buffer.from(raw.toString('hex')) },
      { encoding: 'HEX', bytes: Buffer.from(raw.toString('hex').toUpperCase()) },
      { encoding: 'base64', bytes: Buffer.from(raw.toString('base64')) },
      { encoding: 'base64url', bytes: Buffer.from(raw.toString('base64url')) },
    );
  }
  // Text secrets may also have been written as base64 of their characters.
  out.push({ encoding: 'base64 of text', bytes: Buffer.from(Buffer.from(text).toString('base64')) });
  return out.filter((f) => f.bytes.length >= MIN_LENGTH);
}

function collectSecrets(secretsDir) {
  const secrets = [];
  const add = (name, text, raw) => secrets.push({ name, forms: forms(text, raw) });

  for (const file of readdirSync(secretsDir).sort()) {
    const path = join(secretsDir, file);
    if (NOT_SECRET.has(file) || !statSync(path).isFile()) continue;
    const content = readFileSync(path, 'utf8').trim();
    if (file.endsWith('.json')) {
      // evaluation-credentials.json: the API keys are secret; ids and names are not.
      const visit = (value, at) => {
        if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, `${at}.${k}`);
        else if (typeof value === 'string' && /^tkm_/.test(value)) {
          add(`API key (${file}${at})`, value, null);
          add(`API key secret part (${file}${at})`, value.slice(4), null);
        }
      };
      visit(JSON.parse(content), '');
    } else if (file === 'master-kek') {
      add('KEK (master-kek)', content, Buffer.from(content, 'hex'));
    } else if (/^tkm_/.test(content)) {
      add(`API key (${file})`, content, null);
      add(`API key secret part (${file})`, content.slice(4), null);
    } else if (file.endsWith('.pem')) {
      // The whole PEM, its base64 body joined, and each body line on its own.
      const lines = content.split('\n').filter((l) => !l.startsWith('-----'));
      add(`TLS private key (${file})`, content, null);
      add(`TLS private key body (${file})`, lines.join(''), null);
      lines.forEach((line, i) => add(`TLS private key line ${i + 1} (${file})`, line, null));
    } else {
      add(`password (${file})`, content, null);
    }
  }

  const masterKeys = unlockMasterKeys();
  for (const [version, key] of masterKeys) {
    add(`master key version ${version}`, key.toString('hex'), Buffer.from(key));
    crypto.zeroize(key);
  }
  return secrets;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

function main() {
  const [resultsDir, secretsDir] = process.argv.slice(2);
  const secrets = collectSecrets(secretsDir);
  const findings = [];
  let files = 0;
  let bytes = 0;
  for (const path of walk(resultsDir)) {
    if (basename(path) === 'secret-scan.json') continue;
    const content = readFileSync(path);
    files++;
    bytes += content.length;
    for (const secret of secrets) {
      for (const form of secret.forms) {
        if (content.includes(form.bytes)) findings.push({ file: relative(resultsDir, path), secret: secret.name, encoding: form.encoding });
      }
    }
  }
  const result = {
    check: 'no KEK, master key, API key, password or TLS private key anywhere in the results folder',
    secretsSearched: secrets.map((s) => ({ secret: s.name, encodings: s.forms.map((f) => f.encoding) })),
    filesScanned: files,
    bytesScanned: bytes,
    findings,
    pass: findings.length === 0,
  };
  writeJson(join(resultsDir, 'secret-scan.json'), result);
  log(`secret scan: ${result.pass ? 'PASS' : 'FAIL'} (${secrets.length} secrets, ${files} files, ${findings.length} findings)`);
  for (const f of findings) log(`  found ${f.secret} (${f.encoding}) in ${f.file}`);
  if (!result.pass) process.exit(3);
}

try {
  main();
} catch (err) {
  process.stderr.write(`secret scan: ${err.message}\n`);
  process.exit(1);
}
