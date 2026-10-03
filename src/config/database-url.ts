// Database URL resolution. Plain module with no NestJS imports, shared by the
// app, the CLI, and (as a launcher) the migrate image.
//
// Natively, DATABASE_URL comes from .env. In Docker, the URL is built at
// startup from DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_USER,
// DATABASE_SCHEMA and the password in DATABASE_PASSWORD_FILE (a Compose
// secret), so the password never appears in compose files, env files or images.
// Error messages never include the password.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

type EnvLike = Readonly<Record<string, string | undefined>>;

export function resolveDatabaseUrl(env: EnvLike): string {
  const url = env.DATABASE_URL;
  const passwordFile = env.DATABASE_PASSWORD_FILE;
  if (url && passwordFile) {
    throw new Error('set only one of DATABASE_URL and DATABASE_PASSWORD_FILE');
  }
  if (url) {
    return url;
  }
  if (!passwordFile) {
    throw new Error('no database configured: set DATABASE_URL, or DATABASE_PASSWORD_FILE with DATABASE_HOST');
  }

  const host = env.DATABASE_HOST;
  const name = env.DATABASE_NAME;
  const user = env.DATABASE_USER;
  if (!host || !name || !user) {
    throw new Error('DATABASE_PASSWORD_FILE needs DATABASE_HOST, DATABASE_NAME and DATABASE_USER');
  }
  const port = env.DATABASE_PORT ?? '5432';
  if (!/^[0-9]{1,5}$/.test(port)) {
    throw new Error('DATABASE_PORT must be a port number');
  }

  let password: string;
  try {
    password = readFileSync(passwordFile, 'utf8').trim();
  } catch {
    throw new Error('DATABASE_PASSWORD_FILE could not be read');
  }
  if (password.length === 0) {
    throw new Error('DATABASE_PASSWORD_FILE is empty');
  }

  const enc = encodeURIComponent;
  const schema = env.DATABASE_SCHEMA ? `?schema=${enc(env.DATABASE_SCHEMA)}` : '';
  return `postgresql://${enc(user)}:${enc(password)}@${host}:${port}/${enc(name)}${schema}`;
}

/**
 * Launcher: `node database-url.js <command> [args...]` runs the command with
 * DATABASE_URL set from the resolved URL. Used to run `prisma migrate deploy`.
 */
if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    process.stderr.write('usage: database-url <command> [args...]\n');
    process.exit(2);
  }
  let url: string;
  try {
    url = resolveDatabaseUrl(process.env);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
  const { DATABASE_PASSWORD_FILE: _f, ...rest } = process.env;
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...rest, DATABASE_URL: url } });
  process.exit(result.status ?? 1);
}
