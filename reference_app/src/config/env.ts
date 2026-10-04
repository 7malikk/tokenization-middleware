import { DynamicModule, Global, Module } from '@nestjs/common';

/** Injection token for the environment the app was created with. */
export const ENV = Symbol('ENV');

/** All configuration comes from environment variables, passed in as one object. */
export type Env = Record<string, string | undefined>;

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
