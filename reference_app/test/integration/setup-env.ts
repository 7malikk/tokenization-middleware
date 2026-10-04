import { loadEnv } from '../../src/load-env';
import { resolveTestDatabaseUrl } from '../helpers/test-database';

loadEnv();
process.env.DATABASE_URL = resolveTestDatabaseUrl(process.env);
