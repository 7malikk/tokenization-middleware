import { resolveTestDatabaseUrl } from './test-database';

describe('resolveTestDatabaseUrl', () => {
  const base = 'postgresql://u@localhost:5432';

  it('accepts a database name ending in _test', () => {
    const url = `${base}/vault_test?schema=vault_test`;
    expect(resolveTestDatabaseUrl({ TEST_DATABASE_URL: url, DATABASE_URL: `${base}/vault` })).toBe(url);
  });

  it('checks the database name, not the ?schema= parameter', () => {
    expect(() => resolveTestDatabaseUrl({ TEST_DATABASE_URL: `${base}/vault?schema=vault_test` })).toThrow(
      'ending in "_test"',
    );
    expect(resolveTestDatabaseUrl({ TEST_DATABASE_URL: `${base}/vault_test?schema=vault` })).toBe(
      `${base}/vault_test?schema=vault`,
    );
  });

  it('refuses when unset or equal to DATABASE_URL', () => {
    expect(() => resolveTestDatabaseUrl({})).toThrow('not set');
    const url = `${base}/vault_test`;
    expect(() => resolveTestDatabaseUrl({ TEST_DATABASE_URL: url, DATABASE_URL: url })).toThrow('must differ');
  });
});
