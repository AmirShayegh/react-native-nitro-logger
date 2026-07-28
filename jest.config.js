/** Library unit tests run in plain Node — no RN runtime needed. Modules that
 * touch react-native APIs are tested through injected fakes. */
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.(js|jsx|ts|tsx)$': 'babel-jest',
  },
};
