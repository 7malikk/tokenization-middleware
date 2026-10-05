'use strict';
// Breach resilience (NFR3): one evidence item per compromise scenario.
//
//   node breach.js prepare    <dir>          tokenize a synthetic BVN as application A
//   (1. primary database alone: segregation.js on <dir>/1-primary-db)
//   node breach.js vault-db   <dir>          2. vault dump alone (<dir>/2-vault-db/vault-db.sql)
//   node breach.js key-file   <dir>          3. key file alone
//   node breach.js credential <dir>          4. a valid credential: another app's token, an INSPECT-only key
//   node breach.js rate-limit <dir> <limit>  4. a valid credential: exceeding the rate limit
//   node breach.js isolated   <dir>          5. vault copy + key file + KEK (restored into scratch-db)
//   node breach.js report     <dir>          breach-resilience.md
//
// state.json holds the token and the SHA-256 of the BVN, never the BVN.

const { randomBytes } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  NOT_FOUND_BODY,
  allPass,
  copyBytea,
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
  tableColumns,
  tokenizeSynthetic,
  unlockMasterKeys,
  unwraps,
  writeJson,
  writeText,
} = require('./lib');

/** Random key guesses per attempt type. They illustrate; the guarantee is the 2^256 key space. */
const GUESSES = 1000;

const randomToken = () => randomBytes(16).toString('hex');

async function latestAudit(db, where) {
  return db.auditLog.findFirst({ where, orderBy: { id: 'desc' } });
}

const scenarios = {
  async prepare(dir) {
    const { appA } = credentials();
    const client = middlewareClient();
    try {
      const { token, bvnSha256 } = await tokenizeSynthetic(client, appA.apiKey);
      writeJson(join(dir, 'state.json'), { token, bvnSha256, appId: appA.appId, at: new Date().toISOString() });
      log(`prepared: application A token ${token}`);
    } finally {
      client.close();
    }
  },

  /** 2. An attacker holding only a plain pg_dump of vault-db. */
  async 'vault-db'(dir) {
    const out = join(dir, '2-vault-db');
    const { token, bvnSha256 } = readJson(join(dir, 'state.json'));
    const dump = readFileSync(join(out, 'vault-db.sql'), 'utf8');
    const blocks = parseCopyBlocks(dump);
    const block = blocks.find((b) => b.table.endsWith('vault_record'));
    const row = block.rows.find((r) => r.fields[block.columns.indexOf('token')] === token);
    const field = (name) => row.fields[block.columns.indexOf(name)];
    const payload = { ciphertext: copyBytea(field('ciphertext')), iv: copyBytea(field('iv')), authTag: copyBytea(field('auth_tag')) };
    const wrapped = copyBytea(field('wrapped_data_key'));
    const found = findBvnHashes(dump, new Set([bvnSha256]));

    let dataKeyGuessesThatDecrypt = 0;
    let masterKeyGuessesThatUnwrap = 0;
    for (let i = 0; i < GUESSES; i++) {
      const guess = randomBytes(32);
      if (decrypts(payload, guess)) dataKeyGuessesThatDecrypt++;
      if (unwraps(wrapped, guess)) masterKeyGuessesThatUnwrap++;
    }
    // The wrapped key itself is not a usable data key.
    const wrappedAsKey = decrypts(payload, wrapped.subarray(0, 32));

    const columns = tableColumns(dump, block.table);
    const expectations = [
      expectation('this run\'s BVN in the dump (digits or hex of its bytes)', 0, found.decimal + found.hexEncoded),
      expectation('vault_record value columns are bytea', true, ['ciphertext', 'iv', 'auth_tag', 'wrapped_data_key'].every((c) => columns.find((x) => x.name === c)?.type.startsWith('bytea'))),
      expectation('the record\'s wrapped data key in the dump', '40 bytes', wrapped ? `${wrapped.length} bytes` : null),
      expectation(`random master key guesses that unwrap the data key (of ${GUESSES})`, 0, masterKeyGuessesThatUnwrap),
      expectation(`random data key guesses that decrypt (of ${GUESSES})`, 0, dataKeyGuessesThatDecrypt),
      expectation('the wrapped key bytes used directly as the data key decrypt', false, wrappedAsKey),
    ];
    writeJson(join(out, 'evidence.json'), {
      scenario: 'Vault database alone',
      dump: { file: '2-vault-db/vault-db.sql', sha256: sha256(dump) },
      tables: blocks.map((b) => ({ table: b.table, columns: b.columns, rows: b.rows.length })),
      vaultRecordColumns: columns,
      record: { token, line: row.line, ciphertextBytes: payload.ciphertext.length, ivBytes: payload.iv.length, authTagBytes: payload.authTag.length, wrappedDataKeyBytes: wrapped.length },
      expectations,
    });
    log(`2. vault dump alone: ${allPass(expectations) ? 'PASS' : 'FAIL'}`);
  },

  /** 3. An attacker holding only the master key file. */
  async 'key-file'(dir) {
    const out = join(dir, '3-key-file');
    const raw = readFileSync(env.MASTER_KEY_FILE);
    const file = keyFile.readKeyFile(env.MASTER_KEY_FILE);
    const attempt = (kek) => {
      try {
        keyFile.zeroizeAll(keyFile.unlockKeyFile(file, kek));
        return true;
      } catch {
        return false;
      }
    };
    let guessesThatUnwrap = 0;
    for (let i = 0; i < GUESSES; i++) if (attempt(randomBytes(32))) guessesThatUnwrap++;
    const zeroKekUnwraps = attempt(Buffer.alloc(32));

    // Verifier check, not available to the attacker: with the real KEK, the
    // master keys unwrap, and none of them appears in the file in the clear.
    const masterKeys = unlockMasterKeys();
    const text = raw.toString('latin1');
    let plaintextKeysInFile = 0;
    for (const key of masterKeys.values()) {
      if (text.includes(key.toString('hex')) || text.includes(key.toString('base64')) || raw.includes(key)) plaintextKeysInFile++;
      crypto.zeroize(key);
    }

    const expectations = [
      expectation(`random KEK guesses that unwrap the master key (of ${GUESSES})`, 0, guessesThatUnwrap),
      expectation('an all-zero KEK unwraps the master key', false, zeroKekUnwraps),
      expectation('master keys stored in the clear in the file (verifier check with the real KEK)', 0, plaintextKeysInFile),
    ];
    writeJson(join(out, 'evidence.json'), {
      scenario: 'Key file alone',
      keyFile: { sha256: sha256(raw), active: file.active, versions: file.keys.map((k) => ({ version: k.version, wrappedBytes: k.wrapped.length / 2 })) },
      expectations,
    });
    log(`3. key file alone: ${allPass(expectations) ? 'PASS' : 'FAIL'}`);
  },

  /** 4a. A valid credential: another application's token, and an INSPECT-only key. */
  async credential(dir) {
    const out = join(dir, '4-credential');
    const { token, bvnSha256 } = readJson(join(dir, 'state.json'));
    const { appA, appB, inspectOnly } = credentials();
    const client = middlewareClient();
    const db = database('VAULT');
    try {
      const unknown = await client.post('/v1/detokenize', { token: randomToken() }, appB.apiKey);
      const foreign = await client.post('/v1/detokenize', { token }, appB.apiKey);
      const foreignAudit = await latestAudit(db, { credentialId: appB.credentialId, token, operation: 'DETOKENIZE' });
      const foreignErase = await client.post('/v1/erase', { token }, appB.apiKey);
      const foreignEraseAudit = await latestAudit(db, { credentialId: appB.credentialId, token, operation: 'ERASE' });
      const owner = await client.post('/v1/detokenize', { token }, appA.apiKey);
      const inspect = await client.post('/v1/detokenize', { token }, inspectOnly.apiKey);
      const inspectAudit = await latestAudit(db, { credentialId: inspectOnly.credentialId, token, operation: 'DETOKENIZE' });

      const expectations = [
        expectation('application B detokenizes A\'s token: status', 404, foreign.status),
        expectation('... body identical to an unknown token\'s', unknown.text, foreign.text),
        expectation('... body', NOT_FOUND_BODY, foreign.text),
        expectation('... audit outcome', 'NOT_OWNER', foreignAudit?.outcome ?? null),
        expectation('application B erases A\'s token: status', 404, foreignErase.status),
        expectation('... audit outcome', 'NOT_OWNER', foreignEraseAudit?.outcome ?? null),
        expectation('A\'s record is untouched: A still detokenizes it (hash compared)', true, owner.status === 200 && sha256(owner.json?.value ?? '') === bvnSha256),
        expectation('INSPECT-only key detokenizes: status', 403, inspect.status),
        expectation('... audit outcome', 'FORBIDDEN_SCOPE', inspectAudit?.outcome ?? null),
      ];
      writeJson(join(out, 'owner-and-scope.json'), {
        scenario: 'Application with a valid credential: owner check and scope',
        token,
        requests: {
          unknownTokenAsB: { status: unknown.status, body: unknown.text },
          foreignTokenAsB: { status: foreign.status, body: foreign.text, auditRowId: foreignAudit?.id, auditOutcome: foreignAudit?.outcome },
          foreignEraseAsB: { status: foreignErase.status, body: foreignErase.text, auditRowId: foreignEraseAudit?.id, auditOutcome: foreignEraseAudit?.outcome },
          ownerDetokenize: { status: owner.status },
          inspectOnlyDetokenize: { status: inspect.status, body: inspect.text, auditRowId: inspectAudit?.id, auditOutcome: inspectAudit?.outcome },
        },
        expectations,
      });
      log(`4. owner check and scope: ${allPass(expectations) ? 'PASS' : 'FAIL'}`);
    } finally {
      client.close();
      await db.$disconnect();
    }
  },

  /** 4b. A valid credential exceeding the rate limit (run.sh sets RATE_LIMIT_PER_MINUTE=<limit>). */
  async 'rate-limit'(dir, limitArg) {
    const out = join(dir, '4-credential');
    const limit = Number(limitArg);
    const { appB } = credentials();
    const client = middlewareClient();
    const db = database('VAULT');
    try {
      // Fresh random tokens, so each request is an ordinary not-found until the limit.
      // A window boundary can fall inside the loop, so allow up to two windows.
      const statuses = [];
      let limited = null;
      let limitedToken = null;
      for (let i = 0; i < limit * 2 + 2 && !limited; i++) {
        const t = randomToken();
        const res = await client.post('/v1/detokenize', { token: t }, appB.apiKey);
        statuses.push(res.status);
        if (res.status === 429) {
          limited = res;
          limitedToken = t;
        }
      }
      const audit = limitedToken ? await latestAudit(db, { credentialId: appB.credentialId, token: limitedToken }) : null;
      const before = statuses.slice(0, -1);
      const expectations = [
        expectation('a request beyond the limit gets', 429, limited?.status ?? null),
        expectation('... with a Retry-After header', true, Boolean(limited?.headers['retry-after'])),
        expectation('... audit outcome', 'RATE_LIMITED', audit?.outcome ?? null),
        expectation('requests before it were served (404 for random tokens)', true, before.length > 0 && before.every((s) => s === 404)),
      ];
      writeJson(join(out, 'rate-limit.json'), {
        scenario: 'Application with a valid credential: rate limit',
        rateLimitPerMinute: limit,
        requestsSent: statuses.length,
        limitedAtRequest: limited ? statuses.length : null,
        response: limited && { status: limited.status, retryAfter: limited.headers['retry-after'], body: limited.text },
        auditRowId: audit?.id ?? null,
        auditOutcome: audit?.outcome ?? null,
        expectations,
      });
      log(`4. rate limit: 429 after ${statuses.length} requests (limit ${limit}): ${allPass(expectations) ? 'PASS' : 'FAIL'}`);
    } finally {
      client.close();
      await db.$disconnect();
    }
  },

  /** 5. Vault database, key file and KEK together, in an isolated copy (scratch-db). */
  async isolated(dir) {
    const out = join(dir, '5-all-three');
    const { token, bvnSha256 } = readJson(join(dir, 'state.json'));
    const db = database('SCRATCH');
    const masterKeys = unlockMasterKeys();
    try {
      const record = await db.vaultRecord.findUnique({ where: { token } });
      const dataKey = crypto.unwrapKey(Buffer.from(record.wrappedDataKey), masterKeys.get(record.masterKeyVersion));
      let matches;
      try {
        matches = decryptToHash(payloadOf(record), dataKey) === bvnSha256;
      } finally {
        crypto.zeroize(dataKey);
      }

      // Every live record in the copy, counted only.
      let live = 0;
      let decrypted = 0;
      let cursor;
      for (;;) {
        const batch = await db.vaultRecord.findMany({
          where: { wrappedDataKey: { not: null } },
          orderBy: { token: 'asc' },
          take: 1000,
          ...(cursor ? { cursor: { token: cursor }, skip: 1 } : {}),
        });
        if (batch.length === 0) break;
        for (const r of batch) {
          live++;
          try {
            const key = crypto.unwrapKey(Buffer.from(r.wrappedDataKey), masterKeys.get(r.masterKeyVersion));
            if (decrypts(payloadOf(r), key)) decrypted++;
            crypto.zeroize(key);
          } catch {
            // counted as not decrypted
          }
        }
        cursor = batch[batch.length - 1].token;
      }
      const erased = await db.vaultRecord.count({ where: { wrappedDataKey: null } });
      const expectations = [
        expectation('this run\'s record decrypts to its BVN (hash compared)', true, matches),
        expectation('live records in the copy that decrypt', live, decrypted),
      ];
      writeJson(join(out, 'evidence.json'), {
        scenario: 'Vault database, key file and KEK together (isolated copy)',
        copy: 'pg_dump of vault-db restored into scratch-db (in memory, internal network, removed afterwards)',
        liveRecords: live,
        decrypted,
        erasedRecordsNotDecryptable: erased,
        expectations,
      });
      log(`5. all three together: ${decrypted}/${live} live records decrypt`);
    } finally {
      for (const key of masterKeys.values()) crypto.zeroize(key);
      await db.$disconnect();
    }
  },

  async report(dir) {
    const load = (p) => (existsSync(join(dir, p)) ? readJson(join(dir, p)) : null);
    const seg = load('1-primary-db/segregation.json');
    const vault = load('2-vault-db/evidence.json');
    const keyfile = load('3-key-file/evidence.json');
    const owner = load('4-credential/owner-and-scope.json');
    const rate = load('4-credential/rate-limit.json');
    const all3 = load('5-all-three/evidence.json');
    const ok = (e) => (e && allPass(e.expectations) ? 'PASS' : 'FAIL');
    const credentialOk = owner && rate && allPass([...owner.expectations, ...rate.expectations]) ? 'PASS' : 'FAIL';

    const rows = [
      ['Primary database alone', `\`1-primary-db/\`: segregation run (${seg?.n} customers): BVNs found ${seg ? seg.bvnsFound.decimal + seg.bvnsFound.hexEncoded : '?'}, unexplained 11-digit sequences ${seg?.elevenDigitSequences.unexplained.length}, tokens found ${seg?.tokensFound}/${seg?.customersCreated}`, ok(seg)],
      ['Vault database alone', `\`2-vault-db/\`: the dump holds only bytea ciphertext, IVs, tags and wrapped keys; ${GUESSES} master key and ${GUESSES} data key guesses all fail`, ok(vault)],
      ['Key file alone', `\`3-key-file/\`: ${GUESSES} random KEKs and an all-zero KEK fail the AES-KW integrity check; no master key in the clear`, ok(keyfile)],
      ['Application with a valid credential', `\`4-credential/\`: another app's token 404 (audited ${owner?.requests.foreignTokenAsB.auditOutcome}); over the limit 429 (audited ${rate?.auditOutcome}); INSPECT-only key 403 (audited ${owner?.requests.inspectOnlyDetokenize.auditOutcome})`, credentialOk],
      ['Vault database, key file and KEK together', `\`5-all-three/\`: in an isolated copy, ${all3?.decrypted}/${all3?.liveRecords} live records decrypt. The stated limit of the design`, all3 && allPass(all3.expectations) ? 'LIMIT SHOWN' : 'FAIL'],
      ['Middleware process or host', 'Analytical only (below)', 'n/a'],
    ];
    const pass = [seg, vault, keyfile, all3].every((e) => e && allPass(e.expectations)) && credentialOk === 'PASS';

    const section = (title, e) => (e ? [`### ${title}`, '', expectationsTable(e.expectations), ''] : [`### ${title}`, '', 'Evidence missing.', '']);
    const md = [
      '# Breach resilience (NFR3)',
      '',
      'One evidence item per compromise scenario. Synthetic BVNs only; BVNs are compared by SHA-256 and never written here.',
      '',
      mdTable(['Scenario', 'Evidence', 'Result'], rows),
      '',
      '## Evidence',
      '',
      ...section('1. Primary database alone', seg),
      ...section('2. Vault database alone', vault),
      ...(vault ? ['Columns of `vault_record` in the dump:', '', mdTable(['Column', 'Type'], vault.vaultRecordColumns.map((c) => [c.name, c.type])), ''] : []),
      ...section('3. Key file alone', keyfile),
      ...section('4. Application with a valid credential: owner check and scope', owner),
      ...section(`4. Application with a valid credential: rate limit (RATE_LIMIT_PER_MINUTE=${rate?.rateLimitPerMinute}, 429 at request ${rate?.limitedAtRequest})`, rate),
      ...section('5. Vault database, key file and KEK together', all3),
      'With all three, an attacker can do what the middleware does: unwrap the master key with the KEK, unwrap',
      'each data key, and decrypt every live record. Erased records stay undecryptable because their wrapped',
      `keys are gone (${all3?.erasedRecordsNotDecryptable ?? '?'} in this copy). This is the stated limit: the design separates the`,
      'three so that no single compromise reveals identifiers, not so that all three together cannot.',
      '',
      '### 6. Middleware process or host (analytical)',
      '',
      'Not tested. Whoever controls the running middleware process or its host can read the unwrapped master',
      'keys from process memory, and the KEK file on disk (the Compose secret `secrets/master-kek`, mounted',
      'into the container), together with the key file and database credentials. That is equivalent to',
      'scenario 5 and is the boundary already stated in the thesis: the design protects identifiers against',
      'compromise of any single store, not against compromise of the host that runs the middleware.',
      '',
      `**Result: ${pass ? 'PASS' : 'FAIL'}**`,
    ].join('\n');
    writeText(join(dir, 'breach-resilience.md'), md);
    writeJson(join(dir, 'breach-resilience.json'), { part: 'breach resilience (NFR3)', scenarios: rows.map(([s, , r]) => ({ scenario: s, result: r })), pass });
    log(`breach resilience: ${pass ? 'PASS' : 'FAIL'}`);
    if (!pass) process.exit(3);
  },
};

const [command, dir, arg] = process.argv.slice(2);
if (!Object.hasOwn(scenarios, command) || !dir) {
  process.stderr.write(`usage: breach.js <${Object.keys(scenarios).join('|')}> <dir> [limit]\n`);
  process.exit(2);
}
scenarios[command](dir, arg).catch((err) => {
  process.stderr.write(`breach ${command}: ${err.message}\n`);
  process.exit(1);
});
