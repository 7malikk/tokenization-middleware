import { readFileSync } from 'node:fs';
import { LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { Env } from './config/env';

export const BODY_LIMIT_BYTES = 4096;

export interface CreateAppOptions {
  /** Destination for Fastify's request log. Defaults to stdout. */
  logStream?: NodeJS.WritableStream;
  /** Logger for Nest's own messages. Defaults to Nest's console logger. */
  nestLogger?: LoggerService;
}

/** Build the app from an explicit environment. Throws instead of exiting on bad config. */
export async function createApp(env: Env, options: CreateAppOptions = {}): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    https: loadTls(env),
    bodyLimit: BODY_LIMIT_BYTES,
    logger: {
      level: env.LOG_LEVEL ?? 'info',
      ...(options.logStream ? { stream: options.logStream } : {}),
      // Never log bodies or headers: only what identifies the request.
      serializers: {
        req: (req: { method: string; url: string; id: string }) => ({
          method: req.method,
          url: req.url,
          reqId: req.id,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    },
  });
  acceptJsonOnly(adapter);

  return NestFactory.create<NestFastifyApplication>(AppModule.forRoot(env), adapter, {
    abortOnError: false,
    bodyParser: false,
    ...(options.nestLogger ? { logger: options.nestLogger } : {}),
  });
}

function loadTls(env: Env): { cert: Buffer; key: Buffer } {
  const certPath = env.TLS_CERT_PATH;
  const keyPath = env.TLS_KEY_PATH;
  if (!certPath || !keyPath) {
    throw new Error('TLS is required: set TLS_CERT_PATH and TLS_KEY_PATH (see `npm run dev:certs`)');
  }
  return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
}

/**
 * Accept only application/json, parsed with Fastify's prototype-poisoning-safe
 * parser. Parse errors are replaced with a fixed message, because the default
 * error quotes the malformed body, which could contain an identifier.
 */
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
