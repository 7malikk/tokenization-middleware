import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DevAppGuard } from './dev-app.guard';

@Module({
  // TEMPORARY: increment 3 swaps DevAppGuard for the API key guard.
  providers: [{ provide: APP_GUARD, useClass: DevAppGuard }],
})
export class AuthModule {}
