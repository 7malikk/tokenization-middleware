import { ArgumentsHost, BadGatewayException, Catch, ExceptionFilter } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { MiddlewareError } from './middleware-client';

/** Any middleware failure becomes one fixed 502. Nothing from the middleware is passed on. */
@Catch(MiddlewareError)
export class MiddlewareErrorFilter extends BaseExceptionFilter implements ExceptionFilter {
  override catch(_exception: MiddlewareError, host: ArgumentsHost): void {
    super.catch(new BadGatewayException('tokenization service unavailable'), host);
  }
}
