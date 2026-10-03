import {
  ArgumentsHost,
  BadGatewayException,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseFilters,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Customer } from '@prisma/client';
import { MiddlewareError } from '../middleware/middleware-client';
import { CreateCustomerBody, CreateCustomerPipe, CustomerIdPipe } from './customers.pipes';
import { CustomersService } from './customers.service';

interface CustomerView {
  id: string;
  fullName: string;
  bvnToken: string;
}

const view = (c: Customer): CustomerView => ({ id: c.id, fullName: c.fullName, bvnToken: c.bvnToken });
const customerNotFound = () => new NotFoundException('customer not found');
const bvnNotAvailable = () => new NotFoundException('BVN not available');

/** Any middleware failure becomes one fixed 502. Nothing from the middleware is passed on. */
@Catch(MiddlewareError)
class MiddlewareErrorFilter extends BaseExceptionFilter implements ExceptionFilter {
  override catch(_exception: MiddlewareError, host: ArgumentsHost): void {
    super.catch(new BadGatewayException('tokenization service unavailable'), host);
  }
}

@Controller('customers')
@UseFilters(MiddlewareErrorFilter)
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post()
  @HttpCode(201)
  async create(@Body(CreateCustomerPipe) body: CreateCustomerBody): Promise<CustomerView> {
    return view(await this.customers.create(body.fullName, body.bvn));
  }

  @Get(':id')
  async find(@Param('id', CustomerIdPipe) id: string): Promise<CustomerView> {
    const customer = await this.customers.find(id);
    if (!customer) {
      throw customerNotFound();
    }
    return view(customer);
  }

  /** Authorised retrieval: the BVN is returned for this one response and not kept. */
  @Post(':id/reveal-bvn')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async reveal(@Param('id', CustomerIdPipe) id: string): Promise<{ bvn: string }> {
    const result = await this.customers.revealBvn(id);
    if (result.kind === 'no-customer') throw customerNotFound();
    if (result.kind === 'not-available') throw bvnNotAvailable();
    return { bvn: result.bvn };
  }

  @Post(':id/erase')
  @HttpCode(200)
  async erase(@Param('id', CustomerIdPipe) id: string): Promise<{ erased: true }> {
    const result = await this.customers.eraseBvn(id);
    if (result === 'no-customer') throw customerNotFound();
    if (result === 'not-available') throw bvnNotAvailable();
    return { erased: true };
  }
}
