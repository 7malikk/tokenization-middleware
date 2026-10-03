import { Clock } from '../../src/auth/clock';

/** A clock tests move by hand. */
export class TestClock extends Clock {
  constructor(private current = Date.UTC(2026, 0, 1, 12, 0, 0)) {
    super();
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
