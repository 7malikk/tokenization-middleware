import { Injectable, Logger } from '@nestjs/common';
import { Customer } from '@prisma/client';
import { MiddlewareClient } from '../middleware/middleware-client';
import { PrismaService } from '../prisma/prisma.module';

export type RevealResult = { kind: 'ok'; bvn: string } | { kind: 'no-customer' } | { kind: 'not-available' };
export type EraseResult = 'erased' | 'no-customer' | 'not-available';

/**
 * Customers hold a BVN token, never the BVN. The BVN passes through this
 * service only on its way to tokenize, or back from detokenize for one reveal.
 */
@Injectable()
export class CustomersService {
  private readonly logger = new Logger('Customers');

  constructor(
    private readonly db: PrismaService,
    private readonly middleware: MiddlewareClient,
  ) {}

  async create(fullName: string, bvn: string): Promise<Customer> {
    const bvnToken = await this.middleware.tokenize(bvn);
    try {
      return await this.db.customer.create({ data: { fullName, bvnToken } });
    } catch (err) {
      // Do not leave an orphaned BVN in the vault: erase the token we just made.
      await this.middleware.erase(bvnToken).catch(() => {
        this.logger.error('could not erase the token of a customer that failed to save');
      });
      throw err;
    }
  }

  find(id: string): Promise<Customer | null> {
    return this.db.customer.findUnique({ where: { id } });
  }

  async revealBvn(id: string): Promise<RevealResult> {
    const customer = await this.find(id);
    if (!customer) {
      return { kind: 'no-customer' };
    }
    const bvn = await this.middleware.detokenize(customer.bvnToken);
    return bvn === null ? { kind: 'not-available' } : { kind: 'ok', bvn };
  }

  /** Erase the BVN in the vault. The customer row and its (now dead) token stay. */
  async eraseBvn(id: string): Promise<EraseResult> {
    const customer = await this.find(id);
    if (!customer) {
      return 'no-customer';
    }
    return (await this.middleware.erase(customer.bvnToken)) ? 'erased' : 'not-available';
  }
}
