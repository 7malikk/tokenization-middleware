import { DynamicModule, Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { Clock } from './auth/clock';
import { ClockModule } from './auth/clock.module';
import { Env, EnvModule } from './config/env';
import { DemoModule } from './demo/demo.module';
import { demoInspectEnabled } from './demo/demo-inspect';
import { PrismaModule } from './prisma/prisma.module';
import { VaultModule } from './vault/vault.module';

export interface AppOverrides {
  /** Time source for rate limiting. Tests pass a controllable clock. */
  clock?: Clock;
}

@Module({})
export class AppModule {
  static forRoot(env: Env, overrides: AppOverrides = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        EnvModule.forRoot(env),
        ClockModule.forRoot(overrides.clock),
        PrismaModule,
        AuditModule,
        AuthModule,
        VaultModule,
        // Demo only, off by default: when off the inspect route does not exist.
        ...(demoInspectEnabled(env) ? [DemoModule] : []),
      ],
    };
  }
}
