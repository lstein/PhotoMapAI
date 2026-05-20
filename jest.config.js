/** @type {import('jest').Config} */
export default {
  testEnvironment: 'jsdom',
  testMatch: ['**/tests/frontend/**/*.test.js'],
  setupFilesAfterEnv: ['./tests/frontend/setup.js'],
  moduleFileExtensions: ['js'],
  transform: {},
  verbose: true,
  // Native ESM has no Istanbul instrumentation, so use V8's built-in
  // coverage. Only collect over the production frontend modules — tests
  // and node_modules would skew the numbers.
  coverageProvider: 'v8',
  collectCoverageFrom: ['photomap/frontend/static/javascript/**/*.js'],
  coverageReporters: ['text-summary', 'text']
};
