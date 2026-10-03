import { Injectable } from '@nestjs/common';
import { Outcome } from '@prisma/client';
import { CryptoService } from '../crypto/crypto.service';
import { KeyProvider } from '../keys/key-provider';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Why a detokenize or erase found nothing. Callers always see one identical
 * not-found response; this distinction exists only for the audit log.
 */
export type NotFoundReason = Extract<Outcome, 'NOT_FOUND' | 'NOT_OWNER' | 'ERASED'>;

export type DetokenizeResult =
  | { found: true; dataType: string; value: string }
  | { found: false; reason: NotFoundReason };

export type EraseResult = { found: true } | { found: false; reason: NotFoundReason };

@Injectable()
export class VaultService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: KeyProvider,
    private readonly crypto: CryptoService,
  ) {}

  async tokenize(appId: string, dataType: string, value: string): Promise<string> {
    const token = this.crypto.generateToken();
    const dataKey = this.crypto.generateDataKey();
    const plaintext = Buffer.from(value, 'utf8');
    try {
      const { ciphertext, iv, authTag } = this.crypto.encrypt(plaintext, dataKey);
      const { wrapped, version } = await this.keys.wrap(dataKey);
      this.crypto.zeroize(dataKey);
      await this.prisma.vaultRecord.create({
        data: {
          token,
          appId,
          dataType,
          ciphertext,
          iv,
          authTag,
          wrappedDataKey: wrapped,
          masterKeyVersion: version,
        },
        select: { token: true },
      });
      return token;
    } finally {
      this.crypto.zeroize(dataKey);
      this.crypto.zeroize(plaintext);
    }
  }

  async detokenize(appId: string, token: string): Promise<DetokenizeResult> {
    const record = await this.prisma.vaultRecord.findFirst({
      where: { token, appId, erasedAt: null },
    });
    if (!record) {
      return { found: false, reason: await this.notFoundReason(appId, token) };
    }
    if (!record.wrappedDataKey) {
      throw new Error('live vault record has no wrapped data key');
    }

    const dataKey = await this.keys.unwrap(Buffer.from(record.wrappedDataKey), record.masterKeyVersion);
    try {
      const plaintext = this.crypto.decrypt(
        {
          ciphertext: Buffer.from(record.ciphertext),
          iv: Buffer.from(record.iv),
          authTag: Buffer.from(record.authTag),
        },
        dataKey,
      );
      const value = plaintext.toString('utf8');
      this.crypto.zeroize(plaintext);
      return { found: true, dataType: record.dataType, value };
    } finally {
      this.crypto.zeroize(dataKey);
    }
  }

  async erase(appId: string, token: string): Promise<EraseResult> {
    // Crypto-shredding: drop the wrapped key, keep the row and its ciphertext.
    const { count } = await this.prisma.vaultRecord.updateMany({
      where: { token, appId, erasedAt: null },
      data: { wrappedDataKey: null, erasedAt: new Date() },
    });
    if (count === 0) {
      return { found: false, reason: await this.notFoundReason(appId, token) };
    }
    return { found: true };
  }

  /** Runs only after a miss, and the same query runs for every kind of miss. */
  private async notFoundReason(appId: string, token: string): Promise<NotFoundReason> {
    const record = await this.prisma.vaultRecord.findUnique({
      where: { token },
      select: { appId: true },
    });
    if (!record) {
      return 'NOT_FOUND';
    }
    return record.appId === appId ? 'ERASED' : 'NOT_OWNER';
  }
}
