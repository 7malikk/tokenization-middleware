import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { EnvModule } from '../../src/config/env';
import { generateToken } from '../../src/crypto/crypto';
import { PrismaService } from '../../src/prisma/prisma.service';
import { VaultModule } from '../../src/vault/vault.module';
import { VaultService } from '../../src/vault/vault.service';
import { syntheticBvn } from '../helpers/synthetic-bvn';

describe('VaultService (PostgreSQL)', () => {
  let vault: VaultService;
  let db: PrismaService;
  let close: () => Promise<void>;
  let appA: string;
  let appB: string;

  beforeAll(async () => {
    const env = {
      DATABASE_URL: process.env.DATABASE_URL,
      MASTER_KEY_DEV: randomBytes(32).toString('hex'),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [EnvModule.forRoot(env), VaultModule],
    }).compile();
    await moduleRef.init();
    close = () => moduleRef.close();
    vault = moduleRef.get(VaultService);
    db = moduleRef.get(PrismaService);

    appA = (await db.application.create({ data: { name: `svc-a-${generateToken()}` } })).id;
    appB = (await db.application.create({ data: { name: `svc-b-${generateToken()}` } })).id;
  });

  afterAll(async () => {
    await close();
  });

  it("owner check: app B cannot detokenize or erase app A's token, and the record is untouched", async () => {
    const bvn = syntheticBvn();
    const token = await vault.tokenize(appA, 'BVN', bvn);
    const before = await db.vaultRecord.findUniqueOrThrow({ where: { token } });

    expect(await vault.detokenize(appB, token)).toEqual({ found: false, reason: 'NOT_OWNER' });
    expect(await vault.erase(appB, token)).toEqual({ found: false, reason: 'NOT_OWNER' });

    const after = await db.vaultRecord.findUniqueOrThrow({ where: { token } });
    expect(after).toEqual(before);
    expect(after.erasedAt).toBeNull();

    // The owner still gets the original value back.
    const own = await vault.detokenize(appA, token);
    expect(own.found && own.value === bvn).toBe(true);
  });

  it('reports the true reason for each kind of miss', async () => {
    const token = await vault.tokenize(appA, 'BVN', syntheticBvn());
    expect(await vault.detokenize(appA, generateToken())).toEqual({ found: false, reason: 'NOT_FOUND' });

    expect(await vault.erase(appA, token)).toEqual({ found: true });
    expect(await vault.detokenize(appA, token)).toEqual({ found: false, reason: 'ERASED' });
    expect(await vault.erase(appA, token)).toEqual({ found: false, reason: 'ERASED' });
    // Another app probing an erased token still learns only "not yours".
    expect(await vault.detokenize(appB, token)).toEqual({ found: false, reason: 'NOT_OWNER' });
  });
});
