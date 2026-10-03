import { randomBytes } from 'node:crypto';
import { generateDataKey, WRAPPED_KEY_BYTES } from '../crypto/crypto';
import { DevKeyProvider } from './dev-key-provider';

const devEnv = () => ({ MASTER_KEY_DEV: randomBytes(32).toString('hex') });

describe('DevKeyProvider (temporary)', () => {
  it('wraps to 40 bytes at version 1 and unwraps back', async () => {
    const keys = new DevKeyProvider(devEnv());
    const dataKey = generateDataKey();
    const { wrapped, version } = await keys.wrap(dataKey);
    expect(wrapped.length).toBe(WRAPPED_KEY_BYTES);
    expect(version).toBe(1);
    expect((await keys.unwrap(wrapped, version)).equals(dataKey)).toBe(true);
  });

  it('rejects an unknown key version', async () => {
    const keys = new DevKeyProvider(devEnv());
    const { wrapped } = await keys.wrap(generateDataKey());
    await expect(keys.unwrap(wrapped, 2)).rejects.toThrow('unknown master key version');
  });

  it('cannot unwrap keys wrapped under a different master key', async () => {
    const { wrapped, version } = await new DevKeyProvider(devEnv()).wrap(generateDataKey());
    await expect(new DevKeyProvider(devEnv()).unwrap(wrapped, version)).rejects.toThrow('key unwrap failed');
  });

  it('refuses to start when NODE_ENV=production', () => {
    expect(() => new DevKeyProvider({ ...devEnv(), NODE_ENV: 'production' })).toThrow(
      'DevKeyProvider must not run when NODE_ENV=production',
    );
  });

  it('refuses a missing or malformed MASTER_KEY_DEV', () => {
    expect(() => new DevKeyProvider({})).toThrow('MASTER_KEY_DEV');
    expect(() => new DevKeyProvider({ MASTER_KEY_DEV: 'ab'.repeat(16) })).toThrow('MASTER_KEY_DEV');
  });

  it('does not expose the master key as a property', () => {
    const env = devEnv();
    const keys = new DevKeyProvider(env);
    expect(JSON.stringify(keys)).not.toContain(env.MASTER_KEY_DEV);
    expect(Object.values(keys)).toHaveLength(0);
  });
});
