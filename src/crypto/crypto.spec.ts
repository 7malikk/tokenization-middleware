import { createHash, randomBytes } from 'node:crypto';
import { syntheticBvn } from '../../test/helpers/synthetic-bvn';
import {
  AUTH_TAG_BYTES,
  EncryptedPayload,
  IV_BYTES,
  KEY_BYTES,
  WRAPPED_KEY_BYTES,
  decrypt,
  encrypt,
  generateDataKey,
  generateToken,
  unwrapKey,
  wrapKey,
  zeroize,
} from './crypto';

// Assertions compare buffers with .equals() and assert on the boolean, so a
// failure never prints a BVN into test output.

function flipByte(buf: Buffer, index: number): Buffer {
  const copy = Buffer.from(buf);
  copy[index] ^= 0x01;
  return copy;
}

describe('syntheticBvn', () => {
  it('returns an 11-digit string', () => {
    for (let i = 0; i < 100; i++) {
      expect(/^\d{11}$/.test(syntheticBvn())).toBe(true);
    }
  });
});

describe('generateToken', () => {
  it('produces 10,000 tokens that are all 32 hex chars and all unique', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const token = generateToken();
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      tokens.add(token);
    }
    expect(tokens.size).toBe(10_000);
  });
});

describe('generateDataKey', () => {
  it('returns 32 random bytes, different each call', () => {
    const a = generateDataKey();
    const b = generateDataKey();
    expect(a.length).toBe(KEY_BYTES);
    expect(a.equals(b)).toBe(false);
  });
});

describe('encrypt / decrypt', () => {
  it('round-trips a synthetic BVN', () => {
    const bvn = Buffer.from(syntheticBvn());
    const key = generateDataKey();
    const payload = encrypt(bvn, key);

    expect(payload.iv.length).toBe(IV_BYTES);
    expect(payload.authTag.length).toBe(AUTH_TAG_BYTES);
    expect(payload.ciphertext.equals(bvn)).toBe(false);
    expect(decrypt(payload, key).equals(bvn)).toBe(true);
  });

  it('gives different IVs and ciphertexts for the same BVN encrypted twice', () => {
    const bvn = Buffer.from(syntheticBvn());
    const key = generateDataKey();
    const a = encrypt(bvn, key);
    const b = encrypt(bvn, key);

    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  describe('throws when any single byte is flipped', () => {
    const key = generateDataKey();
    const payload = encrypt(Buffer.from(syntheticBvn()), key);
    const fields: (keyof EncryptedPayload)[] = ['ciphertext', 'iv', 'authTag'];

    it.each(fields)('in %s, at every position', (field) => {
      for (let i = 0; i < payload[field].length; i++) {
        const tampered = { ...payload, [field]: flipByte(payload[field], i) };
        expect(() => decrypt(tampered, key)).toThrow('decryption failed');
      }
    });
  });

  it('throws when decrypting with a different data key', () => {
    const payload = encrypt(Buffer.from(syntheticBvn()), generateDataKey());
    expect(() => decrypt(payload, generateDataKey())).toThrow('decryption failed');
  });

  it('rejects a truncated auth tag instead of accepting a shorter tag', () => {
    const key = generateDataKey();
    const payload = encrypt(Buffer.from(syntheticBvn()), key);
    const truncated = { ...payload, authTag: payload.authTag.subarray(0, 12) };
    expect(() => decrypt(truncated, key)).toThrow('invalid auth tag');
  });

  it('rejects data keys that are not 32 bytes', () => {
    expect(() => encrypt(Buffer.from(syntheticBvn()), randomBytes(16))).toThrow('invalid data key');
  });
});

describe('wrapKey / unwrapKey (AES-KW)', () => {
  it('matches the RFC 3394 section 4.6 test vector', () => {
    const kek = Buffer.from(
      '000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F',
      'hex',
    );
    const keyData = Buffer.from(
      '00112233445566778899AABBCCDDEEFF000102030405060708090A0B0C0D0E0F',
      'hex',
    );
    const expected = Buffer.from(
      '28C9F404C4B810F4CBCCB35CFB87F8263F5786E2D80ED326CBC7F0E71A99F43BFB988B9B7A02DD21',
      'hex',
    );

    const wrapped = wrapKey(keyData, kek);
    expect(wrapped.toString('hex')).toBe(expected.toString('hex'));
    expect(unwrapKey(wrapped, kek).equals(keyData)).toBe(true);
  });

  it('returns 40 bytes and round-trips', () => {
    const masterKey = generateDataKey();
    const dataKey = generateDataKey();
    const wrapped = wrapKey(dataKey, masterKey);

    expect(wrapped.length).toBe(WRAPPED_KEY_BYTES);
    expect(unwrapKey(wrapped, masterKey).equals(dataKey)).toBe(true);
  });

  it('throws when unwrapping with the wrong master key', () => {
    const wrapped = wrapKey(generateDataKey(), generateDataKey());
    expect(() => unwrapKey(wrapped, generateDataKey())).toThrow('key unwrap failed');
  });

  it('throws when unwrapping a tampered wrapped key, at every position', () => {
    const masterKey = generateDataKey();
    const wrapped = wrapKey(generateDataKey(), masterKey);
    for (let i = 0; i < wrapped.length; i++) {
      expect(() => unwrapKey(flipByte(wrapped, i), masterKey)).toThrow('key unwrap failed');
    }
  });
});

describe('zeroize', () => {
  it('overwrites every byte with zero', () => {
    const key = generateDataKey();
    zeroize(key);
    expect(key.equals(Buffer.alloc(KEY_BYTES))).toBe(true);
  });
});

describe('envelope encryption properties', () => {
  // Mirrors what tokenize will do: fresh data key, encrypt, wrap, zeroize.
  function sealRecord(bvn: string, masterKey: Buffer) {
    const dataKey = generateDataKey();
    const payload = encrypt(Buffer.from(bvn), dataKey);
    const wrappedDataKey = wrapKey(dataKey, masterKey);
    zeroize(dataKey);
    return { ...payload, wrappedDataKey };
  }

  it("per-record isolation: record A's data key cannot decrypt record B", () => {
    const masterKey = generateDataKey();
    const bvn = syntheticBvn();
    // Same BVN in both records, so only the key separates them.
    const recordA = sealRecord(bvn, masterKey);
    const recordB = sealRecord(bvn, masterKey);

    const keyA = unwrapKey(recordA.wrappedDataKey, masterKey);
    const keyB = unwrapKey(recordB.wrappedDataKey, masterKey);

    expect(keyA.equals(keyB)).toBe(false);
    expect(decrypt(recordA, keyA).equals(Buffer.from(bvn))).toBe(true);
    expect(() => decrypt(recordB, keyA)).toThrow('decryption failed');
    expect(() => decrypt(recordA, keyB)).toThrow('decryption failed');
  });

  it('erased record: without the wrapped key, every decryption attempt fails', () => {
    const masterKey = generateDataKey();
    const { ciphertext, iv, authTag } = sealRecord(syntheticBvn(), masterKey);
    // Erasure drops wrappedDataKey. Only these survive.
    const erased: EncryptedPayload = { ciphertext, iv, authTag };

    const candidateKeys: Buffer[] = [
      masterKey,
      Buffer.alloc(KEY_BYTES),
      Buffer.alloc(KEY_BYTES, 0xff),
      createHash('sha256').update(masterKey).digest(),
      ...Array.from({ length: 1000 }, () => generateDataKey()),
    ];
    for (const candidate of candidateKeys) {
      expect(() => decrypt(erased, candidate)).toThrow('decryption failed');
    }

    // Nothing left in the row can be unwrapped into a data key either.
    for (const field of [ciphertext, iv, authTag]) {
      expect(() => unwrapKey(field, masterKey)).toThrow();
    }
  });
});
