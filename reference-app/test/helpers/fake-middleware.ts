import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** A self-signed certificate for localhost in a temp directory (uses openssl). */
export function makeCert(): { dir: string; certPath: string; cert: Buffer; key: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'ref-cert-'));
  execFileSync(process.execPath, [resolve(__dirname, '../../../scripts/dev-certs.js'), dir], { stdio: 'pipe' });
  const certPath = join(dir, 'dev-cert.pem');
  return { dir, certPath, cert: readFileSync(certPath), key: readFileSync(join(dir, 'dev-key.pem')) };
}

/**
 * Stand-in for the tokenization middleware over HTTPS. Mimics the three
 * endpoints and their status codes, checks the Bearer key, and records calls.
 */
export class FakeMiddleware {
  readonly vault = new Map<string, { value: string; erased: boolean }>();
  readonly calls: { path: string; authorized: boolean }[] = [];
  /** When set, every request gets this status with an echo of the request body. */
  failWith: number | null = null;
  private server!: Server;
  port = 0;

  constructor(
    private readonly tls: { cert: Buffer; key: Buffer },
    private readonly apiKey: string,
  ) {}

  async start(): Promise<void> {
    this.server = createServer(this.tls, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const authorized = req.headers.authorization === `Bearer ${this.apiKey}`;
        this.calls.push({ path: req.url ?? '', authorized });
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (this.failWith !== null) return send(this.failWith, { message: 'failure', echo: raw });
        if (!authorized) return send(401, { message: 'invalid or missing API key' });
        const body = JSON.parse(raw);
        const record = this.vault.get(body.token);
        switch (req.url) {
          case '/v1/tokenize': {
            const token = randomBytes(16).toString('hex');
            this.vault.set(token, { value: body.value, erased: false });
            return send(201, { token });
          }
          case '/v1/detokenize':
            return record && !record.erased
              ? send(200, { dataType: 'BVN', value: record.value })
              : send(404, { message: 'token not found' });
          case '/v1/erase':
            if (!record || record.erased) return send(404, { message: 'token not found' });
            record.erased = true;
            return send(200, { erased: true });
          default:
            return send(404, { message: 'no route' });
        }
      });
    });
    await new Promise<void>((done) => this.server.listen(0, '127.0.0.1', done));
    this.port = (this.server.address() as { port: number }).port;
  }

  get url(): string {
    return `https://localhost:${this.port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((done) => this.server.close(() => done()));
  }
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
