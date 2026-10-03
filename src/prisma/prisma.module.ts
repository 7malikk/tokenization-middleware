import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ENV, Env } from '../config/env';
import { createPrismaClient, PrismaDb } from './prisma';

/** Injection token for the one shared Prisma client. */
export const PRISMA = Symbol('PRISMA');

@Injectable()
class PrismaLifecycle implements OnModuleDestroy {
  constructor(@Inject(PRISMA) private readonly db: PrismaDb) {}

  async onModuleDestroy(): Promise<void> {
    await this.db.$disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PRISMA,
      inject: [ENV],
      useFactory: async (env: Env): Promise<PrismaDb> => {
        const db = createPrismaClient(env.DATABASE_URL);
        await db.$connect();
        return db;
      },
    },
    PrismaLifecycle,
  ],
  exports: [PRISMA],
})
export class PrismaModule {}
