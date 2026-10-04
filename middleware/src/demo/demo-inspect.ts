import { Env } from '../config/env';

/** DEMO_INSPECT: "true" turns the demo inspect endpoint on; unset or "false" leaves it off. */
export function demoInspectEnabled(env: Env): boolean {
  const value = env.DEMO_INSPECT;
  if (value === undefined || value === '' || value === 'false') {
    return false;
  }
  if (value === 'true') {
    return true;
  }
  throw new Error('DEMO_INSPECT must be "true" or "false"');
}
