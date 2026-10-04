import { createHash, randomBytes } from 'node:crypto';

// Format: "tkm_" + 32 random bytes in base64url (43 chars, no padding).
const PREFIX = 'tkm_';
const KEY_BYTES = 32;
const API_KEY_FORMAT = /^tkm_[A-Za-z0-9_-]{43}$/;

/** A new API key. Show it once; store only its hash. */
export function generateApiKey(): string {
  return PREFIX + randomBytes(KEY_BYTES).toString('base64url');
}

/** SHA-256 of the key as issued. This is all the database ever holds. */
export function hashApiKey(key: string): Buffer<ArrayBuffer> {
  return createHash('sha256').update(key, 'utf8').digest();
}

/** The key from `Authorization: Bearer <key>`, or null if missing or malformed. */
export function parseBearerKey(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  const match = /^Bearer (\S+)$/.exec(header);
  if (!match || !API_KEY_FORMAT.test(match[1])) {
    return null;
  }
  return match[1];
}
