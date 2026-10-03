import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MiddlewareClient, takeApiKey } from './middleware-client';

const KEY = 'tkm_' + 'A'.repeat(43);

describe('takeApiKey', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'ref-key-'))));
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.REFERENCE_API_KEY;
  });

  it('reads the key inline and removes it from the environment', () => {
    process.env.REFERENCE_API_KEY = KEY;
    const env = { REFERENCE_API_KEY: KEY };
    expect(takeApiKey(env)).toBe(KEY);
    expect(env.REFERENCE_API_KEY).toBeUndefined();
    expect(process.env.REFERENCE_API_KEY).toBeUndefined();
  });

  it('reads the key from a file', () => {
    writeFileSync(join(dir, 'key'), `${KEY}\n`);
    expect(takeApiKey({ REFERENCE_API_KEY_FILE: join(dir, 'key') })).toBe(KEY);
  });

  it('refuses none, both, unreadable, and malformed, without echoing the key', () => {
    writeFileSync(join(dir, 'key'), KEY);
    expect(() => takeApiKey({})).toThrow('no API key');
    expect(() => takeApiKey({ REFERENCE_API_KEY: KEY, REFERENCE_API_KEY_FILE: join(dir, 'key') })).toThrow('only one');
    expect(() => takeApiKey({ REFERENCE_API_KEY_FILE: join(dir, 'missing') })).toThrow('could not be read');
    const bad = 'tkm_short';
    expect(() => takeApiKey({ REFERENCE_API_KEY: bad })).toThrow(/^(?!.*tkm_short).*$/);
  });
});

describe('MiddlewareClient configuration', () => {
  it('refuses a non-HTTPS middleware URL', () => {
    expect(
      () => new MiddlewareClient({ MIDDLEWARE_URL: 'http://localhost:3000', MIDDLEWARE_CA_PATH: '/x', REFERENCE_API_KEY: KEY }),
    ).toThrow('https://');
  });

  it('requires the middleware certificate', () => {
    expect(() => new MiddlewareClient({ MIDDLEWARE_URL: 'https://localhost:3000', REFERENCE_API_KEY: KEY })).toThrow(
      'MIDDLEWARE_CA_PATH',
    );
  });
});
