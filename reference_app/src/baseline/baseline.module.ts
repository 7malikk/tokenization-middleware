import { Module } from '@nestjs/common';
import { BaselineController } from './baseline.controller';
import { BaselinePrismaService } from './baseline-prisma.service';

/** EVALUATION ONLY. Imported by AppModule only when EVALUATION_BASELINE=true. */
@Module({
  controllers: [BaselineController],
  providers: [BaselinePrismaService],
})
export class BaselineModule {}
