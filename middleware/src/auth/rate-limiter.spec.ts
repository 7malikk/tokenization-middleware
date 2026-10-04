import { randomUUID } from 'node:crypto';
import { TestClock } from '../../test/helpers/test-clock';
import { rateLimitPerMinute, RateLimiter, WINDOW_MS } from './rate-limiter';

describe('RateLimiter', () => {
  function limiter(limit: string, clock = new TestClock()) {
    return { clock, limiter: new RateLimiter({ RATE_LIMIT_PER_MINUTE: limit }, clock) };
  }

  it('allows up to the limit in a window, then refuses with Retry-After', () => {
    const { limiter: rl } = limiter('3');
    const id = randomUUID();
    expect([1, 2, 3].map(() => rl.check(id, 'TOKENIZE').allowed)).toEqual([true, true, true]);
    expect(rl.check(id, 'TOKENIZE')).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it('counts each credential and each operation separately', () => {
    const { limiter: rl } = limiter('1');
    const a = randomUUID();
    expect(rl.check(a, 'TOKENIZE').allowed).toBe(true);
    expect(rl.check(a, 'TOKENIZE').allowed).toBe(false);
    expect(rl.check(a, 'DETOKENIZE').allowed).toBe(true);
    expect(rl.check(randomUUID(), 'TOKENIZE').allowed).toBe(true);
  });

  it('reports the seconds left in the window and resets when it ends', () => {
    const { limiter: rl, clock } = limiter('1');
    const id = randomUUID();
    rl.check(id, 'ERASE');
    clock.advance(45_500);
    expect(rl.check(id, 'ERASE')).toEqual({ allowed: false, retryAfterSeconds: 15 });
    clock.advance(14_500);
    expect(rl.check(id, 'ERASE').allowed).toBe(true);
  });

  it('cleans up windows from earlier minutes', () => {
    const { limiter: rl, clock } = limiter('5');
    for (let i = 0; i < 50; i++) {
      rl.check(randomUUID(), 'TOKENIZE');
    }
    expect(rl.size).toBe(50);
    clock.advance(WINDOW_MS);
    rl.check(randomUUID(), 'TOKENIZE');
    expect(rl.size).toBe(1);
  });

  it('reads RATE_LIMIT_PER_MINUTE, default 600, and refuses bad values', () => {
    expect(rateLimitPerMinute({})).toBe(600);
    expect(rateLimitPerMinute({ RATE_LIMIT_PER_MINUTE: '50000' })).toBe(50000);
    for (const bad of ['0', '-1', '1.5', 'abc', ' 10']) {
      expect(() => rateLimitPerMinute({ RATE_LIMIT_PER_MINUTE: bad })).toThrow('positive integer');
    }
  });
});
