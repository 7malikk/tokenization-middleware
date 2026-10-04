import { ArgumentsHost, Catch, HttpException, HttpStatus, InternalServerErrorException, Logger } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { Outcome } from '@prisma/client';
import { VaultRequest } from '../auth/request-context';
import { AuditService } from './audit.service';

function outcomeFor(exception: unknown): Outcome {
  const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
  switch (status) {
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHENTICATED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN_SCOPE';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    case HttpStatus.BAD_REQUEST:
      return 'INVALID_REQUEST';
    default:
      return 'ERROR';
  }
}

/**
 * Records the audit row for every vault request that ends in an exception and
 * has no row yet (guard rejections, invalid input, unexpected errors). If that
 * write fails, the client gets a plain 500.
 */
@Catch()
export class AuditExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('Audit');

  constructor(
    private readonly audit: AuditService,
    adapterHost: HttpAdapterHost,
  ) {
    super(adapterHost.httpAdapter);
  }

  override async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    const trail = host.switchToHttp().getRequest<VaultRequest>().audit;
    if (trail && !trail.recorded) {
      try {
        await this.audit.record(trail, outcomeFor(exception));
      } catch {
        this.logger.error(`audit write failed for ${trail.operation}; responding 500`);
        exception = new InternalServerErrorException();
      }
    }
    super.catch(exception, host);
  }
}
