import { createParamDecorator, ExecutionContext, InternalServerErrorException } from '@nestjs/common';
import { Operation } from '@prisma/client';

/** The authenticated caller, attached by the API key guard. */
export interface Caller {
  credentialId: string;
  appId: string;
}

/**
 * Audit state for one request. The guard creates it before anything else, so
 * every request to a vault endpoint has one. `recorded` turns true once this
 * request's single audit row is committed.
 */
export interface AuditTrail {
  operation: Operation;
  credentialId: string | null;
  /** Submitted token if it is well formed, else null. Never an identifier value. */
  token: string | null;
  recorded: boolean;
}

export interface VaultRequest {
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  caller?: Caller;
  audit?: AuditTrail;
}

// Both decorators fail closed if the guard did not run.

export const CurrentCaller = createParamDecorator((_data: unknown, ctx: ExecutionContext): Caller => {
  const caller = ctx.switchToHttp().getRequest<VaultRequest>().caller;
  if (!caller) {
    throw new InternalServerErrorException();
  }
  return caller;
});

export const CurrentAudit = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuditTrail => {
  const audit = ctx.switchToHttp().getRequest<VaultRequest>().audit;
  if (!audit) {
    throw new InternalServerErrorException();
  }
  return audit;
});
