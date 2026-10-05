import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadEnv } from '../../src/load-env';
import { resolveBaselineTestDatabaseUrl, resolveTestDatabaseUrl } from '../helpers/test-database';

/** Apply pending migrations to the test databases. Never drops anything. */
export default function globalSetup(): void {
  loadEnv();
  const url = resolveTestDatabaseUrl(process.env);
  const root = resolve(__dirname, '../..');
  execFileSync(resolve(root, 'node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  // The evaluation baseline's own database (prisma/baseline/schema.prisma).
  execFileSync(resolve(root, 'node_modules/.bin/prisma'), ['migrate', 'deploy', '--schema', 'prisma/baseline/schema.prisma'], {
    cwd: root,
    env: { ...process.env, BASELINE_DATABASE_URL: resolveBaselineTestDatabaseUrl(process.env) },
    stdio: 'pipe',
  });
}
