import { Test } from '@nestjs/testing';
import { VaultRecord } from '@prisma/client';
import { AuditModule } from '../../src/audit/audit.module';
import { AuditTrail, Caller } from '../../src/auth/request-context';
import { createApplication, createCredential } from '../../src/cli/admin';
import { runCli } from '../../src/cli/main';
import { EnvModule } from '../../src/config/env';
import { readKeyFile } from '../../src/keys/key-file';
import { rotateMasterKey } from '../../src/keys/rotate';
import { createPrismaClient, PrismaDb } from '../../src/prisma/prisma';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { VaultModule } from '../../src/vault/vault.module';
import { VaultService } from '../../src/vault/vault.service';
import { resetTestDatabase } from '../helpers/prisma-cli';
import { syntheticBvn } from '../helpers/synthetic-bvn';
import { TestKeys } from '../helpers/test-keys';

// Rotation rewraps every live record in the vault, so this suite needs a vault
// holding only records made with its own key file. It starts from an empty
// test database. Tests in this file run in order and build on each other.

describe('master key rotation (PostgreSQL)', () => {
  const keys = new TestKeys();
  const values = new Map<string, string>(); // token -> synthetic BVN
  const erased = new Set<string>();
  const cliOutput: string[] = [];
  let db: PrismaDb;
  let caller: Caller;

  const trail = (operation: AuditTrail['operation'], token: string | null = null): AuditTrail => ({
    operation,
    credentialId: caller.credentialId,
    token,
    recorded: false,
  });

  /** Start the vault as a server would (loading the key file), run fn, shut down. */
  async function withVault<T>(fn: (vault: VaultService) => Promise<T>): Promise<T> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        EnvModule.forRoot({ DATABASE_URL: process.env.DATABASE_URL, ...keys.env() }),
        PrismaModule,
        AuditModule,
        VaultModule,
      ],
    }).compile();
    await moduleRef.init();
    try {
      return await fn(moduleRef.get(VaultService));
    } finally {
      await moduleRef.close();
    }
  }

  async function tokenizeMany(count: number): Promise<void> {
    await withVault(async (vault) => {
      for (let i = 0; i < count; i++) {
        const value = syntheticBvn();
        values.set(await vault.tokenize(caller, trail('TOKENIZE'), 'BVN', value), value);
      }
    });
  }

  async function eraseSome(count: number): Promise<void> {
    const live = [...values.keys()].filter((t) => !erased.has(t)).slice(0, count);
    await withVault(async (vault) => {
      for (const token of live) {
        expect(await vault.erase(caller, trail('ERASE', token), token)).toEqual({ found: true });
        erased.add(token);
      }
    });
  }

  async function snapshot(): Promise<Map<string, VaultRecord>> {
    return new Map((await db.vaultRecord.findMany()).map((r) => [r.token, r]));
  }

  async function versions(): Promise<Record<number, number>> {
    const groups = await db.vaultRecord.groupBy({
      by: ['masterKeyVersion'],
      where: { erasedAt: null },
      _count: { _all: true },
    });
    return Object.fromEntries(groups.map((g) => [g.masterKeyVersion, g._count._all]));
  }

  async function expectEveryLiveRecordDetokenizes(): Promise<void> {
    await withVault(async (vault) => {
      for (const [token, value] of values) {
        if (erased.has(token)) continue;
        const result = await vault.detokenize(caller, trail('DETOKENIZE', token), token);
        expect(result.found && result.value === value).toBe(true);
      }
    });
  }

  function expectUntouchedExceptKey(before: Map<string, VaultRecord>, after: Map<string, VaultRecord>, version: number) {
    for (const [token, old] of before) {
      const now = after.get(token) as VaultRecord;
      expect(Buffer.from(now.ciphertext).equals(Buffer.from(old.ciphertext))).toBe(true);
      expect(Buffer.from(now.iv).equals(Buffer.from(old.iv))).toBe(true);
      expect(Buffer.from(now.authTag).equals(Buffer.from(old.authTag))).toBe(true);
      expect(now.appId).toBe(old.appId);
      if (erased.has(token)) {
        expect(now).toEqual(old); // skipped entirely
      } else {
        expect(now.masterKeyVersion).toBe(version);
      }
    }
  }

  beforeAll(async () => {
    resetTestDatabase();
    db = createPrismaClient(process.env.DATABASE_URL);
    const app = await createApplication(db, 'rotation');
    const { id } = await createCredential(db, app.id, ['TOKENIZE', 'DETOKENIZE', 'ERASE']);
    caller = { appId: app.id, credentialId: id };
  });

  afterAll(async () => {
    await db.$disconnect();
    keys.cleanup();
  });

  it('rotates every live record to v2 without touching ciphertext, iv or tag, and skips erased records', async () => {
    await tokenizeMany(23);
    await eraseSome(4);
    expect(await versions()).toEqual({ 1: 19 });
    const before = await snapshot();

    const ctx = {
      env: keys.env('inline'),
      db: () => db,
      io: { out: (l: string) => cliOutput.push(l), err: (l: string) => cliOutput.push(l) },
    };
    expect(await runCli(['key:rotate'], ctx)).toBe(0);
    expect(cliOutput).toEqual(
      expect.arrayContaining(['ACTIVE_VERSION=2', 'ROTATED_RECORDS=19', 'ERASED_RECORDS_SKIPPED=4']),
    );
    keys.refreshSecrets();

    const file = readKeyFile(keys.keyFile);
    expect(file.active).toBe(2);
    expect(file.keys.map((k) => k.version)).toEqual([1, 2]);
    expect(await versions()).toEqual({ 2: 19 });
    const after = await snapshot();
    expectUntouchedExceptKey(before, after, 2);
    for (const token of before.keys()) {
      if (!erased.has(token)) {
        const was = Buffer.from(before.get(token)!.wrappedDataKey as Uint8Array);
        expect(Buffer.from(after.get(token)!.wrappedDataKey as Uint8Array).equals(was)).toBe(false);
      }
    }

    await expectEveryLiveRecordDetokenizes();
  });

  it('wraps records tokenized after rotation under v2', async () => {
    await tokenizeMany(1);
    expect(await versions()).toEqual({ 2: 20 });
  });

  it('finishes an interrupted rotation when re-run, without adding another version', async () => {
    await tokenizeMany(12);
    const before = await snapshot();
    const live = 32;
    expect(await versions()).toEqual({ 2: live });

    // Simulate a crash after two committed batches of five.
    await expect(
      rotateMasterKey(db, keys.keyFile, Buffer.from(keys.kekHex, 'hex'), {
        batchSize: 5,
        afterBatch: (rotated) => {
          if (rotated >= 10) throw new Error('simulated crash');
        },
      }),
    ).rejects.toThrow('simulated crash');
    keys.refreshSecrets();
    expect(readKeyFile(keys.keyFile).active).toBe(3);
    expect(await versions()).toEqual({ 2: live - 10, 3: 10 });

    // A restarted server can serve every record in this mixed state.
    await expectEveryLiveRecordDetokenizes();

    const result = await rotateMasterKey(db, keys.keyFile, Buffer.from(keys.kekHex, 'hex'), { batchSize: 5 });
    expect(result).toEqual({ version: 3, resumed: true, rotated: live - 10, erasedSkipped: 4 });
    expect(readKeyFile(keys.keyFile).keys.map((k) => k.version)).toEqual([1, 2, 3]);
    expect(await versions()).toEqual({ 3: live });
    expectUntouchedExceptKey(before, await snapshot(), 3);
    await expectEveryLiveRecordDetokenizes();
  });

  it('adds a new version on the next run once nothing is pending', async () => {
    const result = await rotateMasterKey(db, keys.keyFile, Buffer.from(keys.kekHex, 'hex'));
    keys.refreshSecrets();
    expect(result).toMatchObject({ version: 4, resumed: false, rotated: 32 });
    expect(await versions()).toEqual({ 4: 32 });
    await expectEveryLiveRecordDetokenizes();
  });

  it('never puts the KEK or a master key in an audit row or in CLI output', async () => {
    const rows = JSON.stringify(await db.auditLog.findMany(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    const output = cliOutput.join('\n');
    expect(keys.secrets().length).toBeGreaterThan(10);
    expect(keys.secrets().filter((s) => rows.includes(s) || output.includes(s))).toEqual([]);
    expect([...values.values()].filter((v) => rows.includes(v) || output.includes(v))).toEqual([]);
  });
});
