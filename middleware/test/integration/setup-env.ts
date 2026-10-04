import { loadEnv } from '../../src/load-env';
import { resolveTestDatabaseUrl } from '../helpers/test-database';

// Runs in every integration test file. Database-backed tests only ever touch
// TEST_DATABASE_URL, never DATABASE_URL, because the suite resets it.
loadEnv();
process.env.DATABASE_URL = resolveTestDatabaseUrl(process.env);
