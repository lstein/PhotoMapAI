/** @type {import('jest').Config} */
export default {
  testEnvironment: 'jsdom',
  testMatch: ['**/tests/frontend/**/*.test.js'],
  setupFilesAfterEnv: ['./tests/frontend/setup.js'],
  moduleFileExtensions: ['js'],
  transform: {},
  verbose: true
};
