import { DynamicModule, Global, Module } from '@nestjs/common';
import { Clock, SystemClock } from './clock';

@Global()
@Module({})
export class ClockModule {
  static forRoot(clock: Clock = new SystemClock()): DynamicModule {
    return {
      module: ClockModule,
      providers: [{ provide: Clock, useValue: clock }],
      exports: [Clock],
    };
  }
}
