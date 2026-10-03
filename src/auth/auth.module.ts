import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ApiKeyGuard } from './api-key.guard';
import { CredentialsService } from './credentials.service';
import { RateLimiter } from './rate-limiter';

@Module({
  providers: [CredentialsService, RateLimiter, { provide: APP_GUARD, useClass: ApiKeyGuard }],
})
export class AuthModule {}
