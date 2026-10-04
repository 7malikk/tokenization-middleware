import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const DEMO_USER = 'demo';
export const REALM = 'Basic realm="Tokenization demo", charset="UTF-8"';

/** The demo password from DEMO_PASSWORD_FILE. Never logged or echoed. */
export function readDemoPassword(path: string): string {
  let password: string;
  try {
    password = readFileSync(path, 'utf8').trim();
  } catch {
    throw new Error('DEMO_PASSWORD_FILE could not be read');
  }
  if (password.length < 12) {
    throw new Error('DEMO_PASSWORD_FILE must hold a password of at least 12 characters');
  }
  return password;
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/**
 * Returns a checker for `Authorization: Basic ...` headers. User and password
 * are compared together, as fixed-length SHA-256 digests with timingSafeEqual,
 * so the comparison takes the same time whatever was sent.
 */
export function basicAuthChecker(password: string): (header: string | string[] | undefined) => boolean {
  const expected = digest(`${DEMO_USER}:${password}`);
  return (header) => {
    if (typeof header !== 'string') {
      return false;
    }
    const match = /^Basic ([A-Za-z0-9+/]+=*)$/.exec(header);
    const supplied = match ? Buffer.from(match[1], 'base64').toString('utf8') : '';
    // Always compare, even for a malformed header, to keep timing uniform.
    const ok = timingSafeEqual(digest(supplied), expected);
    return ok && match !== null;
  };
}
