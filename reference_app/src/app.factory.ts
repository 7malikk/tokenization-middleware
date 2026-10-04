import { LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { Env } from './config/env';
import { basicAuthChecker, readDemoPassword, REALM } from './demo/basic-auth';
import { demoEnabled } from './middleware/middleware-client';

export const BODY_LIMIT_BYTES = 4096;

export interface CreateAppOptions {
  logStream?: NodeJS.WritableStream;
  nestLogger?: LoggerService;
}

/** Build the app from an explicit environment. Throws instead of exiting on bad config. */
export async function createApp(env: Env, options: CreateAppOptions = {}): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    bodyLimit: BODY_LIMIT_BYTES,
    logger: {
      level: env.LOG_LEVEL ?? 'info',
      ...(options.logStream ? { stream: options.logStream } : {}),
      // Never log bodies or headers.
      serializers: {
        req: (req: { method: string; url: string; id: string }) => ({ method: req.method, url: req.url, reqId: req.id }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    },
  });
  acceptJsonOnly(adapter);
  secureHeaders(adapter);
  if (demoEnabled(env)) {
    requireBasicAuth(adapter, readDemoPassword(env.DEMO_PASSWORD_FILE as string));
  }
  return NestFactory.create<NestFastifyApplication>(AppModule.forRoot(env), adapter, {
    abortOnError: false,
    bodyParser: false,
    ...(options.nestLogger ? { logger: options.nestLogger } : {}),
  });
}

// No inline script or style, nothing from other origins, no framing. Fonts are self-hosted.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function secureHeaders(adapter: FastifyAdapter): void {
  adapter.getInstance().addHook('onSend', async (_req, reply, payload) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    return payload;
  });
}

/**
 * Demo only: HTTP Basic auth on every route, unknown ones included, checked
 * before routing. The password is compared in constant time.
 */
function requireBasicAuth(adapter: FastifyAdapter, password: string): void {
  const check = basicAuthChecker(password);
  adapter.getInstance().addHook('onRequest', async (req, reply) => {
    if (!check(req.headers.authorization)) {
      return reply
        .code(401)
        .header('WWW-Authenticate', REALM)
        .header('Cache-Control', 'no-store')
        .send({ statusCode: 401, message: 'authentication required' });
    }
  });
}

/** JSON only; parse errors get a fixed message instead of quoting the body. */
function acceptJsonOnly(adapter: FastifyAdapter): void {
  const fastify = adapter.getInstance();
  fastify.removeAllContentTypeParsers();
  const parse = fastify.getDefaultJsonParser('error', 'error');
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    parse(req, body as string, (err, value) => {
      if (err) {
        done(Object.assign(new Error('request body is not valid JSON'), { statusCode: 400 }), undefined);
        return;
      }
      done(null, value);
    });
  });
}
