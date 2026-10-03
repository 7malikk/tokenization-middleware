import { createParamDecorator, ExecutionContext, InternalServerErrorException } from '@nestjs/common';

/** Request field where the caller-identity guard records the calling application. */
export interface CallerRequest {
  callerAppId?: string;
}

/** The calling application's id, as attached by the caller-identity guard. */
export const CallerAppId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const appId = ctx.switchToHttp().getRequest<CallerRequest>().callerAppId;
  if (!appId) {
    // A route reached without the guard having run. Fail closed.
    throw new InternalServerErrorException();
  }
  return appId;
});
