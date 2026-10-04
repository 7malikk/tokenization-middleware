import { Injectable } from '@nestjs/common';
import * as core from './crypto';

/** Thin NestJS provider over the plain functions in ./crypto. */
@Injectable()
export class CryptoService {
  generateToken(): string {
    return core.generateToken();
  }

  generateDataKey(): core.Bytes {
    return core.generateDataKey();
  }

  encrypt(plaintext: Buffer, dataKey: Buffer): core.EncryptedPayload {
    return core.encrypt(plaintext, dataKey);
  }

  decrypt(payload: core.EncryptedPayload, dataKey: Buffer): core.Bytes {
    return core.decrypt(payload, dataKey);
  }

  wrapKey(dataKey: Buffer, masterKey: Buffer): core.Bytes {
    return core.wrapKey(dataKey, masterKey);
  }

  unwrapKey(wrapped: Buffer, masterKey: Buffer): core.Bytes {
    return core.unwrapKey(wrapped, masterKey);
  }

  zeroize(buf: Buffer): void {
    core.zeroize(buf);
  }
}
