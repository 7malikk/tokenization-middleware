import { Module } from '@nestjs/common';
import { CryptoModule } from './crypto/crypto.module';

@Module({
  imports: [CryptoModule],
})
export class AppModule {}
