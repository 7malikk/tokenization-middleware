import { Inject, Injectable } from '@nestjs/common';
import { Outcome } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuditTrail, Caller } from '../auth/request-context';
import { CryptoService } from '../crypto/crypto.service';
import { KeyProvider } from '../keys/key-provider';
import { PRISMA } from '../prisma/prisma.module';
import { PrismaDb, PrismaTx } from '../prisma/prisma';

/**
 * Why a detokenize or erase found nothing. Callers always see one identical
 * not-found response; only the audit row records which it was.
 */
export type NotFoundReason = Extract<Outcome, 'NOT_FOUND' | 'NOT_OWNER' | 'ERASED'>;

export type DetokenizeResult =
  | { found: true; dataType: string; value: string }
  | { found: false; reason: NotFoundReason };

export type EraseResult = { found: true } | { found: false; reason: NotFoundReason };

/**
 * Each method either returns after committing exactly one audit row for the
 * request (and sets `trail.recorded`), or throws having committed none, in
 * which case the audit exception filter records the failure.
 */
@Injectable()
export class VaultService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaDb,
    private readonly keys: KeyProvider,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  async tokenize(caller: Caller, trail: AuditTrail, dataType: string, value: string): Promise<string> {
    const token = this.crypto.generateToken();
    const dataKey = this.crypto.generateDataKey();
    const plaintext = Buffer.from(value, 'utf8');
    try {
      const { ciphertext, iv, authTag } = this.crypto.encrypt(plaintext, dataKey);
      const { wrapped, version } = await this.keys.wrap(dataKey);
      this.crypto.zeroize(dataKey);

      // The vault row and its audit row commit together or not at all.
      const success: AuditTrail = { ...trail, token };
      await this.prisma.$transaction(async (tx) => {
        await tx.vaultRecord.create({
          data: {
            token,
            appId: caller.appId,
            dataType,
            ciphertext,
            iv,
            authTag,
            wrappedDataKey: wrapped,
            masterKeyVersion: version,
          },
          select: { token: true },
        });
        await this.audit.write(success, 'SUCCESS', tx);
      });
      trail.token = token;
      trail.recorded = true;
      return token;
    } finally {
      this.crypto.zeroize(dataKey);
      this.crypto.zeroize(plaintext);
    }
  }

  async detokenize(caller: Caller, trail: AuditTrail, token: string): Promise<DetokenizeResult> {
    const record = await this.prisma.vaultRecord.findFirst({
      where: { token, appId: caller.appId, erasedAt: null },
    });
    if (!record) {
      const reason = await this.notFoundReason(this.prisma, caller.appId, token);
      await this.audit.record(trail, reason);
      return { found: false, reason };
    }
    if (!record.wrappedDataKey) {
      throw new Error('live vault record has no wrapped data key');
    }

    const dataKey = await this.keys.unwrap(Buffer.from(record.wrappedDataKey), record.masterKeyVersion);
    let value: string;
    try {
      const plaintext = this.crypto.decrypt(
        {
          ciphertext: Buffer.from(record.ciphertext),
          iv: Buffer.from(record.iv),
          authTag: Buffer.from(record.authTag),
        },
        dataKey,
      );
      value = plaintext.toString('utf8');
      this.crypto.zeroize(plaintext);
    } finally {
      this.crypto.zeroize(dataKey);
    }

    // Fail closed: the value is released only after its audit row is committed.
    await this.audit.record(trail, 'SUCCESS');
    return { found: true, dataType: record.dataType, value };
  }

  async erase(caller: Caller, trail: AuditTrail, token: string): Promise<EraseResult> {
    // Crypto-shredding: drop the wrapped key, keep the row and its ciphertext.
    // The change and its audit row commit together.
    const outcome = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.vaultRecord.updateMany({
        where: { token, appId: caller.appId, erasedAt: null },
        data: { wrappedDataKey: null, erasedAt: new Date() },
      });
      const result: Outcome = count === 1 ? 'SUCCESS' : await this.notFoundReason(tx, caller.appId, token);
      await this.audit.write(trail, result, tx);
      return result;
    });
    trail.recorded = true;
    return outcome === 'SUCCESS' ? { found: true } : { found: false, reason: outcome as NotFoundReason };
  }

  /** Runs only after a miss, and the same query runs for every kind of miss. */
  private async notFoundReason(db: PrismaDb | PrismaTx, appId: string, token: string): Promise<NotFoundReason> {
    const record = await db.vaultRecord.findUnique({
      where: { token },
      select: { appId: true },
    });
    if (!record) {
      return 'NOT_FOUND';
    }
    return record.appId === appId ? 'ERASED' : 'NOT_OWNER';
  }
}
