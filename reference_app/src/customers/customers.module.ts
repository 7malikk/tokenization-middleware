import { Module } from '@nestjs/common';
import { MiddlewareClient } from '../middleware/middleware-client';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  controllers: [CustomersController],
  providers: [CustomersService, MiddlewareClient],
})
export class CustomersModule {}
