/**
 * Resolve the database the integration suites may reset. Refuses unless
 * TEST_DATABASE_URL names a database ending in "_test" and differs from
 * DATABASE_URL. The name comes from the URL path; `?schema=` is ignored.
 */
export function resolveTestDatabaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  const testUrl = env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
  }
  if (testUrl === env.DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL: the suite resets it.');
  }

  let dbName: string;
  try {
    dbName = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''));
  } catch {
    throw new Error('TEST_DATABASE_URL is not a valid URL.');
  }
  if (!dbName.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must name a database ending in "_test": the suite resets it.');
  }
  return testUrl;
}
