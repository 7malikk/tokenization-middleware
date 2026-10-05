import { DynamicModule, Module } from '@nestjs/common';
import { evaluationEnabled } from './baseline/baseline-database';
import { BaselineModule } from './baseline/baseline.module';
import { Env, EnvModule } from './config/env';
import { CustomersModule } from './customers/customers.module';
import { DemoModule } from './demo/demo.module';
import { demoEnabled } from './middleware/middleware-client';
import { PrismaModule } from './prisma/prisma.module';

@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        EnvModule.forRoot(env),
        PrismaModule,
        CustomersModule,
        // Demo only, off by default: the page and its views exist only when switched on.
        ...(demoEnabled(env) ? [DemoModule] : []),
        // Evaluation only, off by default: the latency baseline routes.
        ...(evaluationEnabled(env) ? [BaselineModule] : []),
      ],
    };
  }
}
