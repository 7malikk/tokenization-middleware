import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * Load `.env` into process.env when the file exists (native runs).
 * Variables already set in the environment (Docker) take precedence.
 */
export function loadEnv(path = '.env'): void {
  if (!existsSync(path)) {
    return;
  }
  const parsed = parseEnv(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined && value !== undefined) {
      process.env[key] = value;
    }
  }
}
