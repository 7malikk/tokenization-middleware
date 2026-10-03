import { Inject, Injectable } from '@nestjs/common';
import { Bytes, KEY_BYTES, unwrapKey, wrapKey } from '../crypto/crypto';
import { ENV, Env, isProduction } from '../config/env';
import { KeyProvider, WrappedDataKey } from './key-provider';

const VERSION = 1;

/**
 * TEMPORARY (increment 2). Development stand-in for the key layer: reads the
 * master key in plain hex from MASTER_KEY_DEV. Increment 4 replaces it with
 * the encrypted master key file unlocked by a KEK at startup.
 */
@Injectable()
export class DevKeyProvider extends KeyProvider {
  readonly #masterKey: Buffer;

  constructor(@Inject(ENV) env: Env) {
    super();
    if (isProduction(env)) {
      throw new Error('DevKeyProvider must not run when NODE_ENV=production');
    }
    const hex = env.MASTER_KEY_DEV ?? '';
    if (!new RegExp(`^[0-9a-fA-F]{${KEY_BYTES * 2}}$`).test(hex)) {
      throw new Error(`MASTER_KEY_DEV must be ${KEY_BYTES * 2} hex characters`);
    }
    this.#masterKey = Buffer.from(hex, 'hex');
  }

  async wrap(dataKey: Buffer): Promise<WrappedDataKey> {
    return { wrapped: wrapKey(dataKey, this.#masterKey), version: VERSION };
  }

  async unwrap(wrapped: Buffer, version: number): Promise<Bytes> {
    if (version !== VERSION) {
      throw new Error('unknown master key version');
    }
    return unwrapKey(wrapped, this.#masterKey);
  }
}
