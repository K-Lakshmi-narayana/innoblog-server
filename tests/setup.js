process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret'
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/innoblog-test'
process.env.MAIL_USER = process.env.MAIL_USER || 'test@example.com'
process.env.MAIL_PASS = process.env.MAIL_PASS || 'test-password'
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com'
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173'

// Suppress console logs during tests
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}
