import { Module } from '@nestjs/common';
import { FileKeyProvider } from './file-key-provider';
import { KeyProvider } from './key-provider';

@Module({
  providers: [{ provide: KeyProvider, useClass: FileKeyProvider }],
  exports: [KeyProvider],
})
export class KeysModule {}
