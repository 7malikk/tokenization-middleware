import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Controller, Get, Header, NotFoundException, Param, Res, UseFilters } from '@nestjs/common';
import { MiddlewareClient } from '../middleware/middleware-client';
import { MiddlewareErrorFilter } from '../middleware/middleware-error.filter';
import { PrismaService } from '../prisma/prisma.module';

const PUBLIC_DIR = resolve(__dirname, '../../public');

// The page's files, read once at startup. Nothing else is served from disk.
const ASSETS = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
  'fonts/archivo.woff2': 'font/woff2',
  'fonts/jetbrains-mono.woff2': 'font/woff2',
} as const;
type Asset = keyof typeof ASSETS;

interface Reply {
  header(name: string, value: string): Reply;
  send(body: Buffer): void;
}

/**
 * DEMO ONLY. Registered only when DEMO_PASSWORD_FILE is set, behind Basic auth.
 * Serves the demonstration page and the two read-only views it needs.
 */
@Controller()
@UseFilters(MiddlewareErrorFilter)
export class DemoController {
  private readonly files: Record<Asset, Buffer>;

  constructor(
    private readonly db: PrismaService,
    private readonly middleware: MiddlewareClient,
  ) {
    this.files = Object.fromEntries(
      (Object.keys(ASSETS) as Asset[]).map((name) => [name, readFileSync(join(PUBLIC_DIR, name))]),
    ) as Record<Asset, Buffer>;
  }

  @Get()
  page(@Res() reply: Reply): void {
    this.serve(reply, 'index.html');
  }

  @Get('app.js')
  script(@Res() reply: Reply): void {
    this.serve(reply, 'app.js');
  }

  @Get('app.css')
  styles(@Res() reply: Reply): void {
    this.serve(reply, 'app.css');
  }

  @Get('fonts/:name')
  font(@Param('name') name: string, @Res() reply: Reply): void {
    const asset = `fonts/${name}`;
    if (!Object.hasOwn(ASSETS, asset)) throw new NotFoundException();
    this.serve(reply, asset as Asset);
  }

  /** The app database: customers with their tokens. There is no BVN to show. */
  @Get('customers')
  @Header('Cache-Control', 'no-store')
  async customers(): Promise<{ id: string; fullName: string; bvnToken: string }[]> {
    return this.db.customer.findMany({
      select: { id: true, fullName: true, bvnToken: true },
      orderBy: { fullName: 'asc' },
      take: 200,
    });
  }

  /** What the vault holds for this application, via the middleware's demo inspect endpoint. */
  @Get('demo/vault')
  @Header('Cache-Control', 'no-store')
  vault(): Promise<{ records: unknown[]; audit: unknown[] }> {
    return this.middleware.inspect();
  }

  private serve(reply: Reply, name: Asset): void {
    reply.header('Content-Type', ASSETS[name]).header('Cache-Control', 'no-store').send(this.files[name]);
  }
}
