import { Writable } from 'node:stream';
import { LoggerService } from '@nestjs/common';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app.factory';
import { BaselinePrismaService } from '../../src/baseline/baseline-prisma.service';
import { PrismaService } from '../../src/prisma/prisma.module';
import { cleanup, FakeMiddleware, makeCert } from '../helpers/fake-middleware';
import { syntheticBvn } from '../helpers/synthetic-bvn';

// Evaluation only: the latency baseline routes (EVALUATION_BASELINE=true).

const API_KEY = 'tkm_' + Buffer.alloc(32, 7).toString('base64url');
const ZERO_ID = '00000000-0000-4000-8000-000000000000';

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

describe('evaluation baseline routes (PostgreSQL, fake middleware over HTTPS)', () => {
  const tls = makeCert();
  const middleware = new FakeMiddleware(tls, API_KEY);
  let evaluation: NestFastifyApplication;
  let plain: NestFastifyApplication;
  let baselineDb: BaselinePrismaService;
  let referenceDb: PrismaClient;

  const envFor = (extra: Record<string, string> = {}) => ({
    DATABASE_URL: process.env.DATABASE_URL,
    MIDDLEWARE_URL: middleware.url,
    MIDDLEWARE_CA_PATH: tls.certPath,
    REFERENCE_API_KEY: API_KEY,
    LOG_LEVEL: 'info',
    ...extra,
  });

  async function start(env: Record<string, string | undefined>): Promise<NestFastifyApplication> {
    const instance = await createApp(env, { logStream, nestLogger });
    await instance.init();
    await instance.getHttpAdapter().getInstance().ready();
    return instance;
  }

  const post = (target: NestFastifyApplication, url: string, payload?: object) =>
    target.inject({ method: 'POST', url, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    await middleware.start();
    evaluation = await start(
      envFor({ EVALUATION_BASELINE: 'true', BASELINE_DATABASE_URL: process.env.BASELINE_DATABASE_URL as string }),
    );
    plain = await start(envFor());
    baselineDb = evaluation.get(BaselinePrismaService);
    referenceDb = evaluation.get(PrismaService);
  });

  afterAll(async () => {
    await evaluation.close();
    await plain.close();
    await middleware.stop();
    cleanup(tls.dir);
  });

  it('does not exist unless EVALUATION_BASELINE=true', async () => {
    expect((await post(plain, '/baseline/customers', { fullName: 'A', bvn: bvn() })).statusCode).toBe(404);
    expect((await post(plain, `/baseline/customers/${ZERO_ID}/read`)).statusCode).toBe(404);
  });

  it('stores and reads a BVN in the baseline database, with no middleware and nothing in the reference database', async () => {
    const callsBefore = middleware.calls.length;
    const customersBefore = await referenceDb.customer.count();
    const value = bvn();

    const created = await post(evaluation, '/baseline/customers', { fullName: 'Ada Obi', bvn: value });
    expect(created.statusCode).toBe(201);
    expect(created.body.includes(value)).toBe(false);
    const { id } = created.json();
    expect(Object.keys(created.json()).sort()).toEqual(['fullName', 'id']);

    const read = await post(evaluation, `/baseline/customers/${id}/read`);
    expect(read.statusCode).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.json().bvn === value).toBe(true);

    const stored = await baselineDb.baselineCustomer.findUnique({ where: { id } });
    expect(stored?.bvn === value).toBe(true);
    expect(middleware.calls.length).toBe(callsBefore);
    expect(await referenceDb.customer.count()).toBe(customersBefore);
  });

  it('returns 404 for unknown ids and 400 for invalid input without echoing it', async () => {
    expect((await post(evaluation, `/baseline/customers/${ZERO_ID}/read`)).statusCode).toBe(404);
    expect((await post(evaluation, '/baseline/customers/not-a-uuid/read')).statusCode).toBe(404);
    const short = bvn().slice(0, 10);
    const res = await post(evaluation, '/baseline/customers', { fullName: 'A', bvn: short });
    expect(res.statusCode).toBe(400);
    expect(res.body.includes(short)).toBe(false);
  });

  it('refuses to start when the baseline database is the reference database', async () => {
    await expect(
      createApp(envFor({ EVALUATION_BASELINE: 'true', BASELINE_DATABASE_URL: process.env.DATABASE_URL as string }), {
        nestLogger,
      }),
    ).rejects.toThrow('must not be the reference database');
  });

  it('never writes a BVN to any log line', () => {
    const all = logLines.join('\n');
    expect(all).toContain('request completed');
    expect([...sentBvns].filter((v) => all.includes(v))).toEqual([]);
  });
});
