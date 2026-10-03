import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { LoggerService } from '@nestjs/common';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { BODY_LIMIT_BYTES, createApp } from '../../src/app.factory';
import { generateToken } from '../../src/crypto/crypto';
import { VaultService } from '../../src/vault/vault.service';
import { syntheticBvn } from '../helpers/synthetic-bvn';

// Every synthetic BVN this file sends, checked against all log output at the end.
const sentBvns = new Set<string>();
function bvn(): string {
  const value = syntheticBvn();
  sentBvns.add(value);
  return value;
}

// Everything any logger writes during the run.
const logLines: string[] = [];
const captureStream = new Writable({
  write(chunk, _enc, done) {
    logLines.push(chunk.toString());
    done();
  },
});
const captureNestLogger: LoggerService = {
  log: (...args: unknown[]) => void logLines.push(JSON.stringify(args)),
  error: (...args: unknown[]) => void logLines.push(JSON.stringify(args)),
  warn: (...args: unknown[]) => void logLines.push(JSON.stringify(args)),
  debug: (...args: unknown[]) => void logLines.push(JSON.stringify(args)),
  verbose: (...args: unknown[]) => void logLines.push(JSON.stringify(args)),
  fatal: (...args: unknown[]) => void logLines.push(JSON.stringify(args)),
};

const ROOT = resolve(__dirname, '../..');

describe('HTTP interface (PostgreSQL)', () => {
  let app: NestFastifyApplication;
  let db: PrismaClient;
  let certDir: string;
  let env: Record<string, string>;
  let appId: string;
  let otherAppId: string;
  const restoreStdio: (() => void)[] = [];

  async function post(url: string, payload: unknown) {
    return app.inject({ method: 'POST', url, payload: payload as object });
  }

  beforeAll(async () => {
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        logLines.push(String(chunk));
        return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write;
      restoreStdio.push(() => (stream.write = original));
    }

    certDir = mkdtempSync(join(tmpdir(), 'vault-certs-'));
    execFileSync(process.execPath, [join(ROOT, 'scripts/dev-certs.js'), certDir], { stdio: 'pipe' });

    db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    appId = (await db.application.create({ data: { name: `http-${generateToken()}` } })).id;
    otherAppId = (await db.application.create({ data: { name: `http-other-${generateToken()}` } })).id;

    env = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      DATABASE_URL: process.env.DATABASE_URL as string,
      TLS_CERT_PATH: join(certDir, 'dev-cert.pem'),
      TLS_KEY_PATH: join(certDir, 'dev-key.pem'),
      MASTER_KEY_DEV: randomBytes(32).toString('hex'),
      DEV_APP_ID: appId,
    };
    app = await createApp(env, { logStream: captureStream, nestLogger: captureNestLogger });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    rmSync(certDir, { recursive: true, force: true });
    restoreStdio.forEach((restore) => restore());
  });

  describe('tokenize', () => {
    it('returns a 32-hex token and stores an envelope-encrypted row for the caller', async () => {
      const value = bvn();
      const res = await post('/v1/tokenize', { dataType: 'BVN', value });

      expect(res.statusCode).toBe(201);
      const { token } = res.json();
      expect(token).toMatch(/^[0-9a-f]{32}$/);

      const row = await db.vaultRecord.findUniqueOrThrow({ where: { token } });
      expect(row.appId).toBe(appId);
      expect(row.dataType).toBe('BVN');
      expect(row.iv.length).toBe(12);
      expect(row.authTag.length).toBe(16);
      expect(row.wrappedDataKey?.length).toBe(40);
      expect(row.masterKeyVersion).toBe(1);
      expect(row.erasedAt).toBeNull();
      expect(Buffer.from(row.ciphertext).equals(Buffer.from(value))).toBe(false);
      expect(Buffer.from(row.ciphertext).includes(Buffer.from(value))).toBe(false);
    });

    it('gives two different tokens for the same BVN', async () => {
      const value = bvn();
      const a = (await post('/v1/tokenize', { dataType: 'BVN', value })).json().token;
      const b = (await post('/v1/tokenize', { dataType: 'BVN', value })).json().token;
      expect(a).not.toBe(b);
    });
  });

  describe('detokenize', () => {
    it('returns the original value with Cache-Control: no-store', async () => {
      const value = bvn();
      const { token } = (await post('/v1/tokenize', { dataType: 'BVN', value })).json();

      const res = await post('/v1/detokenize', { token });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.json();
      expect(body.dataType).toBe('BVN');
      expect(body.value === value).toBe(true);
      expect(Object.keys(body).sort()).toEqual(['dataType', 'value']);
    });
  });

  describe('erase', () => {
    it('makes detokenize 404 while the row stays with a null wrapped key and erasedAt set', async () => {
      const { token } = (await post('/v1/tokenize', { dataType: 'BVN', value: bvn() })).json();
      const before = await db.vaultRecord.findUniqueOrThrow({ where: { token } });

      const res = await post('/v1/erase', { token });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ erased: true });

      expect((await post('/v1/detokenize', { token })).statusCode).toBe(404);

      const row = await db.vaultRecord.findUnique({ where: { token } });
      expect(row).not.toBeNull();
      expect(row!.wrappedDataKey).toBeNull();
      expect(row!.erasedAt).toBeInstanceOf(Date);
      expect(Buffer.from(row!.ciphertext).equals(Buffer.from(before.ciphertext))).toBe(true);
    });

    it('returns 404 the second time', async () => {
      const { token } = (await post('/v1/tokenize', { dataType: 'BVN', value: bvn() })).json();
      expect((await post('/v1/erase', { token })).statusCode).toBe(200);
      expect((await post('/v1/erase', { token })).statusCode).toBe(404);
    });
  });

  describe('one not-found response', () => {
    it('is byte-identical for unknown, erased, altered, and other-app tokens', async () => {
      const { token: erased } = (await post('/v1/tokenize', { dataType: 'BVN', value: bvn() })).json();
      await post('/v1/erase', { token: erased });

      const { token: live } = (await post('/v1/tokenize', { dataType: 'BVN', value: bvn() })).json();
      const altered = (live[0] === 'a' ? 'b' : 'a') + live.slice(1);

      const otherApps = await app.get(VaultService).tokenize(otherAppId, 'BVN', bvn());

      const cases = { unknown: generateToken(), erased, altered, otherApps };
      for (const route of ['/v1/detokenize', '/v1/erase']) {
        const responses = await Promise.all(Object.values(cases).map((token) => post(route, { token })));
        const reference = responses[0];
        expect(reference.statusCode).toBe(404);
        for (const res of responses) {
          expect(res.statusCode).toBe(404);
          expect(res.rawPayload.equals(reference.rawPayload)).toBe(true);
          expect(res.headers['content-type']).toBe(reference.headers['content-type']);
        }
      }

      // The other app's record was not erased by the probe.
      const row = await db.vaultRecord.findUniqueOrThrow({ where: { token: otherApps } });
      expect(row.erasedAt).toBeNull();
    });
  });

  describe('validation', () => {
    it.each([
      ['a 10-digit BVN', () => ({ dataType: 'BVN', value: bvn().slice(0, 10) })],
      ['a non-digit BVN', () => ({ dataType: 'BVN', value: bvn().slice(0, 10) + 'x' })],
      ['an unknown dataType', () => ({ dataType: 'BVN_UNKNOWN', value: bvn() })],
    ])('rejects %s with 400 and does not echo it', async (_label, make) => {
      const payload = make();
      const res = await post('/v1/tokenize', payload);
      expect(res.statusCode).toBe(400);
      expect(res.body.includes(payload.value)).toBe(false);
      if (payload.dataType !== 'BVN') {
        expect(res.body.includes(payload.dataType)).toBe(false);
      }
    });

    it('rejects a malformed token with 400 and does not echo it', async () => {
      const token = 'Z' + generateToken().slice(1);
      for (const route of ['/v1/detokenize', '/v1/erase']) {
        const res = await post(route, { token });
        expect(res.statusCode).toBe(400);
        expect(res.body.includes(token)).toBe(false);
      }
    });

    it('rejects malformed JSON containing a BVN with 400 and does not echo it', async () => {
      const value = bvn();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/tokenize',
        headers: { 'content-type': 'application/json' },
        payload: `{"dataType":"BVN","value":"${value}"`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.includes(value)).toBe(false);
    });

    it(`rejects bodies over ${BODY_LIMIT_BYTES} bytes with 413`, async () => {
      const res = await post('/v1/tokenize', { dataType: 'BVN', value: bvn(), pad: 'x'.repeat(BODY_LIMIT_BYTES) });
      expect(res.statusCode).toBe(413);
    });

    it('rejects non-JSON content types with 415', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/tokenize',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `dataType=BVN&value=${bvn()}`,
      });
      expect(res.statusCode).toBe(415);
    });
  });

  describe('TLS', () => {
    it('serves the API over HTTPS and not over plain HTTP', async () => {
      await app.listen(0, '127.0.0.1');
      const { port } = app.getHttpServer().address() as { port: number };
      const ca = readFileSync(env.TLS_CERT_PATH);
      const value = bvn();
      const payload = JSON.stringify({ dataType: 'BVN', value });

      const status = await new Promise<number>((done, fail) => {
        const req = httpsRequest(
          { host: '127.0.0.1', port, servername: 'localhost', ca, method: 'POST', path: '/v1/tokenize',
            headers: { 'content-type': 'application/json' } },
          (res) => {
            res.resume();
            res.on('end', () => done(res.statusCode ?? 0));
          },
        );
        req.on('error', fail);
        req.end(payload);
      });
      expect(status).toBe(201);

      const plainHttp = await new Promise<string>((done) => {
        const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/v1/tokenize' }, (res) => {
          res.resume();
          done(`status ${res.statusCode}`);
        });
        req.on('error', () => done('error'));
        req.end(payload);
      });
      expect(plainHttp).not.toBe('status 201');
    });
  });

  describe('startup refusals', () => {
    it('refuses to start without TLS config', async () => {
      const { TLS_CERT_PATH: _c, TLS_KEY_PATH: _k, ...noTls } = env;
      await expect(createApp(noTls, { nestLogger: captureNestLogger })).rejects.toThrow('TLS is required');
      await expect(createApp({ ...env, TLS_KEY_PATH: '' }, { nestLogger: captureNestLogger })).rejects.toThrow(
        'TLS is required',
      );
    });

    it('refuses the temporary DevKeyProvider and DevAppGuard under NODE_ENV=production', async () => {
      await expect(
        createApp({ ...env, NODE_ENV: 'production' }, { nestLogger: captureNestLogger }),
      ).rejects.toThrow(/Dev(KeyProvider|AppGuard) must not run when NODE_ENV=production/);
    });
  });

  describe('logging', () => {
    it('never writes a synthetic BVN to any log output', () => {
      const all = logLines.join('\n');
      // The capture really saw request logs, so this check is not vacuous.
      expect(all).toContain('request completed');
      expect(sentBvns.size).toBeGreaterThan(10);
      const leaked = [...sentBvns].filter((value) => all.includes(value));
      expect(leaked.length).toBe(0);
    });
  });
});
