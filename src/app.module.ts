import { DynamicModule, Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { Env, EnvModule } from './config/env';
import { VaultModule } from './vault/vault.module';

@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [EnvModule.forRoot(env), AuthModule, VaultModule],
    };
  }
}
