import { createHash } from 'node:crypto';
import { generateApiKey, hashApiKey, parseBearerKey } from './api-key';

describe('API keys', () => {
  it('are tkm_ plus 32 random bytes in base64url', () => {
    const keys = new Set(Array.from({ length: 1000 }, generateApiKey));
    expect(keys.size).toBe(1000);
    for (const key of keys) {
      expect(key).toMatch(/^tkm_[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(key.slice(4), 'base64url').length).toBe(32);
    }
  });

  it('hash to SHA-256 of the whole key', () => {
    const key = generateApiKey();
    expect(hashApiKey(key).equals(createHash('sha256').update(key).digest())).toBe(true);
  });

  it('are read only from a well-formed Bearer header', () => {
    const key = generateApiKey();
    expect(parseBearerKey(`Bearer ${key}`)).toBe(key);
    for (const bad of [
      undefined,
      '',
      key,
      `bearer ${key}`,
      `Basic ${key}`,
      `Bearer  ${key}`,
      `Bearer ${key} extra`,
      `Bearer ${key}x`,
      `Bearer ${key.slice(0, -1)}`,
      `Bearer abc_${key.slice(4)}`,
      [`Bearer ${key}`],
    ]) {
      expect(parseBearerKey(bad)).toBeNull();
    }
  });
});
