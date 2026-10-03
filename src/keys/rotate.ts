import { randomBytes } from 'node:crypto';
import { Bytes, KEY_BYTES, unwrapKey, wrapKey, zeroize } from '../crypto/crypto';
import { PrismaDb } from '../prisma/prisma';
import { KeyFile, KeyLayerError, readKeyFile, replaceKeyFile, unlockKeyFile, wrapMasterKey, zeroizeAll } from './key-file';

export interface RotateOptions {
  batchSize?: number;
  /** Test hook, called after each committed batch with the running total. */
  afterBatch?: (rotatedSoFar: number) => void;
}

export interface RotateResult {
  version: number;
  /** True when this run finished an earlier, interrupted rotation. */
  resumed: boolean;
  rotated: number;
  erasedSkipped: number;
}

/**
 * Rotate the master key. Adds a new version to the key file and makes it
 * active, then rewraps every live record's data key under it, batch by batch.
 * Only wrappedDataKey and masterKeyVersion change; ciphertext, iv and authTag
 * are never read or written. Erased records have no wrapped key and are skipped.
 *
 * Crash safety: the new version is written to the key file (atomically)
 * before any record changes, old versions stay in the file, and every record
 * carries its own version. If live records are still below the active version
 * when this runs, an earlier rotation was interrupted, so this run finishes
 * that one instead of adding another version.
 *
 * Run it with the server stopped: a running server holds the master keys it
 * loaded at startup and would not know the new version.
 */
export async function rotateMasterKey(
  db: PrismaDb,
  keyFilePath: string | undefined,
  kek: Buffer,
  options: RotateOptions = {},
): Promise<RotateResult> {
  const batchSize = options.batchSize ?? 500;
  let file = readKeyFile(keyFilePath);
  const masterKeys = unlockKeyFile(file, kek);

  try {
    const behind = await db.vaultRecord.count({ where: liveBelow(file.active) });
    const resumed = behind > 0;
    let target = file.active;

    if (!resumed) {
      target = Math.max(...file.keys.map((k) => k.version)) + 1;
      const masterKey = randomBytes(KEY_BYTES);
      const next: KeyFile = { active: target, keys: [...file.keys, wrapMasterKey(target, masterKey, kek)] };
      // Persist the new version before any record depends on it.
      replaceKeyFile(keyFilePath as string, next);
      masterKeys.set(target, masterKey);
      file = next;
    }

    const targetKey = masterKeys.get(target) as Bytes;
    let rotated = 0;
    for (;;) {
      const batch = await db.vaultRecord.findMany({
        where: liveBelow(target),
        select: { token: true, wrappedDataKey: true, masterKeyVersion: true },
        orderBy: { token: 'asc' },
        take: batchSize,
      });
      if (batch.length === 0) {
        break;
      }

      const updates = batch.map((record) => {
        const oldKey = masterKeys.get(record.masterKeyVersion);
        if (!oldKey) {
          throw new KeyLayerError(`a vault record uses master key version ${record.masterKeyVersion}, which the key file lacks`);
        }
        const dataKey = unwrapKey(Buffer.from(record.wrappedDataKey as Uint8Array), oldKey);
        const rewrapped = wrapKey(dataKey, targetKey);
        zeroize(dataKey);
        // Conditional on the version read above and on the record still being
        // live, so a concurrent erase is never undone.
        return db.vaultRecord.updateMany({
          where: { token: record.token, masterKeyVersion: record.masterKeyVersion, erasedAt: null },
          data: { wrappedDataKey: rewrapped, masterKeyVersion: target },
        });
      });
      const results = await db.$transaction(updates);
      rotated += results.reduce((sum, r) => sum + r.count, 0);
      options.afterBatch?.(rotated);
    }

    const erasedSkipped = await db.vaultRecord.count({ where: { erasedAt: { not: null } } });
    return { version: target, resumed, rotated, erasedSkipped };
  } finally {
    zeroizeAll(masterKeys);
  }
}

function liveBelow(version: number) {
  return { erasedAt: null, wrappedDataKey: { not: null }, masterKeyVersion: { lt: version } };
}
