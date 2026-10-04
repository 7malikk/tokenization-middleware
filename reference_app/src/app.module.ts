import { DynamicModule, Module } from '@nestjs/common';
import { Env, EnvModule } from './config/env';
import { CustomersModule } from './customers/customers.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [EnvModule.forRoot(env), PrismaModule, CustomersModule],
    };
  }
}
