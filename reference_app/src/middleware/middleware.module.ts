import { Module } from '@nestjs/common';
import { MiddlewareClient } from './middleware-client';

/** One shared client: it reads (and removes) its API keys from the environment once. */
@Module({
  providers: [MiddlewareClient],
  exports: [MiddlewareClient],
})
export class MiddlewareModule {}
