import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ENV, Env, isProduction } from '../config/env';
import { CallerRequest } from './caller';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * TEMPORARY (increment 2). Development stand-in for caller identity: every
 * request acts as the single application in DEV_APP_ID. It never reads
 * identity from the request. Increment 3 replaces it with API key credentials.
 */
@Injectable()
export class DevAppGuard implements CanActivate {
  private readonly appId: string;

  constructor(@Inject(ENV) env: Env) {
    if (isProduction(env)) {
      throw new Error('DevAppGuard must not run when NODE_ENV=production');
    }
    const appId = env.DEV_APP_ID ?? '';
    if (!UUID.test(appId)) {
      throw new Error('DEV_APP_ID must be an application uuid');
    }
    this.appId = appId.toLowerCase();
  }

  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest<CallerRequest>().callerAppId = this.appId;
    return true;
  }
}
