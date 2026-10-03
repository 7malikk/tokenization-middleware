/** Integration tests: need a reachable PostgreSQL at TEST_DATABASE_URL. */
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/test/integration'],
  testMatch: ['**/*.int-spec.ts'],
  transform: { '^.+\\.ts$': 'ts-jest' },
  moduleFileExtensions: ['ts', 'js', 'json'],
  setupFiles: ['<rootDir>/test/integration/setup-env.ts'],
  testTimeout: 60000,
};
