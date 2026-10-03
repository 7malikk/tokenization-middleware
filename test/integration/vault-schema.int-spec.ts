import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { decrypt, encrypt, generateDataKey, generateToken, unwrapKey, wrapKey, zeroize } from '../../src/crypto/crypto';
import { syntheticBvn } from '../helpers/synthetic-bvn';

// Tests in this file run in order: the first one builds the schema the others use.

const ROOT = resolve(__dirname, '../..');
const PRISMA_BIN = resolve(ROOT, 'node_modules/.bin/prisma');

function prisma(...args: string[]): void {
  execFileSync(PRISMA_BIN, args, {
    cwd: ROOT,
    env: process.env,
    stdio: 'pipe',
  });
}

describe('vault schema (PostgreSQL)', () => {
  let db: PrismaClient;

  beforeAll(() => {
    db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('applies all migrations to an empty database', async () => {
    // Drops everything in the test database (creating it if needed), then
    // applies every migration in prisma/migrations from scratch.
    prisma('migrate', 'reset', '--force', '--skip-seed', '--skip-generate');

    // Exit code 0 means no pending or failed migrations.
    prisma('migrate', 'status');

    // Exit code 0 means the migrated database matches schema.prisma exactly.
    prisma(
      'migrate', 'diff',
      '--from-url', process.env.DATABASE_URL as string,
      '--to-schema-datamodel', 'prisma/schema.prisma',
      '--exit-code',
    );

    // Every table exists and starts empty.
    expect(await db.application.count()).toBe(0);
    expect(await db.apiCredential.count()).toBe(0);
    expect(await db.credentialScope.count()).toBe(0);
    expect(await db.vaultRecord.count()).toBe(0);
    expect(await db.auditLog.count()).toBe(0);
  });

  describe('vault records', () => {
    const masterKey = generateDataKey();
    let appId: string;

    beforeAll(async () => {
      const app = await db.application.create({ data: { name: `int-test-${generateToken()}` } });
      appId = app.id;
    });

    async function storeRecord(bvn: string) {
      const dataKey = generateDataKey();
      const { ciphertext, iv, authTag } = encrypt(Buffer.from(bvn), dataKey);
      const wrappedDataKey = wrapKey(dataKey, masterKey);
      zeroize(dataKey);
      const token = generateToken();
      const sent = { token, appId, dataType: 'BVN', ciphertext, iv, authTag, wrappedDataKey };
      await db.vaultRecord.create({ data: sent });
      return sent;
    }

    it('round-trips every byte field through Prisma unchanged', async () => {
      const bvn = syntheticBvn();
      const sent = await storeRecord(bvn);

      const row = await db.vaultRecord.findUniqueOrThrow({ where: { token: sent.token } });

      expect(row.token).toBe(sent.token);
      expect(row.appId).toBe(appId);
      expect(row.dataType).toBe('BVN');
      expect(row.masterKeyVersion).toBe(1);
      expect(row.erasedAt).toBeNull();
      expect(Buffer.from(row.ciphertext).equals(sent.ciphertext)).toBe(true);
      expect(Buffer.from(row.iv).equals(sent.iv)).toBe(true);
      expect(Buffer.from(row.authTag).equals(sent.authTag)).toBe(true);
      expect(row.wrappedDataKey).not.toBeNull();
      expect(Buffer.from(row.wrappedDataKey as Uint8Array).equals(sent.wrappedDataKey)).toBe(true);

      // The stored fields are enough to recover the BVN with the master key.
      const dataKey = unwrapKey(Buffer.from(row.wrappedDataKey as Uint8Array), masterKey);
      const plaintext = decrypt(
        { ciphertext: Buffer.from(row.ciphertext), iv: Buffer.from(row.iv), authTag: Buffer.from(row.authTag) },
        dataKey,
      );
      zeroize(dataKey);
      expect(plaintext.equals(Buffer.from(bvn))).toBe(true);
    });

    it('erasure nulls the wrapped key but leaves the row, token, and ciphertext intact', async () => {
      const sent = await storeRecord(syntheticBvn());

      const before = new Date();
      await db.vaultRecord.update({
        where: { token: sent.token },
        data: { wrappedDataKey: null, erasedAt: new Date() },
      });

      const row = await db.vaultRecord.findUnique({ where: { token: sent.token } });

      expect(row).not.toBeNull();
      expect(row!.token).toBe(sent.token);
      expect(row!.appId).toBe(appId);
      expect(row!.wrappedDataKey).toBeNull();
      expect(row!.erasedAt).toBeInstanceOf(Date);
      expect(row!.erasedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
      expect(Buffer.from(row!.ciphertext).equals(sent.ciphertext)).toBe(true);
      expect(Buffer.from(row!.iv).equals(sent.iv)).toBe(true);
      expect(Buffer.from(row!.authTag).equals(sent.authTag)).toBe(true);
    });
  });

  describe('audit log foreign key', () => {
    async function credentialWithAuditRow() {
      const app = await db.application.create({ data: { name: `int-test-${generateToken()}` } });
      // No scopes, so the audit row is the only thing referencing the credential.
      const credential = await db.apiCredential.create({
        data: { appId: app.id, keyHash: createHash('sha256').update(generateToken()).digest() },
      });
      const audit = await db.auditLog.create({
        data: {
          credentialId: credential.id,
          operation: 'DETOKENIZE',
          token: generateToken(),
          outcome: 'SUCCESS',
        },
      });
      return { credential, audit };
    }

    async function expectRestrictViolation(action: Promise<unknown>) {
      const error = await action.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      const known = error as Prisma.PrismaClientKnownRequestError;
      expect(known.code).toBe('P2003');
      expect(known.meta?.constraint).toBe('audit_log_credential_id_fkey');
    }

    it('blocks deleting a credential that has audit rows, leaving the row unchanged', async () => {
      const { credential, audit } = await credentialWithAuditRow();

      await expectRestrictViolation(db.apiCredential.delete({ where: { id: credential.id } }));

      expect(await db.apiCredential.findUnique({ where: { id: credential.id } })).not.toBeNull();
      expect(await db.auditLog.findUniqueOrThrow({ where: { id: audit.id } })).toEqual(audit);
    });

    it('blocks changing the id of a credential that has audit rows', async () => {
      const { credential, audit } = await credentialWithAuditRow();

      await expectRestrictViolation(
        db.apiCredential.update({ where: { id: credential.id }, data: { id: randomUUID() } }),
      );

      expect(await db.auditLog.findUniqueOrThrow({ where: { id: audit.id } })).toEqual(audit);
    });
  });
});
