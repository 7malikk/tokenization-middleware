import { Test } from '@nestjs/testing';
import { syntheticBvn } from '../../test/helpers/synthetic-bvn';
import { CryptoModule } from './crypto.module';
import { CryptoService } from './crypto.service';

describe('CryptoService', () => {
  let crypto: CryptoService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [CryptoModule] }).compile();
    crypto = moduleRef.get(CryptoService);
  });

  it('is injectable and exposes the full envelope round trip', () => {
    const bvn = Buffer.from(syntheticBvn());
    const masterKey = crypto.generateDataKey();
    const dataKey = crypto.generateDataKey();

    const payload = crypto.encrypt(bvn, dataKey);
    const wrapped = crypto.wrapKey(dataKey, masterKey);
    crypto.zeroize(dataKey);

    const recovered = crypto.unwrapKey(wrapped, masterKey);
    expect(crypto.decrypt(payload, recovered).equals(bvn)).toBe(true);
    expect(crypto.generateToken()).toMatch(/^[0-9a-f]{32}$/);
  });
});
