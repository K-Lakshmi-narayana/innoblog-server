const path = require('path')
const dotenv = require('dotenv')

dotenv.config({
  path: path.resolve(__dirname, '../.env'),
})

const { sendOtpEmail } = require('../utils/mail')

async function main() {
  if (!process.env.MAIL_USER || !process.env.MAIL_PASS) {
    throw new Error('MAIL_USER and MAIL_PASS must be configured before running the SMTP smoke test.')
  }

  const recipient = process.env.SMTP_SMOKE_TO || process.env.MAIL_USER

  await sendOtpEmail({
    to: recipient,
    code: '123456',
  })

  console.log('SMTP OTP smoke email accepted by the configured transport.')
}

main().catch((error) => {
  console.error('SMTP smoke test failed:', error.message)
  process.exit(1)
})
