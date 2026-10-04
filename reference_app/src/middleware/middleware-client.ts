import { readFileSync } from 'node:fs';
import { Agent, request } from 'node:https';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ENV, Env } from '../config/env';

const API_KEY_FORMAT = /^tkm_[A-Za-z0-9_-]{43}$/;
const TOKEN_FORMAT = /^[0-9a-f]{32}$/;
const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 5000;

/** The middleware failed or refused. Never carries a response body or identifier. */
export class MiddlewareError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? 'middleware unreachable' : `middleware responded ${status}`);
    this.name = 'MiddlewareError';
  }
}

/**
 * Read an API key from exactly one of <name> or <name>_FILE (by default
 * REFERENCE_API_KEY). A key from <name> is removed from the environment once read.
 */
export function takeApiKey(env: Env, name = 'REFERENCE_API_KEY'): string {
  const inline = env[name];
  const file = env[`${name}_FILE`];
  if (inline !== undefined) {
    delete env[name];
    delete process.env[name];
  }
  if (inline && file) {
    throw new Error(`set only one of ${name} and ${name}_FILE`);
  }
  let key: string;
  if (inline) {
    key = inline;
  } else if (file) {
    try {
      key = readFileSync(file, 'utf8').trim();
    } catch {
      throw new Error(`${name}_FILE could not be read`);
    }
  } else {
    throw new Error(`no API key: set ${name} or ${name}_FILE`);
  }
  if (!API_KEY_FORMAT.test(key)) {
    throw new Error(`the key in ${name} is not in the expected tkm_ format`);
  }
  return key;
}

/** Demo only: true when DEMO_PASSWORD_FILE is set (page, demo routes, Basic auth). */
export function demoEnabled(env: Env): boolean {
  return Boolean(env.DEMO_PASSWORD_FILE);
}

/**
 * Client for the tokenization middleware. HTTPS only, and the only trusted
 * certificate is the middleware's (MIDDLEWARE_CA_PATH): system CAs are not used.
 */
@Injectable()
export class MiddlewareClient implements OnModuleDestroy {
  private readonly base: URL;
  private readonly agent: Agent;
  readonly #authorization: string;
  /** Demo only: a separate credential holding just the INSPECT scope. */
  readonly #inspectAuthorization: string | null;

  constructor(@Inject(ENV) env: Env) {
    let base: URL;
    try {
      base = new URL(env.MIDDLEWARE_URL ?? '');
    } catch {
      throw new Error('MIDDLEWARE_URL must be an https:// URL');
    }
    if (base.protocol !== 'https:') {
      throw new Error('MIDDLEWARE_URL must be an https:// URL');
    }
    if (!env.MIDDLEWARE_CA_PATH) {
      throw new Error('MIDDLEWARE_CA_PATH must point to the middleware certificate');
    }
    let ca: Buffer;
    try {
      ca = readFileSync(env.MIDDLEWARE_CA_PATH);
    } catch {
      throw new Error('MIDDLEWARE_CA_PATH could not be read');
    }
    this.base = base;
    // `ca` replaces Node's default trust store, so only this certificate is trusted.
    this.agent = new Agent({ ca, keepAlive: true, rejectUnauthorized: true });
    this.#authorization = `Bearer ${takeApiKey(env)}`;
    this.#inspectAuthorization = demoEnabled(env) ? `Bearer ${takeApiKey(env, 'REFERENCE_INSPECT_KEY')}` : null;
  }

  /**
   * Demo only: what the vault stores for this application, from the
   * middleware's inspect endpoint (stored bytes as hex, never plaintext).
   */
  async inspect(): Promise<{ records: unknown[]; audit: unknown[] }> {
    if (!this.#inspectAuthorization) {
      throw new MiddlewareError(null);
    }
    const { status, body } = await this.post('/v1/demo/inspect', {}, this.#inspectAuthorization);
    if (status !== 200 || !Array.isArray(body?.records) || !Array.isArray(body?.audit)) {
      throw new MiddlewareError(status);
    }
    return { records: body.records as unknown[], audit: body.audit as unknown[] };
  }

  async tokenize(bvn: string): Promise<string> {
    const { status, body } = await this.post('/v1/tokenize', { dataType: 'BVN', value: bvn });
    if (status !== 201 || typeof body?.token !== 'string' || !TOKEN_FORMAT.test(body.token)) {
      throw new MiddlewareError(status);
    }
    return body.token;
  }

  /** The BVN for a token, or null if the middleware says not found (unknown or erased). */
  async detokenize(token: string): Promise<string | null> {
    const { status, body } = await this.post('/v1/detokenize', { token });
    if (status === 404) {
      return null;
    }
    if (status !== 200 || typeof body?.value !== 'string') {
      throw new MiddlewareError(status);
    }
    return body.value;
  }

  /** True if erased now, false if the middleware says not found. */
  async erase(token: string): Promise<boolean> {
    const { status, body } = await this.post('/v1/erase', { token });
    if (status === 404) {
      return false;
    }
    if (status !== 200 || body?.erased !== true) {
      throw new MiddlewareError(status);
    }
    return true;
  }

  onModuleDestroy(): void {
    this.agent.destroy();
  }

  private post(
    path: string,
    payload: object,
    authorization = this.#authorization,
  ): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const data = JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const req = request(
        new URL(path, this.base),
        {
          method: 'POST',
          agent: this.agent,
          timeout: TIMEOUT_MS,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(data),
            authorization,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              req.destroy();
              reject(new MiddlewareError(res.statusCode ?? null));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            let body: Record<string, unknown> | null = null;
            try {
              const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
            } catch {
              body = null;
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
          res.on('error', () => reject(new MiddlewareError(res.statusCode ?? null)));
        },
      );
      req.on('timeout', () => req.destroy());
      // Connection, TLS and certificate errors all map to "unreachable", with no detail.
      req.on('error', () => reject(new MiddlewareError(null)));
      req.end(data);
    });
  }
}
