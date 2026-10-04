import { Inject, Injectable } from '@nestjs/common';
import { Operation, Outcome } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuditTrail, Caller } from '../auth/request-context';
import { PRISMA } from '../prisma/prisma.module';
import { PrismaDb } from '../prisma/prisma';

const LIMIT = 20;

export interface InspectRecord {
  token: string;
  dataType: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  wrappedDataKey: string | null;
  masterKeyVersion: number;
  createdAt: string;
  erasedAt: string | null;
}

export interface InspectAudit {
  operation: Operation;
  outcome: Outcome;
  token: string | null;
  occurredAt: string;
}

export interface InspectResult {
  records: InspectRecord[];
  audit: InspectAudit[];
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/**
 * DEMO ONLY. Shows what the vault stores for the calling application, so an
 * examiner can watch tokenization and erasure. It reads stored bytes as they
 * are and never decrypts or unwraps anything: no plaintext identifier, master
 * key, KEK or API key can appear in the result.
 */
@Injectable()
export class InspectService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
  ) {}

  async inspect(caller: Caller, trail: AuditTrail): Promise<InspectResult> {
    const [records, audit] = await Promise.all([
      this.db.vaultRecord.findMany({
        where: { appId: caller.appId },
        orderBy: [{ createdAt: 'desc' }, { token: 'asc' }],
        take: LIMIT,
        select: {
          token: true,
          dataType: true,
          ciphertext: true,
          iv: true,
          authTag: true,
          wrappedDataKey: true,
          masterKeyVersion: true,
          createdAt: true,
          erasedAt: true,
        },
      }),
      this.db.auditLog.findMany({
        where: { credential: { appId: caller.appId } },
        orderBy: { id: 'desc' },
        take: LIMIT,
        select: { operation: true, outcome: true, token: true, occurredAt: true },
      }),
    ]);

    const result: InspectResult = {
      records: records.map((r) => ({
        token: r.token,
        dataType: r.dataType,
        ciphertext: hex(r.ciphertext),
        iv: hex(r.iv),
        authTag: hex(r.authTag),
        wrappedDataKey: r.wrappedDataKey ? hex(r.wrappedDataKey) : null,
        masterKeyVersion: r.masterKeyVersion,
        createdAt: r.createdAt.toISOString(),
        erasedAt: r.erasedAt ? r.erasedAt.toISOString() : null,
      })),
      audit: audit.map((a) => ({
        operation: a.operation,
        outcome: a.outcome,
        token: a.token,
        occurredAt: a.occurredAt.toISOString(),
      })),
    };

    // Fail closed, as for detokenize: nothing is returned until this call's audit row is written.
    await this.audit.record(trail, 'SUCCESS');
    return result;
  }
}
