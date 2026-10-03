import { Module } from '@nestjs/common';
import { DevKeyProvider } from './dev-key-provider';
import { KeyProvider } from './key-provider';

@Module({
  // TEMPORARY: increment 4 swaps DevKeyProvider for the real key layer.
  providers: [{ provide: KeyProvider, useClass: DevKeyProvider }],
  exports: [KeyProvider],
})
export class KeysModule {}
