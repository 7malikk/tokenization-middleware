import { Body, Controller, Header, HttpCode, NotFoundException, Post } from '@nestjs/common';
import { AuditTrail, Caller, CurrentAudit, CurrentCaller } from '../auth/request-context';
import { RequiresOperation } from '../auth/requires-operation.decorator';
import { TokenBody, TokenBodyPipe, TokenizeBody, TokenizeBodyPipe } from './vault.pipes';
import { VaultService } from './vault.service';

/**
 * The single not-found response. Unknown, another application's, and erased
 * tokens are indistinguishable to the caller.
 */
function tokenNotFound(): NotFoundException {
  return new NotFoundException('token not found');
}

// POST for all three, so tokens and identifiers never appear in URLs or access logs.
@Controller('v1')
export class VaultController {
  constructor(private readonly vault: VaultService) {}

  @Post('tokenize')
  @RequiresOperation('TOKENIZE')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  async tokenize(
    @CurrentCaller() caller: Caller,
    @CurrentAudit() trail: AuditTrail,
    @Body(TokenizeBodyPipe) body: TokenizeBody,
  ): Promise<{ token: string }> {
    return { token: await this.vault.tokenize(caller, trail, body.dataType, body.value) };
  }

  @Post('detokenize')
  @RequiresOperation('DETOKENIZE')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async detokenize(
    @CurrentCaller() caller: Caller,
    @CurrentAudit() trail: AuditTrail,
    @Body(TokenBodyPipe) body: TokenBody,
  ): Promise<{ dataType: string; value: string }> {
    const result = await this.vault.detokenize(caller, trail, body.token);
    if (!result.found) {
      throw tokenNotFound();
    }
    return { dataType: result.dataType, value: result.value };
  }

  @Post('erase')
  @RequiresOperation('ERASE')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async erase(
    @CurrentCaller() caller: Caller,
    @CurrentAudit() trail: AuditTrail,
    @Body(TokenBodyPipe) body: TokenBody,
  ): Promise<{ erased: true }> {
    const result = await this.vault.erase(caller, trail, body.token);
    if (!result.found) {
      throw tokenNotFound();
    }
    return { erased: true };
  }
}
