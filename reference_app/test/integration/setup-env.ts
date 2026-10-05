import { loadEnv } from '../../src/load-env';
import { resolveBaselineTestDatabaseUrl, resolveTestDatabaseUrl } from '../helpers/test-database';

loadEnv();
process.env.BASELINE_DATABASE_URL = resolveBaselineTestDatabaseUrl(process.env);
process.env.DATABASE_URL = resolveTestDatabaseUrl(process.env);
