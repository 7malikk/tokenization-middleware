import { Body, Controller, Header, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { CreateCustomerBody, CreateCustomerPipe, CustomerIdPipe } from '../customers/customers.pipes';
import { BaselinePrismaService } from './baseline-prisma.service';

const customerNotFound = () => new NotFoundException('customer not found');

/**
 * EVALUATION ONLY (thesis 3.1.3, latency baseline). Registered only when
 * EVALUATION_BASELINE=true. Stores and reads a BVN directly in the separate
 * baseline database, with no middleware: the system the treatment routes
 * (/customers) are measured against. Never use with real data.
 */
@Controller('baseline/customers')
export class BaselineController {
  constructor(private readonly db: BaselinePrismaService) {}

  @Post()
  @HttpCode(201)
  async create(@Body(CreateCustomerPipe) body: CreateCustomerBody): Promise<{ id: string; fullName: string }> {
    return this.db.baselineCustomer.create({
      data: { fullName: body.fullName, bvn: body.bvn },
      select: { id: true, fullName: true },
    });
  }

  /** The baseline counterpart of POST /customers/:id/reveal-bvn. */
  @Post(':id/read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async read(@Param('id', CustomerIdPipe) id: string): Promise<{ bvn: string }> {
    const customer = await this.db.baselineCustomer.findUnique({ where: { id }, select: { bvn: true } });
    if (!customer) {
      throw customerNotFound();
    }
    return { bvn: customer.bvn };
  }
}
