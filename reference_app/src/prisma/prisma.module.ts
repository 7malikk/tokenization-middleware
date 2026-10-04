import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { resolveDatabaseUrl } from '../config/database-url';
import { ENV, Env } from '../config/env';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    super({ datasourceUrl: resolveDatabaseUrl(env) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
