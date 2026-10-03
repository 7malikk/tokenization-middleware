import { loadEnv } from '../../src/load-env';

// Integration tests run only against TEST_DATABASE_URL, never DATABASE_URL,
// because the suite resets the database it touches. Refuse to start unless
// the target is clearly a throwaway test database.
loadEnv();

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
}
if (testUrl === process.env.DATABASE_URL) {
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

process.env.DATABASE_URL = testUrl;
