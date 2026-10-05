'use strict';
// Segregation (NFR2). Two steps around a pg_dump of reference-db taken by run.sh:
//
//   node segregation.js create  <dir> <n>   create n customers through the treatment
//                                           route (POST /customers); keep the BVNs
//   node segregation.js analyze <dir>       search <dir>/reference-db.sql for every
//                                           BVN, any 11-digit sequence, and the tokens
//
// bvns.json holds the synthetic BVNs, as the method requires. Nothing is printed.

const { readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');
const {
  allPass,
  appPost,
  countPresent,
  expectation,
  expectationsTable,
  log,
  mdTable,
  parseCopyBlocks,
  readJson,
  sha256,
  syntheticBvn,
  writeJson,
  writeText,
} = require('./lib');

const CONCURRENCY = 8;

async function create(dir, n) {
  const bvns = new Set();
  while (bvns.size < n) bvns.add(syntheticBvn());
  const list = [...bvns];
  const customers = new Array(n);
  const failures = [];
  const startedAt = new Date().toISOString();
  let next = 0;
  const worker = async () => {
    while (next < n) {
      const i = next++;
      const res = await appPost('/customers', { fullName: `Evaluation Customer ${i + 1}`, bvn: list[i] });
      if (res.status === 201 && /^[0-9a-f]{32}$/.test(res.json?.bvnToken ?? '')) {
        customers[i] = { id: res.json.id, token: res.json.bvnToken };
      } else {
        failures.push({ index: i, status: res.status });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const created = customers.filter(Boolean);
  writeJson(join(dir, 'bvns.json'), {
    note: 'Synthetic BVNs (random 11-digit strings) sent through POST /customers. Not real data.',
    count: list.length,
    bvns: list,
  });
  writeJson(join(dir, 'customers.json'), created);
  writeJson(join(dir, 'create.json'), {
    route: 'POST /customers (treatment: tokenize, then store the token)',
    requested: n,
    created: created.length,
    failures,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
  log(`created ${created.length} of ${n} customers`);
  if (failures.length > 0) process.exit(1);
}

const TOKEN = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORD_CHAR = /[0-9A-Za-z_-]/;

/**
 * Every run of 11 or more digits in the dump, explained by where it sits. A
 * sequence standing alone in a data field would be a BVN-shaped value and is
 * reported as unexplained, by location only (never its value).
 */
function classifyDigitRuns(dump, blocks) {
  const fieldOf = new Map(); // line number -> { table, columns, fields }
  for (const b of blocks) for (const r of b.rows) fieldOf.set(r.line, { table: b.table, columns: b.columns, fields: r.fields });

  const counts = {};
  const unexplained = [];
  const lines = dump.split('\n');
  lines.forEach((line, index) => {
    for (const m of line.matchAll(/[0-9]{11,}/g)) {
      let start = m.index;
      let end = m.index + m[0].length;
      while (start > 0 && WORD_CHAR.test(line[start - 1])) start--;
      while (end < line.length && WORD_CHAR.test(line[end])) end++;
      const word = line.slice(start, end);
      const row = fieldOf.get(index + 1);
      const column = row ? row.columns[line.slice(0, m.index).split('\t').length - 1] : null;
      const table = row?.table ?? null;

      let kind;
      if (TOKEN.test(word)) kind = 'inside a 32-hex token';
      else if (UUID.test(word)) kind = 'inside a UUID';
      else if (table?.endsWith('_prisma_migrations')) kind = `Prisma migration bookkeeping (${column})`;
      else if (!row && /^\\(un)?restrict /.test(line)) kind = 'pg_dump session key (\\restrict line)';
      else kind = null;

      if (kind) counts[kind] = (counts[kind] ?? 0) + 1;
      else unexplained.push({ line: index + 1, table, column, standalone: word === m[0] });
    }
  });
  const total = Object.values(counts).reduce((a, b) => a + b, 0) + unexplained.length;
  return { total, explained: counts, unexplained };
}

function analyze(dir) {
  const dumpPath = join(dir, 'reference-db.sql');
  const dump = readFileSync(dumpPath, 'utf8');
  const { bvns } = readJson(join(dir, 'bvns.json'));
  const customers = readJson(join(dir, 'customers.json'));
  const tokens = customers.map((c) => c.token);
  const blocks = parseCopyBlocks(dump);

  const bvnHex = bvns.map((b) => Buffer.from(b, 'utf8').toString('hex'));
  const found = { decimal: countPresent(dump, bvns), hexEncoded: countPresent(dump, bvnHex) };
  const digits = classifyDigitRuns(dump, blocks);
  const tokensFound = countPresent(dump, tokens);

  const expectations = [
    expectation('BVNs found in the dump (as digits)', 0, found.decimal),
    expectation('BVNs found in the dump (hex of their bytes)', 0, found.hexEncoded),
    expectation('Unexplained 11-digit sequences', 0, digits.unexplained.length),
    expectation('Tokens of the created customers found', tokens.length, tokensFound),
  ];
  const result = {
    part: 'segregation (NFR2)',
    n: bvns.length,
    customersCreated: customers.length,
    dump: { file: 'reference-db.sql', bytes: statSync(dumpPath).size, sha256: sha256(dump) },
    tables: blocks.map((b) => ({ table: b.table, columns: b.columns, rows: b.rows.length })),
    bvnsFound: found,
    elevenDigitSequences: digits,
    tokensFound,
    expectations,
    pass: allPass(expectations),
  };
  writeJson(join(dir, 'segregation.json'), result);

  const md = [
    '# Segregation (NFR2)',
    '',
    `${customers.length} customers were created through the treatment route (\`POST /customers\`), each with a`,
    'fresh synthetic BVN (kept in `bvns.json`). `reference-db` was then dumped with `pg_dump`',
    `(\`reference-db.sql\`, ${result.dump.bytes} bytes, SHA-256 \`${result.dump.sha256}\`) and searched.`,
    '',
    expectationsTable(expectations),
    '',
    '## Tables in the dump',
    '',
    mdTable(['Table', 'Columns', 'Rows'], result.tables.map((t) => [t.table, t.columns.join(', '), t.rows])),
    '',
    '## 11-digit sequences',
    '',
    `${digits.total} runs of 11 or more digits occur in the dump. Each is explained by where it sits:`,
    '',
    mdTable(
      ['Where', 'Count'],
      [
        ...Object.entries(digits.explained).map(([k, v]) => [k, v]),
        ['unexplained (would be a BVN-shaped value)', digits.unexplained.length],
      ],
    ),
    '',
    'Tokens are 32 random hex characters, so some contain 11 or more decimal digits in a row by',
    'chance (about 5% of tokens). Those runs are part of a token, not a stored identifier.',
    ...(digits.unexplained.length > 0
      ? ['', 'Unexplained sequences, by location only:', '', mdTable(['Line', 'Table', 'Column', 'Standalone'], digits.unexplained.map((u) => [u.line, u.table, u.column, u.standalone]))]
      : []),
    '',
    `**Result: ${result.pass ? 'PASS' : 'FAIL'}**`,
  ].join('\n');
  writeText(join(dir, 'segregation.md'), md);
  log(`segregation: ${result.pass ? 'PASS' : 'FAIL'} (BVNs found ${found.decimal}/${found.hexEncoded}, unexplained 11-digit ${digits.unexplained.length}, tokens ${tokensFound}/${tokens.length})`);
  if (!result.pass) process.exit(3);
}

const [command, dir, n] = process.argv.slice(2);
const run = command === 'create' ? () => create(dir, Number(n)) : command === 'analyze' ? async () => analyze(dir) : null;
if (!run || !dir) {
  process.stderr.write('usage: segregation.js create <dir> <n> | analyze <dir>\n');
  process.exit(2);
}
run().catch((err) => {
  process.stderr.write(`segregation: ${err.message}\n`);
  process.exit(1);
});
