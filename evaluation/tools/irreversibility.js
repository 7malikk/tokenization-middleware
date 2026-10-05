'use strict';
// Irreversibility (NFR6). One subcommand per step; run.sh takes the pg_dump
// backups and restores between them. Evidence goes to <dir>/<step>-*.json.
//
//   node irreversibility.js tokenize       <dir>   1. tokenize a synthetic BVN, record the token
//   (run.sh)                                       2. pg_dump backup of vault-db
//   node irreversibility.js erase          <dir>   3. erase through /v1/erase
//   node irreversibility.js tombstone      <dir>   4. the row remains: wrappedDataKey null, erasedAt set
//   node irreversibility.js recover-live   <dir>   5. recovery attempts with everything in the live system
//   (run.sh restores the step-2 backup into scratch-db)
//   node irreversibility.js recover-backup <dir>   6. the stated limit: the old backup still decrypts
//   node irreversibility.js report         <dir>   irreversibility.md
//
// state.json holds the token and the SHA-256 of the BVN, never the BVN.

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  NOT_FOUND_BODY,
  allPass,
  credentials,
  crypto,
  database,
  decryptToHash,
  decrypts,
  expectation,
  expectationsTable,
  log,
  mdTable,
  middlewareClient,
  parseCopyBlocks,
  payloadOf,
  readJson,
  sha256,
  tokenizeSynthetic,
  unlockMasterKeys,
  writeJson,
  writeText,
} = require('./lib');

const BACKUP = '2-vault-backup-pre-erase.dump';
const POST_ERASE_DUMP = '4-vault-post-erase.sql';

const recordSummary = (r) =>
  r && {
    token: r.token,
    dataType: r.dataType,
    ciphertextBytes: r.ciphertext.length,
    ivBytes: r.iv.length,
    authTagBytes: r.authTag.length,
    wrappedDataKey: r.wrappedDataKey ? `${r.wrappedDataKey.length} bytes` : null,
    masterKeyVersion: r.masterKeyVersion,
    createdAt: r.createdAt,
    erasedAt: r.erasedAt,
  };

const steps = {
  async tokenize(dir) {
    const { appA } = credentials();
    const client = middlewareClient();
    try {
      const { token, bvnSha256 } = await tokenizeSynthetic(client, appA.apiKey);
      const detok = await client.post('/v1/detokenize', { token }, appA.apiKey);
      const roundTrip = detok.status === 200 && sha256(detok.json?.value ?? '') === bvnSha256;
      writeJson(join(dir, 'state.json'), { token, bvnSha256, appId: appA.appId, credentialId: appA.credentialId });
      const expectations = [
        expectation('tokenize status', 201, 201),
        expectation('detokenize before erasure returns the same BVN', true, roundTrip),
      ];
      writeJson(join(dir, '1-tokenize.json'), {
        step: 1,
        what: 'Tokenize a synthetic BVN with the evaluation credential (application A)',
        at: new Date().toISOString(),
        token,
        bvnSha256,
        expectations,
      });
      log(`1. tokenized: ${token}`);
    } finally {
      client.close();
    }
  },

  async erase(dir) {
    const { token } = readJson(join(dir, 'state.json'));
    const { appA } = credentials();
    const backup = readFileSync(join(dir, BACKUP));
    const client = middlewareClient();
    try {
      const res = await client.post('/v1/erase', { token }, appA.apiKey);
      const expectations = [
        expectation('pre-erase backup taken before erasure', true, backup.length > 0),
        expectation('erase status', 200, res.status),
        expectation('erase body', '{"erased":true}', res.text),
      ];
      writeJson(join(dir, '2-backup.json'), {
        step: 2,
        what: 'pg_dump (custom format) of vault-db, taken before erasure',
        file: BACKUP,
        bytes: backup.length,
        sha256: sha256(backup),
        takenBefore: new Date().toISOString(),
      });
      writeJson(join(dir, '3-erase.json'), { step: 3, what: 'POST /v1/erase', at: new Date().toISOString(), token, status: res.status, body: res.text, expectations });
      log(`3. erase: ${res.status}`);
    } finally {
      client.close();
    }
  },

  async tombstone(dir) {
    const { token } = readJson(join(dir, 'state.json'));
    const db = database('VAULT');
    try {
      const record = await db.vaultRecord.findUnique({ where: { token } });
      // The same row as pg_dump shows it.
      const dump = readFileSync(join(dir, POST_ERASE_DUMP), 'utf8');
      const block = parseCopyBlocks(dump).find((b) => b.table.endsWith('vault_record'));
      const row = block?.rows.find((r) => r.fields[block.columns.indexOf('token')] === token);
      const dumpRow = row && Object.fromEntries(block.columns.map((c, i) => [c, abbreviate(row.fields[i])]));
      const expectations = [
        expectation('row still exists (Prisma)', true, Boolean(record)),
        expectation('wrappedDataKey (Prisma)', null, record?.wrappedDataKey ?? null),
        expectation('erasedAt is set (Prisma)', true, Boolean(record?.erasedAt)),
        expectation('ciphertext, iv and auth tag kept', true, Boolean(record && record.ciphertext.length > 0 && record.iv.length === 12 && record.authTag.length === 16)),
        expectation('row present in pg_dump output', true, Boolean(row)),
        expectation('wrapped_data_key in pg_dump output', '\\N (null)', row ? (dumpRow.wrapped_data_key === '\\N' ? '\\N (null)' : 'present') : 'row missing'),
      ];
      writeJson(join(dir, '4-tombstone.json'), {
        step: 4,
        what: 'The tombstone: the row remains with its ciphertext, but without its wrapped data key',
        record: recordSummary(record),
        pgDump: { file: POST_ERASE_DUMP, line: row?.line ?? null, row: dumpRow ?? null },
        expectations,
      });
      log(`4. tombstone: wrappedDataKey ${record?.wrappedDataKey === null ? 'null' : 'present'}, erasedAt ${record?.erasedAt?.toISOString()}`);
    } finally {
      await db.$disconnect();
    }
  },

  async 'recover-live'(dir) {
    const { token, credentialId } = readJson(join(dir, 'state.json'));
    const { appA } = credentials();
    const db = database('VAULT');
    const client = middlewareClient();
    const masterKeys = unlockMasterKeys();
    try {
      // a. The API, with a valid credential that owns the token.
      const detok = await client.post('/v1/detokenize', { token }, appA.apiKey);
      const audit = await db.auditLog.findFirst({
        where: { credentialId, token, operation: 'DETOKENIZE' },
        orderBy: { id: 'desc' },
      });

      // b. The ciphertext left in the row, against every key the live system holds.
      const erased = await db.vaultRecord.findUnique({ where: { token } });
      const payload = payloadOf(erased);
      const masterKeyAttempts = [...masterKeys.entries()].map(([version, key]) => ({ version, decrypted: decrypts(payload, key) }));

      let dataKeysTried = 0;
      let dataKeysThatDecrypted = 0;
      let unwrapFailures = 0;
      let cursor;
      for (;;) {
        const batch = await db.vaultRecord.findMany({
          where: { wrappedDataKey: { not: null }, token: { not: token } },
          select: { token: true, wrappedDataKey: true, masterKeyVersion: true },
          orderBy: { token: 'asc' },
          take: 1000,
          ...(cursor ? { cursor: { token: cursor }, skip: 1 } : {}),
        });
        if (batch.length === 0) break;
        for (const r of batch) {
          const master = masterKeys.get(r.masterKeyVersion);
          let dataKey;
          try {
            dataKey = crypto.unwrapKey(Buffer.from(r.wrappedDataKey), master);
          } catch {
            unwrapFailures++;
            continue;
          }
          dataKeysTried++;
          if (decrypts(payload, dataKey)) dataKeysThatDecrypted++;
          crypto.zeroize(dataKey);
        }
        cursor = batch[batch.length - 1].token;
      }

      const expectations = [
        expectation('detokenize status (valid, owning credential)', 404, detok.status),
        expectation('detokenize body is the generic not-found body', NOT_FOUND_BODY, detok.text),
        expectation('audit outcome for that request', 'ERASED', audit?.outcome ?? null),
        expectation('master key versions that decrypt the ciphertext', 0, masterKeyAttempts.filter((a) => a.decrypted).length),
        expectation('other live data keys that decrypt the ciphertext', 0, dataKeysThatDecrypted),
        expectation('live data keys tried', '> 0', dataKeysTried, dataKeysTried > 0),
      ];
      writeJson(join(dir, '5-recover-live.json'), {
        step: 5,
        what: 'Recovery with everything left in the live system',
        detokenize: { status: detok.status, body: detok.text, auditOutcome: audit?.outcome ?? null, auditRowId: audit?.id ?? null },
        decryptionAttempts: {
          note: 'AES-256-GCM with the stored IV and auth tag; every attempt must fail authentication',
          masterKeysAsDataKey: masterKeyAttempts,
          liveDataKeys: { tried: dataKeysTried, decrypted: dataKeysThatDecrypted, wrappedKeysThatFailedToUnwrap: unwrapFailures },
        },
        expectations,
      });
      log(`5. live recovery: detokenize ${detok.status} (${audit?.outcome}), ${masterKeyAttempts.length} master key(s) and ${dataKeysTried} data keys tried, ${dataKeysThatDecrypted} decrypted`);
    } finally {
      for (const key of masterKeys.values()) crypto.zeroize(key);
      client.close();
      await db.$disconnect();
    }
  },

  async 'recover-backup'(dir) {
    const { token, bvnSha256 } = readJson(join(dir, 'state.json'));
    const db = database('SCRATCH');
    const masterKeys = unlockMasterKeys();
    try {
      const record = await db.vaultRecord.findUnique({ where: { token } });
      let decryptedMatches = false;
      if (record?.wrappedDataKey) {
        const dataKey = crypto.unwrapKey(Buffer.from(record.wrappedDataKey), masterKeys.get(record.masterKeyVersion));
        try {
          decryptedMatches = decryptToHash(payloadOf(record), dataKey) === bvnSha256;
        } finally {
          crypto.zeroize(dataKey);
        }
      }
      const expectations = [
        expectation('record present in the restored backup', true, Boolean(record)),
        expectation('wrappedDataKey in the backup', '40 bytes', record?.wrappedDataKey ? `${record.wrappedDataKey.length} bytes` : null),
        expectation('erasedAt in the backup', null, record?.erasedAt ?? null),
        expectation('backup + master key decrypt to the original BVN (hash compared)', true, decryptedMatches),
      ];
      writeJson(join(dir, '6-recover-backup.json'), {
        step: 6,
        what: 'The stated limit: the pre-erase backup, restored into a throwaway database (scratch-db), still holds the wrapped key and decrypts with the live master key',
        backup: BACKUP,
        record: recordSummary(record),
        expectations,
        boundary: 'Erasure is irreversible in the live vault only. A backup taken before erasure still contains the wrapped data key; backups must be rotated or expired under the retention policy for erasure to reach them.',
      });
      log(`6. backup: wrapped key ${record?.wrappedDataKey ? 'present' : 'absent'}, decrypts to the original: ${decryptedMatches}`);
    } finally {
      for (const key of masterKeys.values()) crypto.zeroize(key);
      await db.$disconnect();
    }
  },

  async report(dir) {
    const files = ['1-tokenize', '3-erase', '4-tombstone', '5-recover-live', '6-recover-backup'];
    const ev = Object.fromEntries(files.map((f) => [f, readJson(join(dir, `${f}.json`))]));
    const backup = readJson(join(dir, '2-backup.json'));
    const liveOk = ['1-tokenize', '3-erase', '4-tombstone', '5-recover-live'].every((f) => allPass(ev[f].expectations));
    const limitShown = allPass(ev['6-recover-backup'].expectations);
    const t = ev['4-tombstone'];
    const r = ev['5-recover-live'];
    const md = [
      '# Irreversibility (NFR6)',
      '',
      `Token under test: \`${ev['1-tokenize'].token}\` (application A). The BVN is synthetic and is recorded only as its SHA-256.`,
      '',
      '## 1. Tokenize',
      '',
      expectationsTable(ev['1-tokenize'].expectations),
      '',
      '## 2. Backup before erasure',
      '',
      `\`${backup.file}\`: pg_dump custom format, ${backup.bytes} bytes, SHA-256 \`${backup.sha256}\`.`,
      '',
      '## 3. Erase',
      '',
      expectationsTable(ev['3-erase'].expectations),
      '',
      '## 4. Tombstone',
      '',
      'The row is kept, with its ciphertext, IV and auth tag, but its wrapped data key is gone.',
      '',
      mdTable(['Field', 'Value'], Object.entries(t.record ?? {})),
      '',
      `The same row in \`${t.pgDump.file}\` (line ${t.pgDump.line}), long values shortened:`,
      '',
      mdTable(['Column', 'Value'], Object.entries(t.pgDump.row ?? {})),
      '',
      expectationsTable(t.expectations),
      '',
      '## 5. Recovery with everything in the live system',
      '',
      `Detokenize with the owning credential: ${r.detokenize.status}, audited as \`${r.detokenize.auditOutcome}\`.`,
      `The remaining ciphertext was tried against ${r.decryptionAttempts.masterKeysAsDataKey.length} master key version(s) and`,
      `${r.decryptionAttempts.liveDataKeys.tried} live data keys (every other record's wrapped key, unwrapped with the master key).`,
      '',
      expectationsTable(r.expectations),
      '',
      '## 6. The stated limit: an old backup',
      '',
      'The pre-erase backup was restored into a throwaway database (`scratch-db`, in memory, removed afterwards).',
      '',
      expectationsTable(ev['6-recover-backup'].expectations),
      '',
      ev['6-recover-backup'].boundary,
      '',
      `**Result: ${liveOk && limitShown ? 'PASS' : 'FAIL'}** (live vault irreversible: ${liveOk ? 'yes' : 'NO'}; backup boundary demonstrated: ${limitShown ? 'yes' : 'NO'})`,
    ].join('\n');
    writeText(join(dir, 'irreversibility.md'), md);
    writeJson(join(dir, 'irreversibility.json'), { part: 'irreversibility (NFR6)', liveVaultIrreversible: liveOk, backupBoundaryShown: limitShown, pass: liveOk && limitShown });
    log(`irreversibility: ${liveOk && limitShown ? 'PASS' : 'FAIL'}`);
    if (!(liveOk && limitShown)) process.exit(3);
  },
};

/** Long hex values shortened for display. */
function abbreviate(field) {
  return field.length > 40 ? `${field.slice(0, 24)}... (${field.length} chars)` : field;
}

const [command, dir] = process.argv.slice(2);
if (!Object.hasOwn(steps, command) || !dir) {
  process.stderr.write(`usage: irreversibility.js <${Object.keys(steps).join('|')}> <dir>\n`);
  process.exit(2);
}
steps[command](dir).catch((err) => {
  process.stderr.write(`irreversibility ${command}: ${err.message}\n`);
  process.exit(1);
});
