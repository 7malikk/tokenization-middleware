import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp } from './app.factory';
import { loadEnv } from './load-env';

async function bootstrap(): Promise<void> {
  loadEnv();
  const app = await createApp(process.env);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

bootstrap().catch((err: unknown) => {
  new Logger('Bootstrap').error(err instanceof Error ? err.message : 'startup failed');
  process.exit(1);
});
