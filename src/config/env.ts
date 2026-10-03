import { DynamicModule, Global, Module } from '@nestjs/common';

/** Injection token for the environment the app was created with. */
export const ENV = Symbol('ENV');

/**
 * All configuration comes from environment variables. The app receives them as
 * one object instead of reading process.env directly, so tests can build apps
 * with their own settings.
 */
export type Env = Readonly<Record<string, string | undefined>>;

export function isProduction(env: Env): boolean {
  return env.NODE_ENV === 'production';
}

@Global()
@Module({})
export class EnvModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: EnvModule,
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }
}
