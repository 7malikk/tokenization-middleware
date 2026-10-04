import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Operation } from '@prisma/client';
import { isWellFormedToken } from '../vault/vault.pipes';
import { parseBearerKey } from './api-key';
import { CredentialsService } from './credentials.service';
import { RateLimiter } from './rate-limiter';
import { REQUIRED_OPERATION } from './requires-operation.decorator';
import { VaultRequest } from './request-context';

interface ReplyHeaders {
  header(name: string, value: string): unknown;
}

/**
 * Runs on every route: authenticate, check scope, check rate limit. Routes
 * that do not declare an operation are refused. Rejections become audit rows
 * through the audit exception filter.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly credentials: CredentialsService,
    private readonly rateLimiter: RateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const operation = this.reflector.get<Operation | undefined>(REQUIRED_OPERATION, context.getHandler());
    if (!operation) {
      throw new InternalServerErrorException();
    }
    const http = context.switchToHttp();
    const request = http.getRequest<VaultRequest>();
    const reply = http.getResponse<ReplyHeaders>();

    request.audit = {
      operation,
      credentialId: null,
      token: operation === 'TOKENIZE' ? null : submittedToken(request.body),
      recorded: false,
    };

    // 1. Authenticate. Missing, malformed, unknown and revoked keys are indistinguishable.
    const key = parseBearerKey(request.headers.authorization);
    const credential = key ? await this.credentials.findActive(key) : null;
    if (!credential) {
      reply.header('WWW-Authenticate', 'Bearer');
      throw new UnauthorizedException('invalid or missing API key');
    }
    request.audit.credentialId = credential.id;

    // 2. Scope.
    if (!credential.scopes.has(operation)) {
      throw new ForbiddenException('credential lacks the scope for this operation');
    }

    // 3. Rate limit.
    const decision = this.rateLimiter.check(credential.id, operation);
    if (!decision.allowed) {
      reply.header('Retry-After', String(decision.retryAfterSeconds));
      throw new HttpException('rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }

    request.caller = { credentialId: credential.id, appId: credential.appId };
    return true;
  }
}

function submittedToken(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const token = (body as Record<string, unknown>).token;
  return isWellFormedToken(token) ? token : null;
}
