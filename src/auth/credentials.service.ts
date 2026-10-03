import { Inject, Injectable } from '@nestjs/common';
import { Operation } from '@prisma/client';
import { PRISMA } from '../prisma/prisma.module';
import { PrismaDb } from '../prisma/prisma';
import { hashApiKey } from './api-key';

export interface ActiveCredential {
  id: string;
  appId: string;
  scopes: ReadonlySet<Operation>;
}

@Injectable()
export class CredentialsService {
  constructor(@Inject(PRISMA) private readonly db: PrismaDb) {}

  /** The credential for this key, or null if unknown or revoked. */
  async findActive(key: string): Promise<ActiveCredential | null> {
    const credential = await this.db.apiCredential.findUnique({
      where: { keyHash: hashApiKey(key) },
      select: { id: true, appId: true, revokedAt: true, scopes: { select: { operation: true } } },
    });
    if (!credential || credential.revokedAt !== null) {
      return null;
    }
    return {
      id: credential.id,
      appId: credential.appId,
      scopes: new Set(credential.scopes.map((s) => s.operation)),
    };
  }
}
