import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDatabaseUrl } from './database-url';

describe('resolveDatabaseUrl', () => {
  let dir: string;
  let passwordFile: string;
  const password = 'p@ss/w:rd?#&=generated';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'db-url-'));
    passwordFile = join(dir, 'pw');
    writeFileSync(passwordFile, `${password}\n`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fromFile = (extra: Record<string, string> = {}) => ({
    DATABASE_PASSWORD_FILE: passwordFile,
    DATABASE_HOST: 'vault-db',
    DATABASE_NAME: 'vault',
    DATABASE_USER: 'vault',
    DATABASE_SCHEMA: 'vault',
    ...extra,
  });

  it('uses DATABASE_URL unchanged for native runs', () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: 'postgresql://u@localhost:5432/vault' })).toBe(
      'postgresql://u@localhost:5432/vault',
    );
  });

  it('builds the URL from the password file, encoding the password', () => {
    const url = resolveDatabaseUrl(fromFile());
    expect(url).toBe(`postgresql://vault:${encodeURIComponent(password)}@vault-db:5432/vault?schema=vault`);
    expect(decodeURIComponent(new URL(url).password)).toBe(password);
  });

  it('refuses ambiguous or incomplete configuration without revealing the password', () => {
    const attempts = [
      { ...fromFile(), DATABASE_URL: 'postgresql://x' },
      {},
      fromFile({ DATABASE_HOST: '' }),
      fromFile({ DATABASE_PORT: 'abc' }),
      fromFile({ DATABASE_PASSWORD_FILE: join(dir, 'missing') }),
    ];
    for (const env of attempts) {
      let message = '';
      try {
        resolveDatabaseUrl(env);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toBe('');
      expect(message.includes(password)).toBe(false);
    }
    writeFileSync(passwordFile, '  \n');
    expect(() => resolveDatabaseUrl(fromFile())).toThrow('empty');
  });
});
