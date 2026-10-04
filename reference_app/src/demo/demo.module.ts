import { Module } from '@nestjs/common';
import { MiddlewareModule } from '../middleware/middleware.module';
import { DemoController } from './demo.controller';

/** DEMO ONLY. Imported by AppModule only when DEMO_PASSWORD_FILE is set. */
@Module({
  imports: [MiddlewareModule],
  controllers: [DemoController],
})
export class DemoModule {}
