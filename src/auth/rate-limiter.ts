import { Inject, Injectable } from '@nestjs/common';
import { Operation } from '@prisma/client';
import { ENV, Env } from '../config/env';
import { Clock } from './clock';

export const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 600;

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** RATE_LIMIT_PER_MINUTE as a positive integer (default 600). */
export function rateLimitPerMinute(env: Env): number {
  const raw = env.RATE_LIMIT_PER_MINUTE;
  if (raw === undefined || raw === '') {
    return DEFAULT_LIMIT;
  }
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error('RATE_LIMIT_PER_MINUTE must be a positive integer');
  }
  return Number(raw);
}

/**
 * Fixed one-minute windows per credential and operation, held in memory.
 * Correct for a single instance only, which matches the single-host deployment.
 */
@Injectable()
export class RateLimiter {
  private readonly limit: number;
  private readonly windows = new Map<string, { start: number; count: number }>();
  private lastSweep = 0;

  constructor(
    @Inject(ENV) env: Env,
    private readonly clock: Clock,
  ) {
    this.limit = rateLimitPerMinute(env);
  }

  check(credentialId: string, operation: Operation): RateLimitDecision {
    const now = this.clock.now();
    const start = now - (now % WINDOW_MS);
    this.sweep(start);

    const key = `${credentialId}:${operation}`;
    let window = this.windows.get(key);
    if (!window || window.start !== start) {
      window = { start, count: 0 };
      this.windows.set(key, window);
    }
    if (window.count >= this.limit) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((start + WINDOW_MS - now) / 1000)) };
    }
    window.count += 1;
    return { allowed: true };
  }

  /** Number of windows held, for tests of the cleanup. */
  get size(): number {
    return this.windows.size;
  }

  /** Drop windows from earlier minutes, at most once per window. */
  private sweep(currentStart: number): void {
    if (currentStart === this.lastSweep) {
      return;
    }
    for (const [key, window] of this.windows) {
      if (window.start < currentStart) {
        this.windows.delete(key);
      }
    }
    this.lastSweep = currentStart;
  }
}
