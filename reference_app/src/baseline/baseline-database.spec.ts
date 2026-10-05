import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluationEnabled, resolveBaselineDatabaseUrl } from './baseline-database';

describe('evaluationEnabled', () => {
  it('is on only for exactly "true"', () => {
    expect(evaluationEnabled({ EVALUATION_BASELINE: 'true' })).toBe(true);
    for (const value of [undefined, '', 'false', '1', 'TRUE', 'yes']) {
      expect(evaluationEnabled({ EVALUATION_BASELINE: value })).toBe(false);
    }
  });
});

describe('resolveBaselineDatabaseUrl', () => {
  const reference = 'postgresql://u:p@localhost:5432/reference?schema=public';

  it('uses BASELINE_DATABASE_URL for native runs', () => {
    const url = 'postgresql://u:p@localhost:5432/baseline?schema=public';
    expect(resolveBaselineDatabaseUrl({ DATABASE_URL: reference, BASELINE_DATABASE_URL: url })).toBe(url);
  });

  it('builds the URL from the BASELINE_DATABASE_* settings and password file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'baseline-url-'));
    try {
      const passwordFile = join(dir, 'pw');
      writeFileSync(passwordFile, 'secret\n');
      const url = resolveBaselineDatabaseUrl({
        DATABASE_URL: reference,
        BASELINE_DATABASE_PASSWORD_FILE: passwordFile,
        BASELINE_DATABASE_HOST: 'baseline-db',
        BASELINE_DATABASE_NAME: 'baseline',
        BASELINE_DATABASE_USER: 'baseline',
        BASELINE_DATABASE_SCHEMA: 'public',
      });
      expect(url).toBe('postgresql://baseline:secret@baseline-db:5432/baseline?schema=public');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses the reference database, whatever the schema or password', () => {
    for (const url of [reference, 'postgresql://other:x@localhost/reference?schema=baseline']) {
      expect(() => resolveBaselineDatabaseUrl({ DATABASE_URL: reference, BASELINE_DATABASE_URL: url })).toThrow(
        'must not be the reference database',
      );
    }
  });

  it('refuses when no baseline database is configured', () => {
    expect(() => resolveBaselineDatabaseUrl({ DATABASE_URL: reference })).toThrow('no database configured');
  });
});
