import { createHash } from 'node:crypto';
import { generateToken } from '../../src/crypto/crypto';
import { COMMANDS, runCli } from '../../src/cli/main';
import { AuditLogAppendOnlyError, createPrismaClient, PrismaDb } from '../../src/prisma/prisma';

/** Every row of every table, serialized with byte fields as hex and as text. */
async function dumpDatabase(db: PrismaDb): Promise<string> {
  const tables = await Promise.all([
    db.application.findMany(),
    db.apiCredential.findMany(),
    db.credentialScope.findMany(),
    db.vaultRecord.findMany(),
    db.auditLog.findMany(),
  ]);
  return JSON.stringify(tables, (_key, value) => {
    if (typeof value === 'bigint') return value.toString();
    if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
      const bytes = Buffer.from(value.data);
      return `${bytes.toString('hex')} ${bytes.toString('latin1')}`;
    }
    return value;
  });
}

describe('admin CLI and append-only audit log (PostgreSQL)', () => {
  let db: PrismaDb;

  beforeAll(() => {
    db = createPrismaClient({ DATABASE_URL: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  async function cli(...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, { env: {}, db: () => db, io: { out: (l) => out.push(l), err: (l) => err.push(l) } });
    const values = Object.fromEntries(out.map((line) => line.split('=', 2) as [string, string]));
    return { code, out, err, values };
  }

  describe('CLI', () => {
    it('creates an application and a scoped credential, then revokes it', async () => {
      const app = await cli('app:create', '--name', `cli-${generateToken()}`);
      expect(app.code).toBe(0);
      expect(app.values.APP_ID).toMatch(/^[0-9a-f-]{36}$/);

      const cred = await cli('cred:create', '--app', app.values.APP_ID, '--scopes', 'TOKENIZE,ERASE');
      expect(cred.code).toBe(0);
      const id = cred.values.CREDENTIAL_ID;
      const key = cred.values.API_KEY;
      expect(key).toMatch(/^tkm_[A-Za-z0-9_-]{43}$/);

      const stored = await db.apiCredential.findUniqueOrThrow({ where: { id }, include: { scopes: true } });
      expect(stored.appId).toBe(app.values.APP_ID);
      expect(stored.revokedAt).toBeNull();
      expect(stored.scopes.map((s) => s.operation).sort()).toEqual(['ERASE', 'TOKENIZE']);

      const revoke = await cli('cred:revoke', '--id', id);
      expect(revoke.code).toBe(0);
      const revoked = await db.apiCredential.findUniqueOrThrow({ where: { id } });
      expect(revoked.revokedAt).toBeInstanceOf(Date);

      // Revoking again keeps the original time; the row is never deleted.
      await cli('cred:revoke', '--id', id);
      expect((await db.apiCredential.findUniqueOrThrow({ where: { id } })).revokedAt).toEqual(revoked.revokedAt);
    });

    it('stores only SHA-256 of the issued key, and the key appears nowhere in the database', async () => {
      const app = await cli('app:create', '--name', `cli-hash-${generateToken()}`);
      const cred = await cli('cred:create', '--app', app.values.APP_ID, '--scopes', 'DETOKENIZE');
      const key = cred.values.API_KEY;

      const stored = await db.apiCredential.findUniqueOrThrow({ where: { id: cred.values.CREDENTIAL_ID } });
      const expected = createHash('sha256').update(key).digest();
      expect(Buffer.from(stored.keyHash).equals(expected)).toBe(true);

      const dump = await dumpDatabase(db);
      expect(dump.includes(key)).toBe(false);
      expect(dump.includes(key.slice(4))).toBe(false);
      expect(dump.includes(Buffer.from(key.slice(4), 'base64url').toString('hex'))).toBe(false);
    });

    it('rejects bad input and unknown commands, and has no delete command', async () => {
      expect((await cli('app:create')).code).toBe(1);
      expect((await cli('cred:create', '--app', 'not-a-uuid', '--scopes', 'TOKENIZE')).code).toBe(1);
      expect((await cli('cred:revoke', '--id', '00000000-0000-0000-0000-000000000000')).code).toBe(1);
      for (const command of ['app:delete', 'cred:delete', 'delete', 'toString', '__proto__']) {
        expect((await cli(command, '--id', '00000000-0000-0000-0000-000000000000')).code).toBe(2);
      }
      expect(Object.keys(COMMANDS).some((c) => /delete/i.test(c))).toBe(false);
    });
  });

  describe('append-only audit log extension', () => {
    async function auditRow() {
      const app = await db.application.create({ data: { name: `audit-${generateToken()}` } });
      const credential = await db.apiCredential.create({
        data: { appId: app.id, keyHash: createHash('sha256').update(generateToken()).digest() },
      });
      const row = await db.auditLog.create({
        data: { credentialId: credential.id, operation: 'DETOKENIZE', token: generateToken(), outcome: 'SUCCESS' },
      });
      return { row, credential };
    }

    const blocked: [string, (db: PrismaDb, id: bigint, credentialId: string) => Promise<unknown>][] = [
      ['update', (d, id) => d.auditLog.update({ where: { id }, data: { outcome: 'ERROR' } })],
      ['updateMany', (d, id) => d.auditLog.updateMany({ where: { id }, data: { outcome: 'ERROR' } })],
      ['updateManyAndReturn', (d, id) => d.auditLog.updateManyAndReturn({ where: { id }, data: { outcome: 'ERROR' } })],
      ['delete', (d, id) => d.auditLog.delete({ where: { id } })],
      ['deleteMany', (d, id) => d.auditLog.deleteMany({ where: { id } })],
      [
        'upsert',
        (d, id) =>
          d.auditLog.upsert({
            where: { id },
            update: { outcome: 'ERROR' },
            create: { operation: 'ERASE', outcome: 'ERROR' },
          }),
      ],
      [
        'nested deleteMany through apiCredential.update',
        (d, _id, credentialId) =>
          d.apiCredential.update({ where: { id: credentialId }, data: { auditLogs: { deleteMany: {} } } }),
      ],
      [
        'nested updateMany through apiCredential.update',
        (d, _id, credentialId) =>
          d.apiCredential.update({
            where: { id: credentialId },
            data: { auditLogs: { updateMany: { where: {}, data: { outcome: 'ERROR' } } } },
          }),
      ],
    ];

    it.each(blocked)('%s throws and leaves the row unchanged', async (_name, attempt) => {
      const { row, credential } = await auditRow();
      await expect(attempt(db, row.id, credential.id)).rejects.toThrow(AuditLogAppendOnlyError);
      expect(await db.auditLog.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    });

    it('is enforced inside interactive transactions too', async () => {
      const { row } = await auditRow();
      await expect(
        db.$transaction((tx) => tx.auditLog.delete({ where: { id: row.id } })),
      ).rejects.toThrow(AuditLogAppendOnlyError);
      expect(await db.auditLog.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    });

    it('still allows appending and reading', async () => {
      const { row } = await auditRow();
      expect(await db.auditLog.count({ where: { id: row.id } })).toBe(1);
    });
  });
});
