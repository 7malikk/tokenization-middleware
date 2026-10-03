/** Time source in epoch milliseconds. Injectable so tests can move time. */
export abstract class Clock {
  abstract now(): number;
}

export class SystemClock extends Clock {
  now(): number {
    return Date.now();
  }
}
