import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKekHex, initKeyFile, readKeyFile, unlockKeyFile } from '../../src/keys/key-file';

/** A throwaway KEK and master key file in a temp directory. */
export class TestKeys {
  readonly dir = mkdtempSync(join(tmpdir(), 'vault-keys-'));
  readonly keyFile = join(this.dir, 'master-keys.json');
  readonly kekFile = join(this.dir, 'kek');
  readonly kekHex = generateKekHex();

  private readonly known: string[] = [];

  constructor() {
    initKeyFile(this.keyFile, Buffer.from(this.kekHex, 'hex'));
    writeFileSync(this.kekFile, `${this.kekHex}\n`, { mode: 0o600 });
    this.refreshSecrets();
  }

  /** Env for the key layer, with the KEK inline or as a file path. */
  env(source: 'inline' | 'file' = 'file'): Record<string, string> {
    return source === 'inline'
      ? { MASTER_KEY_FILE: this.keyFile, MASTER_KEK: this.kekHex }
      : { MASTER_KEY_FILE: this.keyFile, MASTER_KEK_FILE: this.kekFile };
  }

  /** Every secret these keys have involved, in the encodings a leak could take. */
  secrets(): string[] {
    return [...this.known];
  }

  /** Re-read the key file and remember any new master key versions (after a rotation). */
  refreshSecrets(): void {
    const masterKeys = unlockKeyFile(readKeyFile(this.keyFile), Buffer.from(this.kekHex, 'hex'));
    for (const b of [Buffer.from(this.kekHex, 'hex'), ...masterKeys.values()]) {
      for (const s of [b.toString('hex'), b.toString('hex').toUpperCase(), b.toString('base64')]) {
        if (!this.known.includes(s)) this.known.push(s);
      }
    }
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
