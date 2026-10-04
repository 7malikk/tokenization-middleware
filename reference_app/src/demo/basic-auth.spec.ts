import { basicAuthChecker, DEMO_USER } from './basic-auth';

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe('basicAuthChecker', () => {
  const password = 'correct-horse-battery';
  const check = basicAuthChecker(password);

  it('accepts the demo user with the right password', () => {
    expect(check(basic(DEMO_USER, password))).toBe(true);
  });

  it.each([
    ['no header', undefined],
    ['wrong password', basic(DEMO_USER, 'wrong-password-123')],
    ['password with a suffix', basic(DEMO_USER, `${password}x`)],
    ['wrong user', basic('admin', password)],
    ['bearer scheme', `Bearer ${password}`],
    ['lowercase scheme', basic(DEMO_USER, password).replace('Basic', 'basic')],
    ['malformed base64', 'Basic !!!'],
    ['header list', [basic(DEMO_USER, password)]],
  ])('refuses %s', (_label, header) => {
    expect(check(header as string | string[] | undefined)).toBe(false);
  });
});
