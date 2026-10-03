import { createHash, randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { AuditModule } from '../../src/audit/audit.module';
import { AuditTrail, Caller } from '../../src/auth/request-context';
import { EnvModule } from '../../src/config/env';
import { generateToken } from '../../src/crypto/crypto';
import { PrismaDb } from '../../src/prisma/prisma';
import { PRISMA, PrismaModule } from '../../src/prisma/prisma.module';
import { VaultModule } from '../../src/vault/vault.module';
import { VaultService } from '../../src/vault/vault.service';
import { syntheticBvn } from '../helpers/synthetic-bvn';

describe('VaultService (PostgreSQL)', () => {
  let vault: VaultService;
  let db: PrismaDb;
  let close: () => Promise<void>;
  let callerA: Caller;
  let callerB: Caller;

  const trail = (caller: Caller, operation: AuditTrail['operation'], token: string | null = null): AuditTrail => ({
    operation,
    credentialId: caller.credentialId,
    token,
    recorded: false,
  });

  async function newCaller(prefix: string): Promise<Caller> {
    const app = await db.application.create({ data: { name: `${prefix}-${generateToken()}` } });
    const credential = await db.apiCredential.create({
      data: { appId: app.id, keyHash: createHash('sha256').update(generateToken()).digest() },
    });
    return { appId: app.id, credentialId: credential.id };
  }

  beforeAll(async () => {
    const env = {
      DATABASE_URL: process.env.DATABASE_URL,
      MASTER_KEY_DEV: randomBytes(32).toString('hex'),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [EnvModule.forRoot(env), PrismaModule, AuditModule, VaultModule],
    }).compile();
    await moduleRef.init();
    close = () => moduleRef.close();
    vault = moduleRef.get(VaultService);
    db = moduleRef.get(PRISMA);

    callerA = await newCaller('svc-a');
    callerB = await newCaller('svc-b');
  });

  afterAll(async () => {
    await close();
  });

  it("owner check: app B cannot detokenize or erase app A's token, and the record is untouched", async () => {
    const bvn = syntheticBvn();
    const token = await vault.tokenize(callerA, trail(callerA, 'TOKENIZE'), 'BVN', bvn);
    const before = await db.vaultRecord.findUniqueOrThrow({ where: { token } });

    const detok = trail(callerB, 'DETOKENIZE', token);
    expect(await vault.detokenize(callerB, detok, token)).toEqual({ found: false, reason: 'NOT_OWNER' });
    expect(detok.recorded).toBe(true);
    const erase = trail(callerB, 'ERASE', token);
    expect(await vault.erase(callerB, erase, token)).toEqual({ found: false, reason: 'NOT_OWNER' });
    expect(erase.recorded).toBe(true);

    const after = await db.vaultRecord.findUniqueOrThrow({ where: { token } });
    expect(after).toEqual(before);
    expect(after.erasedAt).toBeNull();

    // The owner still gets the original value back.
    const own = await vault.detokenize(callerA, trail(callerA, 'DETOKENIZE', token), token);
    expect(own.found && own.value === bvn).toBe(true);
  });

  it('reports the true reason for each kind of miss, and audits each one', async () => {
    const token = await vault.tokenize(callerA, trail(callerA, 'TOKENIZE'), 'BVN', syntheticBvn());
    const unknown = generateToken();
    expect(await vault.detokenize(callerA, trail(callerA, 'DETOKENIZE', unknown), unknown)).toEqual({
      found: false,
      reason: 'NOT_FOUND',
    });

    expect(await vault.erase(callerA, trail(callerA, 'ERASE', token), token)).toEqual({ found: true });
    expect(await vault.detokenize(callerA, trail(callerA, 'DETOKENIZE', token), token)).toEqual({
      found: false,
      reason: 'ERASED',
    });
    expect(await vault.erase(callerA, trail(callerA, 'ERASE', token), token)).toEqual({
      found: false,
      reason: 'ERASED',
    });
    // Another app probing an erased token still learns only "not yours".
    expect(await vault.detokenize(callerB, trail(callerB, 'DETOKENIZE', token), token)).toEqual({
      found: false,
      reason: 'NOT_OWNER',
    });

    const rows = await db.auditLog.findMany({ where: { token }, orderBy: { id: 'asc' } });
    expect(rows.map((r) => [r.operation, r.outcome])).toEqual([
      ['TOKENIZE', 'SUCCESS'],
      ['ERASE', 'SUCCESS'],
      ['DETOKENIZE', 'ERASED'],
      ['ERASE', 'ERASED'],
      ['DETOKENIZE', 'NOT_OWNER'],
    ]);
  });
});
