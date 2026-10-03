#!/usr/bin/env node
// Generate a self-signed TLS certificate and key for local development.
// Usage: node scripts/dev-certs.js [outDir]   (default: certs/, gitignored)
// Needs the openssl command-line tool.

const { execFileSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');

const outDir = resolve(process.argv[2] ?? 'certs');
mkdirSync(outDir, { recursive: true });
const certPath = join(outDir, 'dev-cert.pem');
const keyPath = join(outDir, 'dev-key.pem');

execFileSync(
  'openssl',
  [
    'req', '-x509', '-nodes', '-days', '365',
    '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-keyout', keyPath, '-out', certPath,
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ],
  { stdio: 'pipe' },
);

process.stdout.write(`TLS_CERT_PATH=${certPath}\nTLS_KEY_PATH=${keyPath}\n`);
