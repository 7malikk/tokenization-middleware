import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const PRISMA_BIN = resolve(ROOT, 'node_modules/.bin/prisma');

/** Run the Prisma CLI against the (already guarded) test database. */
export function prisma(...args: string[]): void {
  execFileSync(PRISMA_BIN, args, { cwd: ROOT, env: process.env, stdio: 'pipe' });
}

/**
 * Drop everything in the test database and apply every migration from scratch.
 * Only ever runs against TEST_DATABASE_URL (enforced by setup-env).
 */
export function resetTestDatabase(): void {
  prisma('migrate', 'reset', '--force', '--skip-seed', '--skip-generate');
}
