import { randomInt } from 'node:crypto';

/** Random 11-digit string shaped like a BVN. Synthetic test data only. */
export function syntheticBvn(): string {
  let bvn = '';
  for (let i = 0; i < 11; i++) {
    bvn += randomInt(0, 10).toString();
  }
  return bvn;
}
