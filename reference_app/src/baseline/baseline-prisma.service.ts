import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '.prisma/baseline-client';
import { ENV, Env } from '../config/env';
import { resolveBaselineDatabaseUrl } from './baseline-database';

/** Client for the baseline database only (its own schema, generated client and migrations). */
@Injectable()
export class BaselinePrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    super({ datasourceUrl: resolveBaselineDatabaseUrl(env) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
