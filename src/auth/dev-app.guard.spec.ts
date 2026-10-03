import { randomUUID } from 'node:crypto';
import { ExecutionContext } from '@nestjs/common';
import { CallerRequest } from './caller';
import { DevAppGuard } from './dev-app.guard';

function contextFor(request: CallerRequest & { headers?: Record<string, string> }): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

describe('DevAppGuard (temporary)', () => {
  it('attaches DEV_APP_ID and ignores identity claimed in request headers', () => {
    const appId = randomUUID();
    const request: CallerRequest & { headers: Record<string, string> } = {
      headers: { 'x-app-id': randomUUID(), 'x-caller-app-id': randomUUID() },
    };
    expect(new DevAppGuard({ DEV_APP_ID: appId }).canActivate(contextFor(request))).toBe(true);
    expect(request.callerAppId).toBe(appId);
  });

  it('refuses to run when NODE_ENV=production', () => {
    expect(() => new DevAppGuard({ DEV_APP_ID: randomUUID(), NODE_ENV: 'production' })).toThrow(
      'DevAppGuard must not run when NODE_ENV=production',
    );
  });

  it('refuses a missing or malformed DEV_APP_ID', () => {
    expect(() => new DevAppGuard({})).toThrow('DEV_APP_ID');
    expect(() => new DevAppGuard({ DEV_APP_ID: 'not-a-uuid' })).toThrow('DEV_APP_ID');
  });
});
