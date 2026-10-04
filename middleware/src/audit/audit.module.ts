import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuditExceptionFilter } from './audit-exception.filter';
import { AuditService } from './audit.service';

@Global()
@Module({
  providers: [AuditService, { provide: APP_FILTER, useClass: AuditExceptionFilter }],
  exports: [AuditService],
})
export class AuditModule {}
