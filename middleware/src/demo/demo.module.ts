import { Module } from '@nestjs/common';
import { InspectController } from './inspect.controller';
import { InspectService } from './inspect.service';

/** DEMO ONLY. Imported by AppModule only when DEMO_INSPECT=true. */
@Module({
  controllers: [InspectController],
  providers: [InspectService],
})
export class DemoModule {}
