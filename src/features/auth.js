const express = require('express')
const { OAuth2Client } = require('google-auth-library')
const { Op } = require('sequelize')
const env = require('../config')
const { User, OtpCode } = require('../models')
const { authenticate } = require('../middleware')
const {
  ApiError,
  asyncHandler,
  compareSecret,
  generateOtp,
  hashSecret,
  normalizeEmail,
  publicUser,
  sendOtpEmail,
  signSession,
} = require('../utils')

const router = express.Router()
const googleClient = new OAuth2Client(env.googleClientId)

const isEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)

const issueOtp = async (email, purpose) => {
  const recent = await OtpCode.findOne({
    where: {
      email,
      purpose,
      consumedAt: null,
      expiresAt: { [Op.gt]: new Date() },
      createdAt: { [Op.gt]: new Date(Date.now() - 60 * 1000) },
    },
  })
  if (recent) return

  await OtpCode.update(
    { consumedAt: new Date() },
    { where: { email, purpose, consumedAt: null } },
  )

  const code = generateOtp()
  await OtpCode.create({
    email,
    purpose,
    codeHash: await hashSecret(code),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  })
  await sendOtpEmail(email, code, purpose)
}

const consumeOtp = async (email, code, purpose) => {
  const record = await OtpCode.findOne({
    where: {
      email,
      purpose,
      consumedAt: null,
      expiresAt: { [Op.gt]: new Date() },
    },
    order: [['createdAt', 'DESC']],
  })

  if (!record || record.attempts >= 5) {
    throw new ApiError(400, 'The code is invalid or has expired.', 'INVALID_OTP')
  }

  const valid = await compareSecret(code, record.codeHash)
  if (!valid) {
    await record.increment('attempts')
    throw new ApiError(400, 'The code is invalid or has expired.', 'INVALID_OTP')
  }

  await record.update({ consumedAt: new Date() })
}

router.post('/register', asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim()
  const email = normalizeEmail(req.body.email)
  const password = String(req.body.password || '')

  if (name.length < 2 || name.length > 100) {
    throw new ApiError(400, 'Enter a valid full name.', 'VALIDATION_ERROR')
  }
  if (!isEmail(email)) {
    throw new ApiError(400, 'Enter a valid email address.', 'VALIDATION_ERROR')
  }
  if (password.length < 8) {
    throw new ApiError(400, 'Password must be at least 8 characters.', 'VALIDATION_ERROR')
  }

  let user = await User.findOne({ where: { email } })
  if (user?.emailVerified) {
    throw new ApiError(409, 'An account with this email already exists.', 'ACCOUNT_EXISTS')
  }

  const passwordHash = await hashSecret(password)
  if (user) {
    await user.update({ name, passwordHash, authProvider: 'email' })
  } else {
    user = await User.create({ name, email, passwordHash, authProvider: 'email' })
  }

  await issueOtp(email, 'verify_email')
  res.status(201).json({ message: 'Verification code sent.', email })
}))

router.post('/verify-email', asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email)
  const code = String(req.body.otp || '').trim()
  await consumeOtp(email, code, 'verify_email')

  const user = await User.findOne({ where: { email } })
  if (!user) throw new ApiError(404, 'Account was not found.', 'ACCOUNT_NOT_FOUND')
  await user.update({ emailVerified: true, lastLoginAt: new Date() })

  res.json({ token: signSession(user), user: publicUser(user) })
}))

router.post('/login', asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email)
  const password = String(req.body.password || '')
  const user = await User.findOne({ where: { email } })

  if (!user?.passwordHash || !(await compareSecret(password, user.passwordHash))) {
    throw new ApiError(401, 'Email or password is incorrect.', 'INVALID_CREDENTIALS')
  }
  if (!user.emailVerified) {
    await issueOtp(email, 'verify_email')
    throw new ApiError(403, 'Verify your email to continue.', 'EMAIL_NOT_VERIFIED')
  }

  await user.update({ lastLoginAt: new Date() })
  res.json({ token: signSession(user), user: publicUser(user) })
}))

router.post('/request-otp', asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email)
  const user = await User.findOne({ where: { email, emailVerified: true } })
  if (user) await issueOtp(email, 'sign_in')

  res.json({ message: 'If the account exists, a sign-in code has been sent.' })
}))

router.post('/verify-otp', asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email)
  const code = String(req.body.otp || '').trim()
  await consumeOtp(email, code, 'sign_in')

  const user = await User.findOne({ where: { email, emailVerified: true } })
  if (!user) throw new ApiError(404, 'Account was not found.', 'ACCOUNT_NOT_FOUND')
  await user.update({ lastLoginAt: new Date() })

  res.json({ token: signSession(user), user: publicUser(user) })
}))

router.post('/google', asyncHandler(async (req, res) => {
  if (!env.googleClientId) {
    throw new ApiError(503, 'Google sign-in is not configured.', 'GOOGLE_NOT_CONFIGURED')
  }

  let payload
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: String(req.body.credential || ''),
      audience: env.googleClientId,
    })
    payload = ticket.getPayload()
  } catch {
    throw new ApiError(401, 'Google sign-in could not be verified.', 'INVALID_GOOGLE_TOKEN')
  }

  if (!payload?.email || !payload.email_verified) {
    throw new ApiError(401, 'A verified Google email is required.', 'INVALID_GOOGLE_TOKEN')
  }

  const email = normalizeEmail(payload.email)
  let user = await User.findOne({ where: { email } })
  const values = {
    name: payload.name || email.split('@')[0],
    email,
    emailVerified: true,
    googleSub: payload.sub,
    avatarUrl: payload.picture || null,
    lastLoginAt: new Date(),
  }

  if (user) {
    values.authProvider = user.passwordHash ? 'email_google' : 'google'
    await user.update(values)
  } else {
    user = await User.create({ ...values, authProvider: 'google' })
  }

  res.json({ token: signSession(user), user: publicUser(user) })
}))

router.get('/me', authenticate, (req, res) => {
  res.json({ user: publicUser(req.user) })
})

module.exports = router
