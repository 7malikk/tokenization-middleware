import { Bytes } from '../crypto/crypto';

export interface WrappedDataKey {
  wrapped: Bytes;
  version: number;
}

/**
 * Key layer seam. Wraps and unwraps per-record data keys under the master key.
 * The master key never leaves the implementation.
 */
export abstract class KeyProvider {
  abstract wrap(dataKey: Buffer): Promise<WrappedDataKey>;
  /** Throws if the version is unknown or the wrapped key fails its integrity check. */
  abstract unwrap(wrapped: Buffer, version: number): Promise<Bytes>;
}
