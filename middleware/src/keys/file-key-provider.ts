import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Bytes, unwrapKey, wrapKey, zeroize } from '../crypto/crypto';
import { ENV, Env } from '../config/env';
import { KeyProvider, WrappedDataKey } from './key-provider';
import { readKeyFile, takeKek, unlockKeyFile, zeroizeAll } from './key-file';

/**
 * The key layer. At startup it reads the KEK (from MASTER_KEK or
 * MASTER_KEK_FILE), unwraps every master key version from MASTER_KEY_FILE into
 * private memory, and zeroizes the KEK. Master keys never leave this class.
 */
@Injectable()
export class FileKeyProvider extends KeyProvider implements OnModuleDestroy {
  readonly #masterKeys: Map<number, Bytes>;
  readonly #active: number;

  constructor(@Inject(ENV) env: Env) {
    super();
    const kek = takeKek(env as Record<string, string | undefined>);
    try {
      const file = readKeyFile(env.MASTER_KEY_FILE);
      this.#masterKeys = unlockKeyFile(file, kek);
      this.#active = file.active;
    } finally {
      zeroize(kek);
    }
  }

  async wrap(dataKey: Buffer): Promise<WrappedDataKey> {
    return { wrapped: wrapKey(dataKey, this.#key(this.#active)), version: this.#active };
  }

  async unwrap(wrapped: Buffer, version: number): Promise<Bytes> {
    return unwrapKey(wrapped, this.#key(version));
  }

  onModuleDestroy(): void {
    zeroizeAll(this.#masterKeys);
  }

  #key(version: number): Bytes {
    const key = this.#masterKeys.get(version);
    if (!key) {
      throw new Error('unknown master key version');
    }
    return key;
  }
}
