/** Unit tests: no database, no network. */
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],
  transform: { '^.+\\.ts$': 'ts-jest' },
  moduleFileExtensions: ['ts', 'js', 'json'],
};
