import { Inject, Injectable } from '@nestjs/common';
import { Outcome } from '@prisma/client';
import { AuditTrail } from '../auth/request-context';
import { PRISMA } from '../prisma/prisma.module';
import { PrismaDb, PrismaTx } from '../prisma/prisma';

@Injectable()
export class AuditService {
  constructor(@Inject(PRISMA) private readonly db: PrismaDb) {}

  /**
   * Write this request's audit row. Pass `tx` to write inside the transaction
   * that changes the vault. The row holds the credential, operation, token,
   * and outcome; never an identifier value.
   */
  async write(trail: AuditTrail, outcome: Outcome, tx?: PrismaTx): Promise<void> {
    await (tx ?? this.db).auditLog.create({
      data: {
        credentialId: trail.credentialId,
        operation: trail.operation,
        token: trail.token,
        outcome,
      },
      select: { id: true },
    });
  }

  /** Write the row outside a transaction and mark the request as recorded. */
  async record(trail: AuditTrail, outcome: Outcome): Promise<void> {
    await this.write(trail, outcome);
    trail.recorded = true;
  }
}
