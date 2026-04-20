const nodemailer = require('nodemailer')

let transporter

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_SECURE || 'true') === 'true',
      auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS,
      },
    })
  }

  return transporter
}

async function sendEmail({ to, subject, text, html }) {
  const transport = getTransporter()

  await transport.sendMail({
    from: process.env.MAIL_USER,
    to,
    subject,
    text,
    html,
  })
}

async function sendOtpEmail({ to, code }) {
  await sendEmail({
    to,
    subject: 'Your InnoBlog login OTP',
    text: `Your InnoBlog OTP is ${code}. It expires in 10 minutes.`,
    html: `
      <div style="font-family:Arial,sans-serif;padding:24px;background:#fff7f7;color:#1b0d0d">
        <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #ffd1d1;border-radius:18px;padding:32px">
          <p style="margin:0 0 12px;color:#d31313;font-size:12px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase">InnoBlog Login</p>
          <h1 style="margin:0 0 12px;font-size:28px;line-height:1.1;color:#120808">Use this OTP to sign in</h1>
          <p style="margin:0 0 20px;color:#5a3a3a;font-size:15px">Enter the following one-time password in the app. It expires in 10 minutes.</p>
          <div style="padding:18px 22px;border-radius:16px;background:#fff0f0;border:1px solid #ffbcbc;font-size:32px;font-weight:800;letter-spacing:0.28em;color:#d31313;text-align:center">${code}</div>
          <p style="margin:20px 0 0;color:#7a5555;font-size:13px">If you did not request this code, you can safely ignore this email.</p>
        </div>
      </div>
    `,
  })
}

module.exports = {
  sendEmail,
  sendOtpEmail,
}
