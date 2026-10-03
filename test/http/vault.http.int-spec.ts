import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { LoggerService } from '@nestjs/common';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AuditLog, Operation } from '@prisma/client';
import { BODY_LIMIT_BYTES, createApp } from '../../src/app.factory';
import { AuditService } from '../../src/audit/audit.service';
import { generateApiKey } from '../../src/auth/api-key';
import { createApplication, createCredential, revokeCredential } from '../../src/cli/admin';
import { generateToken } from '../../src/crypto/crypto';
import { KeyProvider } from '../../src/keys/key-provider';
import { PrismaDb } from '../../src/prisma/prisma';
import { PRISMA } from '../../src/prisma/prisma.module';
import { syntheticBvn } from '../helpers/synthetic-bvn';
import { TestClock } from '../helpers/test-clock';
import { TestKeys } from '../helpers/test-keys';

// Every synthetic BVN and API key this file uses, checked against all log
// output and every audit row at the end.
const sentBvns = new Set<string>();
const issuedKeys = new Set<string>();
function bvn(): string {
  const value = syntheticBvn();
  sentBvns.add(value);
  return value;
}

const logLines: string[] = [];
const captureStream = new Writable({
  write(chunk, _enc, done) {
    logLines.push(chunk.toString());
    done();
  },
});
const capture = (...args: unknown[]) => void logLines.push(JSON.stringify(args));
const captureNestLogger: LoggerService = {
  log: capture,
  error: capture,
  warn: capture,
  debug: capture,
  verbose: capture,
  fatal: capture,
};

const ROOT = resolve(__dirname, '../..');
const ALL: Operation[] = ['TOKENIZE', 'DETOKENIZE', 'ERASE'];

interface Credential {
  id: string;
  appId: string;
  key: string;
}

describe('HTTP interface with access control and audit (PostgreSQL)', () => {
  let app: NestFastifyApplication;
  let db: PrismaDb;
  let certDir: string;
  let env: Record<string, string>;
  let alice: Credential; // all scopes, app A
  let bob: Credential; // all scopes, app B
  const restoreStdio: (() => void)[] = [];
  const keys = new TestKeys();

  async function newCredential(scopes: Operation[], appId?: string): Promise<Credential> {
    const owner = appId ?? (await createApplication(db, `http-${generateToken()}`)).id;
    const { id, key } = await createCredential(db, owner, scopes);
    issuedKeys.add(key);
    return { id, appId: owner, key };
  }

  async function lastAuditId(): Promise<bigint> {
    const last = await db.auditLog.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
    return last?.id ?? 0n;
  }

  /**
   * POST to a vault endpoint and return the response together with the audit
   * rows it produced. Asserts there is exactly one, unless `expectRows` says otherwise.
   */
  async function call(
    target: NestFastifyApplication,
    auth: Credential | string | null,
    url: string,
    payload: unknown,
    expectRows = 1,
  ) {
    const before = await lastAuditId();
    const headers: Record<string, string> = {};
    if (auth !== null) {
      headers.authorization = typeof auth === 'string' ? auth : `Bearer ${auth.key}`;
    }
    const res = await target.inject({ method: 'POST', url, headers, payload: payload as object });
    const rows = await db.auditLog.findMany({ where: { id: { gt: before } }, orderBy: { id: 'asc' } });
    expect(rows).toHaveLength(expectRows);
    return { res, row: rows[0] as AuditLog };
  }

  const post = (auth: Credential | string | null, url: string, payload: unknown, expectRows = 1) =>
    call(app, auth, url, payload, expectRows);

  async function tokenize(cred: Credential, value = bvn()): Promise<string> {
    const { res } = await post(cred, '/v1/tokenize', { dataType: 'BVN', value });
    expect(res.statusCode).toBe(201);
    return res.json().token;
  }

  async function startApp(extraEnv: Record<string, string> = {}, clock?: TestClock, baseEnv = env) {
    const instance = await createApp(
      { ...baseEnv, ...extraEnv },
      { logStream: captureStream, nestLogger: captureNestLogger, clock },
    );
    await instance.init();
    await instance.getHttpAdapter().getInstance().ready();
    return instance;
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

    env = {
      LOG_LEVEL: 'info',
      DATABASE_URL: process.env.DATABASE_URL as string,
      TLS_CERT_PATH: join(certDir, 'dev-cert.pem'),
      TLS_KEY_PATH: join(certDir, 'dev-key.pem'),
      ...keys.env('file'),
    };
    app = await startApp();
    db = app.get(PRISMA);

    alice = await newCredential(ALL);
    bob = await newCredential(ALL);
  });

  afterAll(async () => {
    await app?.close();
    rmSync(certDir, { recursive: true, force: true });
    keys.cleanup();
    restoreStdio.forEach((restore) => restore());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('authentication', () => {
    it('gives 401 with one identical body and an UNAUTHENTICATED row for every bad key', async () => {
      const revoked = await newCredential(ALL);
      await revokeCredential(db, revoked.id);
      const token = generateToken();

      const cases: [string, Credential | string | null][] = [
        ['no header', null],
        ['unknown key', `Bearer ${generateApiKey()}`],
        ['revoked key', revoked],
        ['wrong scheme', `Basic ${alice.key}`],
        ['malformed key', `Bearer ${alice.key.slice(0, 20)}`],
      ];
      const bodies: Buffer[] = [];
      for (const [label, auth] of cases) {
        const { res, row } = await post(auth, '/v1/detokenize', { token });
        expect([label, res.statusCode]).toEqual([label, 401]);
        expect(res.headers['www-authenticate']).toBe('Bearer');
        expect(row.outcome).toBe('UNAUTHENTICATED');
        expect(row.credentialId).toBeNull();
        expect(row.operation).toBe('DETOKENIZE');
        expect(row.token).toBe(token);
        bodies.push(res.rawPayload);
      }
      for (const body of bodies) {
        expect(body.equals(bodies[0])).toBe(true);
      }
      expect(bodies[0].includes(alice.key)).toBe(false);
    });

    it('records a null token when the submitted one is malformed', async () => {
      const { res, row } = await post(null, '/v1/erase', { token: 'not-a-token' });
      expect(res.statusCode).toBe(401);
      expect(row.token).toBeNull();
    });
  });

  describe('scopes', () => {
    it('gives 403 and a FORBIDDEN_SCOPE row when the key lacks the operation', async () => {
      const tokenizeOnly = await newCredential(['TOKENIZE'], alice.appId);
      const token = await tokenize(alice);

      const { res, row } = await post(tokenizeOnly, '/v1/detokenize', { token });
      expect(res.statusCode).toBe(403);
      expect(res.body.includes(token)).toBe(false);
      expect(row).toMatchObject({ outcome: 'FORBIDDEN_SCOPE', credentialId: tokenizeOnly.id, operation: 'DETOKENIZE' });

      expect((await post(tokenizeOnly, '/v1/erase', { token })).res.statusCode).toBe(403);
      // Its own scope still works.
      expect((await post(tokenizeOnly, '/v1/tokenize', { dataType: 'BVN', value: bvn() })).res.statusCode).toBe(201);
    });
  });

  describe('tokenize', () => {
    it("stores an envelope-encrypted row for the key's application and audits the new token", async () => {
      const value = bvn();
      const { res, row: audit } = await post(alice, '/v1/tokenize', { dataType: 'BVN', value });

      expect(res.statusCode).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const { token } = res.json();
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      expect(audit).toMatchObject({ outcome: 'SUCCESS', operation: 'TOKENIZE', credentialId: alice.id, token });

      const record = await db.vaultRecord.findUniqueOrThrow({ where: { token } });
      expect(record.appId).toBe(alice.appId);
      expect(record.iv.length).toBe(12);
      expect(record.authTag.length).toBe(16);
      expect(record.wrappedDataKey?.length).toBe(40);
      expect(Buffer.from(record.ciphertext).includes(Buffer.from(value))).toBe(false);
    });

    it('gives two different tokens for the same BVN', async () => {
      const value = bvn();
      expect(await tokenize(alice, value)).not.toBe(await tokenize(alice, value));
    });
  });

  describe('detokenize', () => {
    it('returns the original value with Cache-Control: no-store and a SUCCESS row', async () => {
      const value = bvn();
      const token = await tokenize(alice, value);

      const { res, row } = await post(alice, '/v1/detokenize', { token });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.json().value === value).toBe(true);
      expect(row).toMatchObject({ outcome: 'SUCCESS', operation: 'DETOKENIZE', credentialId: alice.id, token });
    });

    it('gives 404 and a NOT_FOUND row for an unknown token', async () => {
      const token = generateToken();
      const { res, row } = await post(alice, '/v1/detokenize', { token });
      expect(res.statusCode).toBe(404);
      expect(row).toMatchObject({ outcome: 'NOT_FOUND', token });
    });
  });

  describe('owner check', () => {
    it("app B with all scopes gets 404 on app A's token, both rows say NOT_OWNER, record untouched", async () => {
      const token = await tokenize(alice);
      const before = await db.vaultRecord.findUniqueOrThrow({ where: { token } });

      const detok = await post(bob, '/v1/detokenize', { token });
      expect(detok.res.statusCode).toBe(404);
      expect(detok.row).toMatchObject({ outcome: 'NOT_OWNER', credentialId: bob.id, token });

      const erase = await post(bob, '/v1/erase', { token });
      expect(erase.res.statusCode).toBe(404);
      expect(erase.row).toMatchObject({ outcome: 'NOT_OWNER', credentialId: bob.id, token });

      expect(await db.vaultRecord.findUniqueOrThrow({ where: { token } })).toEqual(before);
    });
  });

  describe('erase', () => {
    it('erases with a SUCCESS row; afterwards detokenize and erase give 404 with ERASED rows', async () => {
      const token = await tokenize(alice);

      const erase = await post(alice, '/v1/erase', { token });
      expect(erase.res.statusCode).toBe(200);
      expect(erase.res.json()).toEqual({ erased: true });
      expect(erase.row).toMatchObject({ outcome: 'SUCCESS', operation: 'ERASE', token });

      const detok = await post(alice, '/v1/detokenize', { token });
      expect(detok.res.statusCode).toBe(404);
      expect(detok.row.outcome).toBe('ERASED');

      const again = await post(alice, '/v1/erase', { token });
      expect(again.res.statusCode).toBe(404);
      expect(again.row.outcome).toBe('ERASED');

      const record = await db.vaultRecord.findUniqueOrThrow({ where: { token } });
      expect(record.wrappedDataKey).toBeNull();
      expect(record.erasedAt).toBeInstanceOf(Date);
    });
  });

  describe('one not-found response', () => {
    it('is byte-identical for unknown, erased, altered and other-app tokens', async () => {
      const erased = await tokenize(alice);
      await post(alice, '/v1/erase', { token: erased });
      const live = await tokenize(alice);
      const altered = (live[0] === 'a' ? 'b' : 'a') + live.slice(1);
      const otherApps = await tokenize(bob);

      for (const route of ['/v1/detokenize', '/v1/erase']) {
        const bodies: Buffer[] = [];
        const outcomes: string[] = [];
        for (const token of [generateToken(), erased, altered, otherApps]) {
          const { res, row } = await post(alice, route, { token });
          expect(res.statusCode).toBe(404);
          bodies.push(res.rawPayload);
          outcomes.push(row.outcome);
        }
        expect(bodies.every((b) => b.equals(bodies[0]))).toBe(true);
        expect(outcomes).toEqual(['NOT_FOUND', 'ERASED', 'NOT_FOUND', 'NOT_OWNER']);
      }
      expect((await db.vaultRecord.findUniqueOrThrow({ where: { token: otherApps } })).erasedAt).toBeNull();
    });
  });

  describe('validation', () => {
    it.each([
      ['a 10-digit BVN', () => ({ dataType: 'BVN', value: bvn().slice(0, 10) })],
      ['a non-digit BVN', () => ({ dataType: 'BVN', value: bvn().slice(0, 10) + 'x' })],
      ['an unknown dataType', () => ({ dataType: 'BVN_UNKNOWN', value: bvn() })],
    ])('rejects %s with 400 and an INVALID_REQUEST row, without echoing it', async (_label, make) => {
      const payload = make();
      const { res, row } = await post(alice, '/v1/tokenize', payload);
      expect(res.statusCode).toBe(400);
      expect(res.body.includes(payload.value)).toBe(false);
      if (payload.dataType !== 'BVN') {
        expect(res.body.includes(payload.dataType)).toBe(false);
      }
      expect(row).toMatchObject({ outcome: 'INVALID_REQUEST', operation: 'TOKENIZE', credentialId: alice.id, token: null });
    });

    it('rejects a malformed token with 400 and records a null token', async () => {
      const token = 'Z' + generateToken().slice(1);
      for (const route of ['/v1/detokenize', '/v1/erase']) {
        const { res, row } = await post(alice, route, { token });
        expect(res.statusCode).toBe(400);
        expect(res.body.includes(token)).toBe(false);
        expect(row).toMatchObject({ outcome: 'INVALID_REQUEST', token: null });
      }
    });

    // Fastify rejects these while reading the body, before the request reaches
    // Nest's guard and filter, so they produce no audit row (documented).
    it('rejects malformed JSON (400), oversized bodies (413) and non-JSON (415) before auditing', async () => {
      const value = bvn();
      const auth = { authorization: `Bearer ${alice.key}` };
      const before = await lastAuditId();

      const malformed = await app.inject({
        method: 'POST',
        url: '/v1/tokenize',
        headers: { ...auth, 'content-type': 'application/json' },
        payload: `{"dataType":"BVN","value":"${value}"`,
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.body.includes(value)).toBe(false);

      const oversized = await app.inject({
        method: 'POST',
        url: '/v1/tokenize',
        headers: auth,
        payload: { dataType: 'BVN', value: bvn(), pad: 'x'.repeat(BODY_LIMIT_BYTES) },
      });
      expect(oversized.statusCode).toBe(413);

      const form = await app.inject({
        method: 'POST',
        url: '/v1/tokenize',
        headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
        payload: `dataType=BVN&value=${bvn()}`,
      });
      expect(form.statusCode).toBe(415);

      expect(await lastAuditId()).toBe(before);
    });
  });

  describe('errors and fail-closed auditing', () => {
    it('gives 500 and an ERROR row when the key layer fails', async () => {
      const token = await tokenize(alice);
      jest.spyOn(app.get(KeyProvider), 'unwrap').mockRejectedValueOnce(new Error('key layer down'));

      const { res, row } = await post(alice, '/v1/detokenize', { token });
      expect(res.statusCode).toBe(500);
      expect(row).toMatchObject({ outcome: 'ERROR', operation: 'DETOKENIZE', token });
    });

    it('detokenize returns 500 with no value when the audit write fails', async () => {
      const value = bvn();
      const token = await tokenize(alice, value);
      jest.spyOn(app.get(AuditService), 'write').mockRejectedValue(new Error('audit store down'));

      const { res } = await post(alice, '/v1/detokenize', { token }, 0);
      expect(res.statusCode).toBe(500);
      expect(res.body.includes(value)).toBe(false);
      expect(res.body.includes('"value"')).toBe(false);
    });

    it('tokenize leaves no vault row when the audit write fails', async () => {
      const recordsBefore = await db.vaultRecord.count({ where: { appId: alice.appId } });
      jest.spyOn(app.get(AuditService), 'write').mockRejectedValue(new Error('audit store down'));

      const { res } = await post(alice, '/v1/tokenize', { dataType: 'BVN', value: bvn() }, 0);
      expect(res.statusCode).toBe(500);
      expect(res.body.includes('token":')).toBe(false);
      expect(await db.vaultRecord.count({ where: { appId: alice.appId } })).toBe(recordsBefore);
    });

    it('erase leaves the record live when the audit write fails', async () => {
      const token = await tokenize(alice);
      jest.spyOn(app.get(AuditService), 'write').mockRejectedValue(new Error('audit store down'));

      const { res } = await post(alice, '/v1/erase', { token }, 0);
      expect(res.statusCode).toBe(500);
      const record = await db.vaultRecord.findUniqueOrThrow({ where: { token } });
      expect(record.erasedAt).toBeNull();
      expect(record.wrappedDataKey).not.toBeNull();
    });
  });

  describe('rate limiting', () => {
    let limited: NestFastifyApplication;
    const clock = new TestClock();

    beforeAll(async () => {
      limited = await startApp({ RATE_LIMIT_PER_MINUTE: '3' }, clock);
    });

    afterAll(async () => {
      await limited.close();
    });

    it('refuses the 4th request with 429 and Retry-After, per credential, until the window passes', async () => {
      const first = await newCredential(ALL);
      const second = await newCredential(ALL);
      const tokenizeAs = (cred: Credential) =>
        call(limited, cred, '/v1/tokenize', { dataType: 'BVN', value: bvn() });

      for (let i = 0; i < 3; i++) {
        expect((await tokenizeAs(first)).res.statusCode).toBe(201);
      }
      const { res, row } = await tokenizeAs(first);
      expect(res.statusCode).toBe(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(60);
      expect(row).toMatchObject({ outcome: 'RATE_LIMITED', credentialId: first.id, operation: 'TOKENIZE' });

      // Another credential is unaffected, and so is another operation.
      expect((await tokenizeAs(second)).res.statusCode).toBe(201);
      expect((await call(limited, first, '/v1/detokenize', { token: generateToken() })).res.statusCode).toBe(404);

      clock.advance(60_000);
      expect((await tokenizeAs(first)).res.statusCode).toBe(201);
    });
  });

  describe('TLS', () => {
    it('serves the API over HTTPS and not over plain HTTP', async () => {
      await app.listen(0, '127.0.0.1');
      const { port } = app.getHttpServer().address() as { port: number };
      const ca = readFileSync(env.TLS_CERT_PATH);
      const payload = JSON.stringify({ dataType: 'BVN', value: bvn() });

      const status = await new Promise<number>((done, fail) => {
        const req = httpsRequest(
          {
            host: '127.0.0.1',
            port,
            servername: 'localhost',
            ca,
            method: 'POST',
            path: '/v1/tokenize',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.key}` },
          },
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
    });

    it('refuses to start when the key layer cannot unlock, without leaking key material', async () => {
      const { MASTER_KEK_FILE: _f, ...noKek } = env;
      const wrongKek = '0'.repeat(64);
      for (const [bad, message] of [
        [noKek, 'no KEK'],
        [{ ...noKek, MASTER_KEK: wrongKek }, 'failed to unwrap'],
        [{ ...env, MASTER_KEK: keys.kekHex }, 'only one of'],
        [{ ...env, MASTER_KEY_FILE: `${keys.keyFile}.missing` }, 'missing or unreadable'],
      ] as const) {
        const error = await createApp(bad, { nestLogger: captureNestLogger }).catch((e: Error) => e);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(message);
        expect(keys.secrets().filter((s) => (error as Error).message.includes(s))).toEqual([]);
      }
    });

    it('takes the KEK from MASTER_KEK and removes it from process.env', async () => {
      const { MASTER_KEK_FILE: _f, ...inlineEnv } = env;
      process.env.MASTER_KEK = keys.kekHex;
      const inline = await startApp({ MASTER_KEK: keys.kekHex }, undefined, inlineEnv);
      try {
        expect(process.env.MASTER_KEK).toBeUndefined();
        const token = (await call(inline, alice, '/v1/tokenize', { dataType: 'BVN', value: bvn() })).res.json().token;
        expect((await call(inline, alice, '/v1/detokenize', { token })).res.statusCode).toBe(200);
      } finally {
        delete process.env.MASTER_KEK;
        await inline.close();
      }
    });

    it('refuses an invalid RATE_LIMIT_PER_MINUTE', async () => {
      await expect(
        createApp({ ...env, RATE_LIMIT_PER_MINUTE: 'lots' }, { nestLogger: captureNestLogger }),
      ).rejects.toThrow('RATE_LIMIT_PER_MINUTE');
    });
  });

  describe('no identifiers or keys leak', () => {
    it('never writes a synthetic BVN, an API key, the KEK or a master key to any audit row', async () => {
      const rows = JSON.stringify(
        await db.auditLog.findMany({ select: { token: true, credentialId: true, operation: true, outcome: true } }),
      );
      expect(sentBvns.size).toBeGreaterThan(20);
      expect([...sentBvns].filter((v) => rows.includes(v))).toHaveLength(0);
      expect([...issuedKeys].filter((k) => rows.includes(k))).toHaveLength(0);
      expect(keys.secrets().filter((s) => rows.includes(s))).toHaveLength(0);
    });

    it('never writes a synthetic BVN, an API key, the KEK or a master key to any log line', () => {
      const all = logLines.join('\n');
      expect(all).toContain('request completed');
      expect([...sentBvns].filter((v) => all.includes(v))).toHaveLength(0);
      expect([...issuedKeys].filter((k) => all.includes(k))).toHaveLength(0);
      expect(keys.secrets().filter((s) => all.includes(s))).toHaveLength(0);
    });
  });
});
