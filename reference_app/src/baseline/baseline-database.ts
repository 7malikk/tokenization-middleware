import { resolveDatabaseUrl } from '../config/database-url';
import { Env } from '../config/env';

/** EVALUATION ONLY: true when EVALUATION_BASELINE is exactly "true" (baseline routes on). */
export function evaluationEnabled(env: Env): boolean {
  return env.EVALUATION_BASELINE === 'true';
}

/**
 * The baseline database URL, from BASELINE_DATABASE_URL (native) or from
 * BASELINE_DATABASE_PASSWORD_FILE with BASELINE_DATABASE_HOST, _PORT, _NAME,
 * _USER and _SCHEMA (Docker). Refuses a URL that names the reference
 * database: baseline data must never reach it.
 */
export function resolveBaselineDatabaseUrl(env: Env): string {
  const baseline = resolveDatabaseUrl({
    DATABASE_URL: env.BASELINE_DATABASE_URL,
    DATABASE_PASSWORD_FILE: env.BASELINE_DATABASE_PASSWORD_FILE,
    DATABASE_HOST: env.BASELINE_DATABASE_HOST,
    DATABASE_PORT: env.BASELINE_DATABASE_PORT,
    DATABASE_NAME: env.BASELINE_DATABASE_NAME,
    DATABASE_USER: env.BASELINE_DATABASE_USER,
    DATABASE_SCHEMA: env.BASELINE_DATABASE_SCHEMA,
  });
  if (sameDatabase(baseline, resolveDatabaseUrl(env))) {
    throw new Error('the baseline database must not be the reference database');
  }
  return baseline;
}

/** Same server and database name. The password and ?schema= are ignored. */
function sameDatabase(a: string, b: string): boolean {
  const key = (raw: string) => {
    const url = new URL(raw);
    return `${url.hostname}:${url.port || '5432'}/${decodeURIComponent(url.pathname)}`;
  };
  return key(a) === key(b);
}
