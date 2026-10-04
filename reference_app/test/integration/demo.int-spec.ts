import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { LoggerService } from '@nestjs/common';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../../src/app.factory';
import { cleanup, FakeMiddleware, makeCert } from '../helpers/fake-middleware';
import { syntheticBvn } from '../helpers/synthetic-bvn';

const API_KEY = 'tkm_' + Buffer.alloc(32, 7).toString('base64url');
const INSPECT_KEY = 'tkm_' + Buffer.alloc(32, 9).toString('base64url');
const PASSWORD = 'demo-password-for-tests';
const ZERO_ID = '00000000-0000-4000-8000-000000000000';

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
const GOOD = basic('demo', PASSWORD);

const sentBvns = new Set<string>();
function bvn(): string {
  const value = syntheticBvn();
  sentBvns.add(value);
  return value;
}

const logLines: string[] = [];
const capture = (...args: unknown[]) => void logLines.push(JSON.stringify(args));
const nestLogger: LoggerService = { log: capture, error: capture, warn: capture, debug: capture, verbose: capture, fatal: capture };
const logStream = new Writable({
  write(chunk, _enc, done) {
    logLines.push(chunk.toString());
    done();
  },
});

// Every route the app can serve with the demo on, plus an unknown one.
const ROUTES: [string, string][] = [
  ['GET', '/'],
  ['GET', '/app.js'],
  ['GET', '/app.css'],
  ['GET', '/fonts/archivo.woff2'],
  ['GET', '/customers'],
  ['GET', `/customers/${ZERO_ID}`],
  ['POST', '/customers'],
  ['POST', `/customers/${ZERO_ID}/reveal-bvn`],
  ['POST', `/customers/${ZERO_ID}/erase`],
  ['GET', '/demo/vault'],
  ['GET', '/no-such-page'],
];

describe('reference app demo (PostgreSQL, fake middleware over HTTPS)', () => {
  const tls = makeCert();
  const middleware = new FakeMiddleware(tls, API_KEY, INSPECT_KEY);
  const secretsDir = mkdtempSync(join(tmpdir(), 'ref-demo-'));
  const passwordFile = join(secretsDir, 'demo-password');
  let demo: NestFastifyApplication;
  let plain: NestFastifyApplication;
  const responses: string[] = [];

  const baseEnv = () => ({
    DATABASE_URL: process.env.DATABASE_URL,
    MIDDLEWARE_URL: middleware.url,
    MIDDLEWARE_CA_PATH: tls.certPath,
    REFERENCE_API_KEY: API_KEY,
    LOG_LEVEL: 'info',
  });
  const demoEnv = () => ({ ...baseEnv(), DEMO_PASSWORD_FILE: passwordFile, REFERENCE_INSPECT_KEY: INSPECT_KEY });

  async function start(env: Record<string, string | undefined>): Promise<NestFastifyApplication> {
    const app = await createApp(env, { logStream, nestLogger });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  }

  async function request(app: NestFastifyApplication, method: string, url: string, auth?: string, payload?: object) {
    const res = await app.inject({
      method: method as 'GET' | 'POST',
      url,
      headers: auth ? { authorization: auth } : {},
      ...(payload ? { payload } : {}),
    });
    responses.push(res.body);
    return res;
  }

  beforeAll(async () => {
    writeFileSync(passwordFile, `${PASSWORD}\n`);
    await middleware.start();
    demo = await start(demoEnv());
    plain = await start(baseEnv());
  });

  afterAll(async () => {
    await demo.close();
    await plain.close();
    await middleware.stop();
    cleanup(tls.dir);
    rmSync(secretsDir, { recursive: true, force: true });
  });

  it.each(ROUTES)('requires Basic auth on %s %s and refuses a wrong password', async (method, url) => {
    for (const auth of [undefined, basic('demo', 'wrong-password-123'), basic('admin', PASSWORD), `Bearer ${API_KEY}`]) {
      const res = await request(demo, method, url, auth);
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/^Basic realm=/);
      expect(res.body.includes(PASSWORD)).toBe(false);
    }
    const ok = await request(demo, method, url, GOOD, method === 'POST' && url === '/customers' ? { fullName: 'A', bvn: bvn() } : undefined);
    expect(ok.statusCode).not.toBe(401);
  });

  it('serves the page with a strict Content-Security-Policy', async () => {
    const page = await request(demo, 'GET', '/', GOOD);
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.body).toContain('<script src="/app.js" defer></script>');
    expect(page.body).not.toMatch(/<script>|style=|onclick=/);

    const script = await request(demo, 'GET', '/app.js', GOOD);
    expect(script.headers['content-type']).toMatch(/^text\/javascript/);
    // The BVN is never kept in browser storage or cookies, and nothing is logged.
    expect(script.body).not.toMatch(/localStorage\.|sessionStorage\.|document\.cookie|console\./);
  });

  it('shows tokens in the app view and stored bytes in the vault view, using the INSPECT key', async () => {
    const value = bvn();
    const created = await request(demo, 'POST', '/customers', GOOD, { fullName: 'Ngozi Demo', bvn: value });
    expect(created.statusCode).toBe(201);
    const { id, bvnToken } = created.json();

    const list = await request(demo, 'GET', '/customers', GOOD);
    expect(list.statusCode).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.json()).toEqual(expect.arrayContaining([{ id, fullName: 'Ngozi Demo', bvnToken }]));
    for (const c of list.json()) {
      expect(Object.keys(c).sort()).toEqual(['bvnToken', 'fullName', 'id']);
    }

    const before = middleware.calls.length;
    const vault = await request(demo, 'GET', '/demo/vault', GOOD);
    expect(vault.statusCode).toBe(200);
    const record = vault.json().records.find((r: { token: string }) => r.token === bvnToken);
    expect(record.wrappedDataKey).toMatch(/^[0-9a-f]{80}$/);
    expect(middleware.calls.slice(before)).toEqual([{ path: '/v1/demo/inspect', authorized: true, as: 'inspect' }]);

    await request(demo, 'POST', `/customers/${id}/erase`, GOOD);
    const after = await request(demo, 'GET', '/demo/vault', GOOD);
    const erased = after.json().records.find((r: { token: string }) => r.token === bvnToken);
    expect(erased.wrappedDataKey).toBeNull();
    expect(erased.erasedAt).not.toBeNull();
    expect((await request(demo, 'POST', `/customers/${id}/reveal-bvn`, GOOD)).statusCode).toBe(404);

    // The main key is never used for inspect, and the inspect key never for anything else.
    expect(middleware.calls.filter((c) => c.as === 'inspect').every((c) => c.path === '/v1/demo/inspect')).toBe(true);
    expect(middleware.calls.filter((c) => c.as === 'api').every((c) => c.path !== '/v1/demo/inspect')).toBe(true);
  });

  it('has no page, list or vault view, and no login, when the demo is off', async () => {
    for (const url of ['/', '/app.js', '/customers', '/demo/vault']) {
      const res = await request(plain, 'GET', url);
      expect(res.statusCode).toBe(404);
      expect(res.headers['www-authenticate']).toBeUndefined();
    }
    const created = await request(plain, 'POST', '/customers', undefined, { fullName: 'B', bvn: bvn() });
    expect(created.statusCode).toBe(201);
  });

  it('refuses to start the demo without an INSPECT key or with a weak password file', async () => {
    const { REFERENCE_INSPECT_KEY: _k, ...noInspect } = demoEnv();
    await expect(createApp(noInspect, { nestLogger })).rejects.toThrow('REFERENCE_INSPECT_KEY');
    const weak = join(secretsDir, 'weak');
    writeFileSync(weak, 'short');
    await expect(createApp({ ...demoEnv(), DEMO_PASSWORD_FILE: weak }, { nestLogger })).rejects.toThrow('at least 12');
  });

  it('never puts a BVN in a page or view response, or anything secret in a log line', () => {
    const all = responses.join('\n');
    expect([...sentBvns].filter((v) => all.includes(v))).toEqual([]);

    const logs = logLines.join('\n');
    expect(logs).toContain('request completed');
    for (const secret of [...sentBvns, PASSWORD, API_KEY, INSPECT_KEY, Buffer.from(`demo:${PASSWORD}`).toString('base64')]) {
      expect(logs.includes(secret)).toBe(false);
    }
  });
});
