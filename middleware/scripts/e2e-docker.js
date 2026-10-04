#!/usr/bin/env node
// End-to-end test of the Docker deployment, on a clean, isolated stack.
//
// Uses its own Compose project, secrets and key directories and free host
// ports, so it never touches a stack you already run. Always tears down.
//
//   npm run e2e:docker

const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { randomInt } = require('node:crypto');

const ROOT = resolve(__dirname, '../..');
const PROJECT = 'tokenization-e2e';
// The system temp dir is shared with the Docker VM by default on every engine
// (Docker Desktop cannot mount from protected folders such as ~/Documents).
const workDir = mkdtempSync(join(tmpdir(), 'tokenization-e2e-'));
const env = {
  ...process.env,
  SECRETS_DIR: join(workDir, 'secrets'),
  KEYS_DIR: join(workDir, 'keys'),
};

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
  console.log(results.at(-1));
}
function skip(name, reason) {
  results.push(`SKIP  ${name}  (${reason})`);
  console.log(results.at(-1));
}

// OrbStack does not isolate bridge networks from each other, so the by-IP
// segregation check cannot pass there. Every other engine must enforce it.
function isOrbStack() {
  const res = spawnSync('docker', ['info', '--format', '{{.OperatingSystem}}'], { encoding: 'utf8' });
  return res.status === 0 && res.stdout.trim() === 'OrbStack';
}

function compose(args, { allowFail = false, quiet = true } = {}) {
  const res = spawnSync('docker', ['compose', '-p', PROJECT, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: quiet ? 'pipe' : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0 && !allowFail) {
    throw new Error(`docker compose ${args.join(' ')} failed (${res.status})\n${res.stderr ?? ''}`);
  }
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function freePort() {
  return new Promise((done) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

function syntheticBvn() {
  return Array.from({ length: 11 }, () => randomInt(10)).join('');
}

/** Node one-liner run inside a container: exit 0 if host:port accepts a TCP connection within 3s. */
function tcpProbe(host, port) {
  return (
    `const s=require('net').connect(${port},'${host}');` +
    `const t=setTimeout(()=>{console.log('timeout');process.exit(1)},3000);` +
    `s.on('connect',()=>{clearTimeout(t);console.log('connected');process.exit(0)});` +
    `s.on('error',e=>{clearTimeout(t);console.log(e.code);process.exit(1)});`
  );
}

function canConnect(service, host, port) {
  const res = compose(['exec', '-T', service, 'node', '-e', tcpProbe(host, port)], { allowFail: true });
  return { ok: res.code === 0, how: res.out.trim().split('\n').at(-1) };
}

async function waitForReferenceApp(base) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/customers/00000000-0000-4000-8000-000000000000`);
      if (res.status === 404) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('reference app did not become ready');
}

async function main() {
  env.MIDDLEWARE_PORT = String(await freePort());
  env.REFERENCE_PORT = String(await freePort());
  const base = `http://127.0.0.1:${env.REFERENCE_PORT}`;

  console.log(`e2e: project ${PROJECT}, work dir ${workDir}`);
  compose(['--profile', 'setup', 'down', '-v', '--remove-orphans'], { allowFail: true });

  console.log('e2e: building images');
  compose(['--profile', 'setup', 'build'], { quiet: false });

  console.log('e2e: setup');
  const setupSecrets = compose(['run', '--rm', 'setup']);
  check('setup step 1 (secrets) completes', /Step 1 complete/.test(setupSecrets.out));
  const setupVault = compose(['run', '--rm', 'setup-vault']);
  check('setup step 2 (reference credential) completes', /Setup complete/.test(setupVault.out));
  const setup = { out: setupSecrets.out + setupVault.out };

  console.log('e2e: starting the stack');
  compose(['up', '-d']);
  await waitForReferenceApp(base);

  // Flow through the reference app.
  const bvn = syntheticBvn();
  const createRes = await fetch(`${base}/customers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fullName: 'E2E Customer', bvn }),
  });
  const createText = await createRes.text();
  check('create customer returns 201', createRes.status === 201, `status ${createRes.status}`);
  check('create response holds no BVN', !createText.includes(bvn));
  const customer = JSON.parse(createText);
  check('customer has a 32-hex token', /^[0-9a-f]{32}$/.test(customer.bvnToken ?? ''));

  const readRes = await fetch(`${base}/customers/${customer.id}`);
  const readText = await readRes.text();
  check('read back returns the token only', readRes.status === 200 && !readText.includes(bvn) && !('bvn' in JSON.parse(readText)));

  const reveal = await fetch(`${base}/customers/${customer.id}/reveal-bvn`, { method: 'POST' });
  const revealBody = await reveal.json();
  check('reveal returns the original BVN once', reveal.status === 200 && revealBody.bvn === bvn);

  const erase = await fetch(`${base}/customers/${customer.id}/erase`, { method: 'POST' });
  check('erase succeeds', erase.status === 200);

  const revealAfter = await fetch(`${base}/customers/${customer.id}/reveal-bvn`, { method: 'POST' });
  const revealAfterText = await revealAfter.text();
  check('reveal fails after erase', revealAfter.status === 404 && !revealAfterText.includes(bvn), `status ${revealAfter.status}`);

  // Network segregation, with positive controls so the negative checks mean something.
  const vaultDbId = compose(['ps', '-q', 'vault-db']).out.trim();
  const vaultDbIps = execFileSync('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', vaultDbId], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const byName = canConnect('reference-app', 'vault-db', 5432);
  check('reference-app cannot reach vault-db by name', !byName.ok, byName.how);
  const orbStack = isOrbStack();
  for (const ip of vaultDbIps) {
    const name = `reference-app cannot reach vault-db by IP ${ip}`;
    if (orbStack) {
      skip(name, 'OrbStack does not enforce network isolation; verified on Docker Engine');
      continue;
    }
    const byIp = canConnect('reference-app', ip, 5432);
    check(name, !byIp.ok, byIp.how);
  }
  check('control: middleware can reach vault-db', canConnect('middleware', 'vault-db', 5432).ok);
  check('control: reference-app can reach reference-db', canConnect('reference-app', 'reference-db', 5432).ok);
  check('control: reference-app can reach middleware', canConnect('reference-app', 'middleware', 3000).ok);

  // Generated database passwords: the right one works, the old default is refused.
  const dbProbe = (urlExpr) =>
    "const {PrismaClient}=require('@prisma/client');" +
    "const {resolveDatabaseUrl}=require('./dist/config/database-url');" +
    `const db=new PrismaClient({datasourceUrl:${urlExpr}});` +
    "db.$connect().then(()=>{console.log('accepted');process.exit(0)}," +
    "e=>{console.log(e.errorCode||e.code||'error');process.exit(1)})";
  for (const [service, db, oldDefault] of [
    ['middleware', 'vault-db', 'postgresql://vault:vault@vault-db:5432/vault'],
    ['reference-app', 'reference-db', 'postgresql://reference:reference@reference-db:5432/reference'],
  ]) {
    const generated = compose(['exec', '-T', service, 'node', '-e', dbProbe('resolveDatabaseUrl(process.env)')], { allowFail: true });
    check(`control: ${db} accepts the generated password`, generated.code === 0, generated.out.trim().split('\n').at(-1));
    const old = compose(['exec', '-T', service, 'node', '-e', dbProbe(JSON.stringify(oldDefault))], { allowFail: true });
    const how = old.out.trim().split('\n').at(-1);
    check(`${db} rejects the old default password`, old.code !== 0 && how === 'P1000', how);
  }

  // Non-root.
  const uid = compose(['exec', '-T', 'middleware', 'id', '-u']).out.trim();
  check('middleware runs as non-root', uid !== '' && uid !== '0', `uid ${uid}`);
  const refUid = compose(['exec', '-T', 'reference-app', 'id', '-u']).out.trim();
  check('reference-app runs as non-root', refUid !== '' && refUid !== '0', `uid ${refUid}`);

  // Nothing secret baked into the images.
  for (const image of ['tokenization-middleware:latest', 'tokenization-reference-app:latest']) {
    const listing = execFileSync(
      'docker',
      ['run', '--rm', '--entrypoint', 'sh', image, '-c', 'find /app -path /app/node_modules -prune -o -type f -print'],
      { encoding: 'utf8' },
    );
    const bad = listing.split('\n').filter((f) => /\.env|\.pem$|\.key$|master-keys|kek|secrets/i.test(f));
    check(`${image} holds no env, key or certificate files`, bad.length === 0, bad.join(', '));
  }
  const cli = spawnSync('docker', ['run', '--rm', '--entrypoint', 'sh', 'tokenization-middleware:latest', '-c', 'test ! -e node_modules/prisma && test ! -e node_modules/.bin/prisma']);
  check('middleware image does not ship the Prisma CLI', cli.status === 0);

  // No identifier or secret in any container log.
  const logs = compose(['logs', '--no-color']).out + setup.out;
  // Read the secrets from inside the containers: on some engines the bind-mount
  // source lives in the Docker VM rather than on the host.
  const secrets = [
    compose(['exec', '-T', 'middleware', 'cat', '/run/secrets/master_kek']).out.trim(),
    compose(['exec', '-T', 'reference-app', 'cat', '/run/secrets/reference_api_key']).out.trim(),
  ];
  check('logs are non-empty', logs.includes('request completed'));
  check('no synthetic BVN in any container log', !logs.includes(bvn));
  check('secrets were read back for the check', /^[0-9a-f]{64}$/.test(secrets[0]) && /^tkm_/.test(secrets[1]));
  check('no KEK or API key in any container log', secrets.every((s) => s.length > 0 && !logs.includes(s)));

  const passwords = [
    compose(['exec', '-T', 'middleware', 'cat', '/run/secrets/vault_db_password']).out.trim(),
    compose(['exec', '-T', 'reference-app', 'cat', '/run/secrets/reference_db_password']).out.trim(),
  ];
  check('database passwords were generated', passwords.every((p) => /^[A-Za-z0-9_-]{43}$/.test(p)) && passwords[0] !== passwords[1]);
  check('no database password in any container log', passwords.every((p) => !logs.includes(p)));
  const config = compose(['config']).out;
  check('no database password in the resolved Compose config', passwords.every((p) => !config.includes(p)));
  const ids = compose(['ps', '-a', '-q']).out.trim().split(/\s+/).filter(Boolean);
  const containerEnv = execFileSync('docker', ['inspect', '--format', '{{json .Config.Env}}', ...ids], { encoding: 'utf8' });
  check('no database password in any container environment', passwords.every((p) => !containerEnv.includes(p)));

  for (const image of ['tokenization-middleware:latest', 'tokenization-reference-app:latest']) {
    const size = execFileSync('docker', ['image', 'ls', image, '--format', '{{.Size}}'], { encoding: 'utf8' }).trim();
    console.log(`info  ${image}: ${size}`);
  }
}

main()
  .catch((err) => {
    failures += 1;
    console.error(`e2e error: ${err.message}`);
  })
  .finally(() => {
    console.log('e2e: tearing down');
    compose(['--profile', 'setup', 'down', '-v', '--remove-orphans'], { allowFail: true });
    // Setup wrote these as root/uid 1000 inside a container; remove them the same way.
    spawnSync('docker', ['run', '--rm', '-v', `${workDir}:/w`, '--entrypoint', 'sh', 'tokenization-middleware-setup:latest', '-c', 'rm -rf /w/secrets /w/keys'], {
      stdio: 'ignore',
    });
    rmSync(workDir, { recursive: true, force: true });
    const skipped = results.filter((r) => r.startsWith('SKIP')).length;
    if (skipped > 0) console.log(`e2e: ${skipped} SKIPPED`);
    console.log(failures === 0 ? 'e2e: ALL PASSED' : `e2e: ${failures} FAILED`);
    process.exitCode = failures === 0 ? 0 : 1;
  });
