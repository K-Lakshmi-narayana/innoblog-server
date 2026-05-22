module.exports = {
  testEnvironment: 'node',
  collectCoverageFrom: [
    'index.js',
    'middleware/**/*.js',
    'models/**/*.js',
    'services/**/*.js',
    'utils/**/*.js',
    '!**/*.test.js',
    '!**/node_modules/**',
    '!**/config/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html', 'json'],
  testMatch: ['**/__tests__/**/*.test.js', '**/?(*.)+(spec|test).js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  testTimeout: 10000,
  verbose: true,
  bail: false,
  maxWorkers: 1,
  reporters: [
    'default',
    [
      'jest-html-reporter',
      {
        pageTitle: 'InnoBlog Backend Test Report',
        outputPath: 'coverage/jest-report.html',
        includeFailureMsg: true,
        includeConsoleLog: true,
      },
    ],
  ],
}
