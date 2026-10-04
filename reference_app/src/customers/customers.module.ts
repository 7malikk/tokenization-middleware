import { Module } from '@nestjs/common';
import { MiddlewareModule } from '../middleware/middleware.module';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  imports: [MiddlewareModule],
  controllers: [CustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
