import { Operation } from '@prisma/client';
import { generateApiKey, hashApiKey } from '../auth/api-key';
import { PrismaDb } from '../prisma/prisma';

// Administrative operations behind the CLI. There is deliberately no delete:
// applications and credentials are kept so audit rows always resolve.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATIONS: readonly Operation[] = ['TOKENIZE', 'DETOKENIZE', 'ERASE', 'INSPECT'];

export class AdminError extends Error {}

/** Parse "TOKENIZE,DETOKENIZE" into a non-empty list of distinct operations. */
export function parseScopes(raw: string): Operation[] {
  const parts = raw.split(',').map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new AdminError(`--scopes needs at least one of ${OPERATIONS.join(', ')}`);
  }
  for (const part of parts) {
    if (!OPERATIONS.includes(part as Operation)) {
      throw new AdminError(`unknown scope "${part}"; use ${OPERATIONS.join(', ')}`);
    }
  }
  return [...new Set(parts)] as Operation[];
}

export async function createApplication(db: PrismaDb, name: string): Promise<{ id: string }> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new AdminError('--name must not be empty');
  }
  if (await db.application.findUnique({ where: { name: trimmed }, select: { id: true } })) {
    throw new AdminError('an application with that name already exists');
  }
  return db.application.create({ data: { name: trimmed }, select: { id: true } });
}

/** Issue a credential. The returned key is the only copy; the database keeps its hash. */
export async function createCredential(
  db: PrismaDb,
  appId: string,
  scopes: Operation[],
): Promise<{ id: string; key: string }> {
  if (!UUID.test(appId)) {
    throw new AdminError('--app must be an application id (uuid)');
  }
  if (!(await db.application.findUnique({ where: { id: appId }, select: { id: true } }))) {
    throw new AdminError('no application with that id');
  }
  const key = generateApiKey();
  const credential = await db.apiCredential.create({
    data: {
      appId,
      keyHash: hashApiKey(key),
      scopes: { create: scopes.map((operation) => ({ operation })) },
    },
    select: { id: true },
  });
  return { id: credential.id, key };
}

/** Revoke a credential by setting revokedAt. Revoking twice keeps the first time. */
export async function revokeCredential(db: PrismaDb, id: string): Promise<{ revokedAt: Date }> {
  if (!UUID.test(id)) {
    throw new AdminError('--id must be a credential id (uuid)');
  }
  const credential = await db.apiCredential.findUnique({ where: { id }, select: { revokedAt: true } });
  if (!credential) {
    throw new AdminError('no credential with that id');
  }
  if (credential.revokedAt) {
    return { revokedAt: credential.revokedAt };
  }
  const updated = await db.apiCredential.update({
    where: { id },
    data: { revokedAt: new Date() },
    select: { revokedAt: true },
  });
  return { revokedAt: updated.revokedAt as Date };
}
