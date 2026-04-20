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

async function sendWriterAccessGrantedEmail({ to, grantedBy }) {
  await sendEmail({
    to,
    subject: 'You now have writer access on InnoBlog',
    text: `Your account has been granted writer access on InnoBlog. You can now create and submit articles for publication.`,
    html: `
      <div style="font-family:Arial,sans-serif;padding:24px;background:#fff7f7;color:#1b0d0d">
        <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #ffd1d1;border-radius:18px;padding:32px">
          <p style="margin:0 0 12px;color:#d31313;font-size:12px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase">InnoBlog Writer Access</p>
          <h1 style="margin:0 0 12px;font-size:28px;line-height:1.1;color:#120808">You're now a writer on InnoBlog</h1>
          <p style="margin:0 0 20px;color:#5a3a3a;font-size:15px">Congratulations! Your account has been granted writer access. You can now:</p>
          <ul style="margin:0 0 20px;color:#5a3a3a;font-size:15px;padding-left:20px">
            <li>Create and edit articles</li>
            <li>Submit articles for publication</li>
            <li>Manage your profile and publications</li>
          </ul>
          <a href="https://innoblog-client.vercel.app/#/create" style="display:inline-block;padding:12px 24px;background:#d31313;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Start Writing</a>
          <p style="margin:20px 0 0;color:#7a5555;font-size:13px">If you have any questions, feel free to reach out to the InnoBlog team.</p>
        </div>
      </div>
    `,
  })
}

async function sendWriterAccessRevokedEmail({ to }) {
  await sendEmail({
    to,
    subject: 'Your writer access on InnoBlog has been revoked',
    text: `Your writer access on InnoBlog has been revoked. You can still read articles, but you will no longer be able to create or submit new articles.`,
    html: `
      <div style="font-family:Arial,sans-serif;padding:24px;background:#fff7f7;color:#1b0d0d">
        <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #ffd1d1;border-radius:18px;padding:32px">
          <p style="margin:0 0 12px;color:#d31313;font-size:12px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase">InnoBlog Writer Access</p>
          <h1 style="margin:0 0 12px;font-size:28px;line-height:1.1;color:#120808">Your writer access has been revoked</h1>
          <p style="margin:0 0 20px;color:#5a3a3a;font-size:15px">Your writer access on InnoBlog has been revoked. You can still read and explore articles on InnoBlog, but you will no longer be able to:</p>
          <ul style="margin:0 0 20px;color:#5a3a3a;font-size:15px;padding-left:20px">
            <li>Create or edit articles</li>
            <li>Submit articles for publication</li>
            <li>Access the article management dashboard</li>
          </ul>
          <p style="margin:20px 0 0;color:#7a5555;font-size:13px">If you believe this is a mistake, please contact the InnoBlog administrators.</p>
        </div>
      </div>
    `,
  })
}

module.exports = {
  sendEmail,
  sendOtpEmail,
  sendWriterAccessGrantedEmail,
  sendWriterAccessRevokedEmail,
}
