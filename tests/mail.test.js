jest.mock('nodemailer', () => ({
  createTransport: jest.fn(),
}))

const nodemailer = require('nodemailer')
const {
  sendEmail,
  sendOtpEmail,
  sendWriterAccessGrantedEmail,
  sendWriterAccessRevokedEmail,
} = require('../utils/mail')

describe('mail utilities', () => {
  const transport = {
    sendMail: jest.fn().mockResolvedValue({ messageId: 'test-message-id' }),
  }

  beforeEach(() => {
    process.env.MAIL_USER = 'mail@example.com'
    process.env.MAIL_PASS = 'test-password'
    process.env.SMTP_HOST = 'smtp.example.com'
    process.env.SMTP_PORT = '465'
    process.env.SMTP_SECURE = 'true'

    nodemailer.createTransport.mockReturnValue(transport)
    nodemailer.createTransport.mockClear()
    transport.sendMail.mockClear()
  })

  it('sends a generic email through the configured transport', async () => {
    await sendEmail({
      to: 'reader@example.com',
      subject: 'Hello',
      text: 'Plain text body',
      html: '<p>HTML body</p>',
    })

    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: {
        user: 'mail@example.com',
        pass: 'test-password',
      },
    })

    expect(transport.sendMail).toHaveBeenCalledWith({
      from: 'mail@example.com',
      to: 'reader@example.com',
      subject: 'Hello',
      text: 'Plain text body',
      html: '<p>HTML body</p>',
    })
  })

  it('builds OTP emails with the expected content', async () => {
    await sendOtpEmail({
      to: 'reader@example.com',
      code: '123456',
    })

    const message = transport.sendMail.mock.calls[0][0]

    expect(message.subject).toBe('Your InnoBlog login OTP')
    expect(message.to).toBe('reader@example.com')
    expect(message.text).toContain('123456')
    expect(message.html).toContain('123456')
    expect(message.html).toContain('Use this OTP to sign in')
  })

  it('builds writer access granted and revoked emails', async () => {
    await sendWriterAccessGrantedEmail({
      to: 'writer@example.com',
      grantedBy: 'admin@example.com',
    })

    await sendWriterAccessRevokedEmail({
      to: 'writer@example.com',
    })

    expect(transport.sendMail).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        to: 'writer@example.com',
        subject: 'You now have writer access on InnoBlog',
      }),
    )

    expect(transport.sendMail).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        to: 'writer@example.com',
        subject: 'Your writer access on InnoBlog has been revoked',
      }),
    )
  })
})
