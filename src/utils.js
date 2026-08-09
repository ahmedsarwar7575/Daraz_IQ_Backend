const crypto = require('crypto')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const nodemailer = require('nodemailer')
const env = require('./config')

class ApiError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED', details) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next)
}

const normalizeEmail = (email) => String(email || '').trim().toLowerCase()

const publicUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  emailVerified: user.emailVerified,
  authProvider: user.authProvider,
  avatarUrl: user.avatarUrl,
})

const signSession = (user) => jwt.sign(
  { email: user.email },
  env.jwtSecret,
  { subject: user.id, expiresIn: env.sessionExpiresIn },
)

const generateOtp = () => String(crypto.randomInt(100000, 1000000))
const hashSecret = (value) => bcrypt.hash(String(value), 12)
const compareSecret = (value, hash) => bcrypt.compare(String(value), hash)

let mailer

const getMailer = () => {
  if (mailer !== undefined) return mailer
  if (!env.mail.host || !env.mail.user || !env.mail.password) {
    mailer = null
    return mailer
  }

  mailer = nodemailer.createTransport({
    host: env.mail.host,
    port: env.mail.port,
    secure: env.mail.secure,
    auth: { user: env.mail.user, pass: env.mail.password },
  })
  return mailer
}

const sendOtpEmail = async (email, code, purpose) => {
  const transporter = getMailer()
  const subject = purpose === 'verify_email'
    ? 'Verify your Daraz Console account'
    : 'Your Daraz Console sign-in code'

  if (!transporter) {
    if (env.nodeEnv !== 'production') console.log(`[development OTP] ${email}: ${code}`)
    return
  }

  await transporter.sendMail({
    from: env.mail.from,
    to: email,
    subject,
    text: `Your verification code is ${code}. It expires in 10 minutes.`,
    html: `<div style="font-family:Arial,sans-serif;color:#17202a"><h2 style="margin:0 0 16px">Daraz Console</h2><p>Your verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>This code expires in 10 minutes.</p></div>`,
  })
}

const encryptionKey = crypto
  .createHash('sha256')
  .update(env.tokenEncryptionKey)
  .digest()

const encrypt = (value) => {
  if (!value) return null
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv)
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv, tag, encrypted].map((item) => item.toString('base64url')).join('.')
}

const decrypt = (value) => {
  if (!value) return null
  const [iv, tag, encrypted] = value.split('.').map((item) => Buffer.from(item, 'base64url'))
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

module.exports = {
  ApiError,
  asyncHandler,
  compareSecret,
  decrypt,
  encrypt,
  generateOtp,
  hashSecret,
  normalizeEmail,
  publicUser,
  sendOtpEmail,
  signSession,
}
