import { BadRequestException, Inject, Injectable, PipeTransform } from '@nestjs/common';
import { ENV, Env } from '../config/env';

// Validation error messages are fixed strings. They never echo a submitted value.

/** Accepted value format per data type. */
export const DATA_TYPE_FORMATS: Readonly<Record<string, RegExp>> = {
  BVN: /^[0-9]{11}$/,
};

const TOKEN_FORMAT = /^[0-9a-f]{32}$/;

/** True for 32 lowercase hex chars, the only shape a token can have. */
export function isWellFormedToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_FORMAT.test(token);
}

export interface TokenizeBody {
  dataType: string;
  value: string;
}

export interface TokenBody {
  token: string;
}

/** Parse ALLOWED_DATA_TYPES (comma-separated, default BVN). Every type needs a known format. */
export function allowedDataTypes(env: Env): ReadonlySet<string> {
  const types = (env.ALLOWED_DATA_TYPES ?? 'BVN')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (types.length === 0) {
    throw new Error('ALLOWED_DATA_TYPES must list at least one data type');
  }
  for (const type of types) {
    if (!Object.hasOwn(DATA_TYPE_FORMATS, type)) {
      throw new Error(`ALLOWED_DATA_TYPES contains a data type with no known format: ${type}`);
    }
  }
  return new Set(types);
}

function expectObjectWithKeys(body: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) {
      throw new BadRequestException(`request body may only contain: ${keys.join(', ')}`);
    }
  }
  return record;
}

@Injectable()
export class TokenizeBodyPipe implements PipeTransform<unknown, TokenizeBody> {
  private readonly allowed: ReadonlySet<string>;

  constructor(@Inject(ENV) env: Env) {
    this.allowed = allowedDataTypes(env);
  }

  transform(body: unknown): TokenizeBody {
    const { dataType, value } = expectObjectWithKeys(body, ['dataType', 'value']);
    if (typeof dataType !== 'string' || !this.allowed.has(dataType)) {
      throw new BadRequestException('dataType is not an allowed data type');
    }
    if (typeof value !== 'string' || !DATA_TYPE_FORMATS[dataType].test(value)) {
      throw new BadRequestException(
        dataType === 'BVN' ? 'value must be exactly 11 digits' : 'value has the wrong format',
      );
    }
    return { dataType, value };
  }
}

@Injectable()
export class TokenBodyPipe implements PipeTransform<unknown, TokenBody> {
  transform(body: unknown): TokenBody {
    const { token } = expectObjectWithKeys(body, ['token']);
    if (!isWellFormedToken(token)) {
      throw new BadRequestException('token must be 32 lowercase hex characters');
    }
    return { token };
  }
}
