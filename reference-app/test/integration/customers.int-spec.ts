import { Writable } from 'node:stream';
import { LoggerService } from '@nestjs/common';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app.factory';
import { PrismaService } from '../../src/prisma/prisma.module';
import { cleanup, FakeMiddleware, makeCert } from '../helpers/fake-middleware';
import { syntheticBvn } from '../helpers/synthetic-bvn';

const API_KEY = 'tkm_' + Buffer.alloc(32, 7).toString('base64url');

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

describe('reference app (PostgreSQL, fake middleware over HTTPS)', () => {
  const trusted = makeCert();
  const untrusted = makeCert();
  const middleware = new FakeMiddleware(trusted, API_KEY);
  let app: NestFastifyApplication;
  let db: PrismaClient;

  const envFor = (url: string) => ({
    DATABASE_URL: process.env.DATABASE_URL,
    MIDDLEWARE_URL: url,
    MIDDLEWARE_CA_PATH: trusted.certPath,
    REFERENCE_API_KEY: API_KEY,
    LOG_LEVEL: 'info',
  });

  async function start(url: string): Promise<NestFastifyApplication> {
    const instance = await createApp(envFor(url), { logStream, nestLogger });
    await instance.init();
    await instance.getHttpAdapter().getInstance().ready();
    return instance;
  }

  const post = (url: string, payload?: object, target = app) =>
    target.inject({ method: 'POST', url, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    await middleware.start();
    app = await start(middleware.url);
    db = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
    await middleware.stop();
    cleanup(trusted.dir);
    cleanup(untrusted.dir);
  });

  afterEach(() => {
    middleware.failWith = null;
    jest.restoreAllMocks();
  });

  it('creates a customer holding only a token, reveals once, erases, then reveal fails', async () => {
    const value = bvn();
    const created = await post('/customers', { fullName: 'Ada Obi', bvn: value });
    expect(created.statusCode).toBe(201);
    expect(created.body.includes(value)).toBe(false);
    const customer = created.json();
    expect(Object.keys(customer).sort()).toEqual(['bvnToken', 'fullName', 'id']);
    expect(customer.bvnToken).toMatch(/^[0-9a-f]{32}$/);

    const read = await app.inject({ method: 'GET', url: `/customers/${customer.id}` });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(customer);
    expect(read.body.includes(value)).toBe(false);

    const reveal = await post(`/customers/${customer.id}/reveal-bvn`);
    expect(reveal.statusCode).toBe(200);
    expect(reveal.headers['cache-control']).toBe('no-store');
    expect(reveal.json().bvn === value).toBe(true);

    const erase = await post(`/customers/${customer.id}/erase`);
    expect(erase.statusCode).toBe(200);
    expect(erase.json()).toEqual({ erased: true });

    const after = await post(`/customers/${customer.id}/reveal-bvn`);
    expect(after.statusCode).toBe(404);
    expect(after.json().message).toBe('BVN not available');
    expect((await post(`/customers/${customer.id}/erase`)).statusCode).toBe(404);

    // The customer row stays, with its now-dead token.
    expect(await db.customer.findUnique({ where: { id: customer.id } })).toEqual(customer);
    expect(middleware.calls.every((c) => c.authorized)).toBe(true);
  });

  it('stores no BVN anywhere in its database', async () => {
    const value = bvn();
    await post('/customers', { fullName: 'Chidi Eze', bvn: value });
    const dump = JSON.stringify(await db.customer.findMany());
    expect([...sentBvns].filter((v) => dump.includes(v))).toEqual([]);
    const columns = Object.keys((await db.customer.findFirst()) ?? {});
    expect(columns.sort()).toEqual(['bvnToken', 'fullName', 'id']);
  });

  it('returns 404 for unknown or malformed customer ids', async () => {
    expect((await app.inject({ method: 'GET', url: '/customers/00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/customers/not-a-uuid' })).statusCode).toBe(404);
    expect((await post('/customers/00000000-0000-4000-8000-000000000000/reveal-bvn')).statusCode).toBe(404);
  });

  it('rejects invalid input with 400 and never echoes the BVN', async () => {
    const value = bvn().slice(0, 10);
    const res = await post('/customers', { fullName: 'A', bvn: value });
    expect(res.statusCode).toBe(400);
    expect(res.body.includes(value)).toBe(false);

    const full = bvn();
    const malformed = await app.inject({
      method: 'POST',
      url: '/customers',
      headers: { 'content-type': 'application/json' },
      payload: `{"fullName":"A","bvn":"${full}"`,
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body.includes(full)).toBe(false);
  });

  it('maps any middleware failure to one fixed 502 that passes nothing on', async () => {
    const value = bvn();
    middleware.failWith = 500; // the fake echoes the request body in its error
    const res = await post('/customers', { fullName: 'A', bvn: value });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ statusCode: 502, message: 'tokenization service unavailable', error: 'Bad Gateway' });
    expect(res.body.includes(value)).toBe(false);
  });

  it('trusts only the middleware certificate', async () => {
    const impostor = new FakeMiddleware(untrusted, API_KEY);
    await impostor.start();
    const misled = await start(impostor.url);
    try {
      const res = await post('/customers', { fullName: 'A', bvn: bvn() }, misled);
      expect(res.statusCode).toBe(502);
      expect(impostor.calls).toHaveLength(0); // the TLS handshake failed before any request
    } finally {
      await misled.close();
      await impostor.stop();
    }
  });

  it('erases the new token when saving the customer fails', async () => {
    jest.spyOn(db.customer, 'create').mockRejectedValueOnce(new Error('database down'));
    const res = await post('/customers', { fullName: 'A', bvn: bvn() });
    expect(res.statusCode).toBe(500);
    const last = middleware.calls.slice(-2).map((c) => c.path);
    expect(last).toEqual(['/v1/tokenize', '/v1/erase']);
    const orphan = [...middleware.vault.values()].at(-1);
    expect(orphan?.erased).toBe(true);
  });

  it('refuses to start without an API key or with a plain-HTTP middleware URL', async () => {
    const { REFERENCE_API_KEY: _k, ...noKey } = envFor(middleware.url);
    await expect(createApp(noKey, { nestLogger })).rejects.toThrow('no API key');
    await expect(createApp(envFor('http://localhost:1'), { nestLogger })).rejects.toThrow('https://');
  });

  it('never writes a BVN or the API key to any log line', () => {
    const all = logLines.join('\n');
    expect(all).toContain('request completed');
    expect(sentBvns.size).toBeGreaterThan(5);
    expect([...sentBvns].filter((v) => all.includes(v))).toEqual([]);
    expect(all.includes(API_KEY)).toBe(false);
  });
});
