import { Body, Controller, Header, HttpCode, NotFoundException, Post } from '@nestjs/common';
import { CallerAppId } from '../auth/caller';
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
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  async tokenize(
    @CallerAppId() appId: string,
    @Body(TokenizeBodyPipe) body: TokenizeBody,
  ): Promise<{ token: string }> {
    return { token: await this.vault.tokenize(appId, body.dataType, body.value) };
  }

  @Post('detokenize')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async detokenize(
    @CallerAppId() appId: string,
    @Body(TokenBodyPipe) body: TokenBody,
  ): Promise<{ dataType: string; value: string }> {
    const result = await this.vault.detokenize(appId, body.token);
    if (!result.found) {
      throw tokenNotFound();
    }
    return { dataType: result.dataType, value: result.value };
  }

  @Post('erase')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async erase(
    @CallerAppId() appId: string,
    @Body(TokenBodyPipe) body: TokenBody,
  ): Promise<{ erased: true }> {
    const result = await this.vault.erase(appId, body.token);
    if (!result.found) {
      throw tokenNotFound();
    }
    return { erased: true };
  }
}
