function loadEnv() {
  // No file reading — GitHub / hosting platform already provides env vars

  // Normalize variable names (fallbacks)
  if (!process.env.MONGODB_URI && process.env.mongo_db) {
    process.env.MONGODB_URI = process.env.mongo_db;
  }

  if (!process.env.MAIL_USER && process.env.mail) {
    process.env.MAIL_USER = process.env.mail;
  }

  if (!process.env.MAIL_PASS && process.env.mail_pass) {
    process.env.MAIL_PASS = process.env.mail_pass;
  }

  if (!process.env.ADMIN_EMAIL && process.env.MAIL_USER) {
    process.env.ADMIN_EMAIL = process.env.MAIL_USER;
  }

  // Optional: validation (VERY IMPORTANT in production)
  const requiredVars = ["MONGODB_URI", "MAIL_USER", "MAIL_PASS"];

  for (const key of requiredVars) {
    if (!process.env[key]) {
      throw new Error(`Missing required env variable: ${key}`);
    }
  }
}

module.exports = loadEnv;