import { Module } from '@nestjs/common';
import { CryptoModule } from '../crypto/crypto.module';
import { KeysModule } from '../keys/keys.module';
import { PrismaModule } from '../prisma/prisma.module';
import { VaultController } from './vault.controller';
import { VaultService } from './vault.service';

@Module({
  imports: [CryptoModule, KeysModule, PrismaModule],
  controllers: [VaultController],
  providers: [VaultService],
  exports: [VaultService],
})
export class VaultModule {}
