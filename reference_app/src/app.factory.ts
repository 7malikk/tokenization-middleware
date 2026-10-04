import { LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { Env } from './config/env';

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
  return NestFactory.create<NestFastifyApplication>(AppModule.forRoot(env), adapter, {
    abortOnError: false,
    bodyParser: false,
    ...(options.nestLogger ? { logger: options.nestLogger } : {}),
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
