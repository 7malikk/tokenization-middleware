import { Controller, Header, HttpCode, Post } from '@nestjs/common';
import { AuditTrail, Caller, CurrentAudit, CurrentCaller } from '../auth/request-context';
import { RequiresOperation } from '../auth/requires-operation.decorator';
import { InspectResult, InspectService } from './inspect.service';

/** DEMO ONLY. Registered only when DEMO_INSPECT=true. */
@Controller('v1/demo')
export class InspectController {
  constructor(private readonly inspector: InspectService) {}

  @Post('inspect')
  @RequiresOperation('INSPECT')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  inspect(@CurrentCaller() caller: Caller, @CurrentAudit() trail: AuditTrail): Promise<InspectResult> {
    return this.inspector.inspect(caller, trail);
  }
}
