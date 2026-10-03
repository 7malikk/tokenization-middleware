import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestKeys } from '../../test/helpers/test-keys';
import { CliContext, runCli } from '../cli/main';
import { generateDataKey, unwrapKey, WRAPPED_KEY_BYTES } from '../crypto/crypto';
import { FileKeyProvider } from './file-key-provider';
import { generateKekHex, KeyFile, readKeyFile, replaceKeyFile, unlockKeyFile, wrapMasterKey } from './key-file';

describe('key file and FileKeyProvider', () => {
  let keys: TestKeys;

  beforeEach(() => {
    keys = new TestKeys();
  });

  afterEach(() => {
    keys.cleanup();
    delete process.env.MASTER_KEK;
  });

  /** Constructing the provider must fail with this message, and the message must hold no secret. */
  function expectRefusal(env: Record<string, string>, message: string | RegExp, extraSecrets: string[] = []) {
    let error: unknown;
    try {
      new FileKeyProvider(env);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    const text = `${(error as Error).message} ${(error as Error).stack ?? ''}`;
    expect((error as Error).message).toMatch(message);
    const leaked = [...keys.secrets(), ...extraSecrets].filter((s) => text.includes(s));
    expect(leaked).toEqual([]);
  }

  describe('key:init', () => {
    it('writes a 0600 file whose only key is wrapped, never the master key itself', () => {
      const text = readFileSync(keys.keyFile, 'utf8');
      const file: KeyFile = JSON.parse(text);
      expect(file.active).toBe(1);
      expect(file.keys).toHaveLength(1);
      expect(file.keys[0].version).toBe(1);

      const wrapped = Buffer.from(file.keys[0].wrapped, 'hex');
      expect(wrapped.length).toBe(WRAPPED_KEY_BYTES);
      const masterKey = unwrapKey(wrapped, Buffer.from(keys.kekHex, 'hex'));
      expect(wrapped.equals(masterKey)).toBe(false);
      expect(text.includes(masterKey.toString('hex'))).toBe(false);
      expect(text.includes(masterKey.toString('base64'))).toBe(false);
      expect(text.includes(keys.kekHex)).toBe(false);
      expect(statSync(keys.keyFile).mode & 0o777).toBe(0o600);
    });

    it('refuses to overwrite an existing file', async () => {
      const before = readFileSync(keys.keyFile);
      const err: string[] = [];
      const ctx: CliContext = {
        env: keys.env('inline'),
        db: () => {
          throw new Error('not needed');
        },
        io: { out: () => undefined, err: (l) => err.push(l) },
      };
      expect(await runCli(['key:init'], ctx)).toBe(1);
      expect(err.join('\n')).toContain('already exists');
      expect(readFileSync(keys.keyFile).equals(before)).toBe(true);
    });

    it('creates a new file through the CLI from a generated KEK', async () => {
      const out: string[] = [];
      const err: string[] = [];
      const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
      const noDb = () => {
        throw new Error('not needed');
      };

      expect(await runCli(['key:generate-kek'], { env: {}, db: noDb, io })).toBe(0);
      expect(out).toHaveLength(1);
      const kekHex = out[0].replace(/^MASTER_KEK=/, '');
      expect(kekHex).toMatch(/^[0-9a-f]{64}$/);
      expect(err.join(' ')).toMatch(/safe/i);

      const path = join(keys.dir, 'fresh.json');
      const env = { MASTER_KEY_FILE: path, MASTER_KEK: kekHex };
      expect(await runCli(['key:init'], { env, db: noDb, io })).toBe(0);
      expect(existsSync(path)).toBe(true);
      expect(env.MASTER_KEK).toBeUndefined();
      expect(readFileSync(path, 'utf8').includes(kekHex)).toBe(false);
    });
  });

  describe('startup', () => {
    it('works with the KEK from MASTER_KEK and removes it from the environment', async () => {
      process.env.MASTER_KEK = keys.kekHex;
      const env = keys.env('inline');
      const provider = new FileKeyProvider(env);

      expect(env.MASTER_KEK).toBeUndefined();
      expect(process.env.MASTER_KEK).toBeUndefined();
      const dataKey = generateDataKey();
      const { wrapped, version } = await provider.wrap(dataKey);
      expect(version).toBe(1);
      expect((await provider.unwrap(wrapped, version)).equals(dataKey)).toBe(true);
    });

    it('works with the KEK from MASTER_KEK_FILE', async () => {
      const provider = new FileKeyProvider(keys.env('file'));
      const dataKey = generateDataKey();
      const { wrapped, version } = await provider.wrap(dataKey);
      expect((await provider.unwrap(wrapped, version)).equals(dataKey)).toBe(true);
    });

    it('refuses with no KEK', () => {
      expectRefusal({ MASTER_KEY_FILE: keys.keyFile }, 'no KEK');
    });

    it('refuses with both KEK sources set', () => {
      expectRefusal({ ...keys.env('file'), MASTER_KEK: keys.kekHex }, 'only one of MASTER_KEK and MASTER_KEK_FILE');
    });

    it('refuses a wrong KEK', () => {
      const wrong = generateKekHex();
      expectRefusal({ MASTER_KEY_FILE: keys.keyFile, MASTER_KEK: wrong }, /failed to unwrap/, [wrong]);
    });

    it('refuses a KEK that is not 64 hex chars, without echoing it', () => {
      const bad = keys.kekHex.slice(0, 40) + 'zz';
      expectRefusal({ MASTER_KEY_FILE: keys.keyFile, MASTER_KEK: bad }, /64 hex/, [bad]);
    });

    it('refuses an unreadable MASTER_KEK_FILE', () => {
      expectRefusal({ MASTER_KEY_FILE: keys.keyFile, MASTER_KEK_FILE: join(keys.dir, 'nope') }, 'could not be read');
    });

    it('refuses a tampered key file', () => {
      const file: KeyFile = JSON.parse(readFileSync(keys.keyFile, 'utf8'));
      const w = file.keys[0].wrapped;
      file.keys[0].wrapped = (w[0] === 'a' ? 'b' : 'a') + w.slice(1);
      writeFileSync(keys.keyFile, JSON.stringify(file));
      expectRefusal(keys.env(), /version 1 failed to unwrap: wrong KEK or tampered key file/, [w, file.keys[0].wrapped]);
    });

    it('refuses a missing key file', () => {
      rmSync(keys.keyFile);
      expectRefusal(keys.env(), 'missing or unreadable');
      expectRefusal({ MASTER_KEK_FILE: keys.kekFile }, 'MASTER_KEY_FILE is not set');
    });

    it.each([
      ['not JSON', (w: string) => `{"active":1,"keys":[{"version":1,"wrapped":"${w}"`],
      ['no active key', (w: string) => JSON.stringify({ active: 2, keys: [{ version: 1, wrapped: w }] })],
      ['short wrapped key', (w: string) => JSON.stringify({ active: 1, keys: [{ version: 1, wrapped: w.slice(2) }] })],
      ['duplicate version', (w: string) => JSON.stringify({ active: 1, keys: [{ version: 1, wrapped: w }, { version: 1, wrapped: w }] })],
      ['extra fields', (w: string) => JSON.stringify({ active: 1, keys: [{ version: 1, wrapped: w }], kek: 'x' })],
    ])('refuses a malformed key file (%s) without echoing its content', (_label, make) => {
      const wrapped = JSON.parse(readFileSync(keys.keyFile, 'utf8')).keys[0].wrapped as string;
      writeFileSync(keys.keyFile, make(wrapped));
      expectRefusal(keys.env(), /malformed/, [wrapped, wrapped.slice(2)]);
    });
  });

  describe('versions', () => {
    it('wraps under the active version and unwraps any version on record', async () => {
      const v1 = new FileKeyProvider(keys.env());
      const dataKey = generateDataKey();
      const underV1 = await v1.wrap(dataKey);

      const kek = Buffer.from(keys.kekHex, 'hex');
      const file = readKeyFile(keys.keyFile);
      replaceKeyFile(keys.keyFile, { active: 2, keys: [...file.keys, wrapMasterKey(2, generateDataKey(), kek)] });
      expect(unlockKeyFile(readKeyFile(keys.keyFile), kek).size).toBe(2);

      const v2 = new FileKeyProvider(keys.env());
      const underV2 = await v2.wrap(dataKey);
      expect(underV2.version).toBe(2);
      expect(underV2.wrapped.equals(underV1.wrapped)).toBe(false);
      expect((await v2.unwrap(underV1.wrapped, 1)).equals(dataKey)).toBe(true);
      expect((await v2.unwrap(underV2.wrapped, 2)).equals(dataKey)).toBe(true);
      await expect(v2.unwrap(underV2.wrapped, 3)).rejects.toThrow('unknown master key version');
    });

    it('holds no key material in enumerable properties', () => {
      const provider = new FileKeyProvider(keys.env());
      expect(Object.values(provider)).toHaveLength(0);
      const shown = JSON.stringify(provider);
      expect(keys.secrets().filter((s) => shown.includes(s))).toEqual([]);
    });
  });
});
