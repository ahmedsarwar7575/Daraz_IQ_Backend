const express = require('express')
const { createHash, randomUUID } = require('node:crypto')
const { rateLimit } = require('express-rate-limit')
const env = require('../config')
const { ApiError, asyncHandler, getMailer } = require('../utils')

const topics = new Set([
  'Connecting my Daraz store',
  'Products and pricing',
  'AI client setup',
  'Account and data access',
  'Product feedback',
])
const emailPattern =
  /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+$/i
const hash = (value) => createHash('sha256').update(value).digest('hex')
const rateMessage = {
  error: {
    code: 'CONTACT_RATE_LIMIT',
    message:
      'Too many messages. Please try again in an hour, or contact us by phone.',
  },
}

function createContactRouter({
  mailer = getMailer,
  config = env,
  now = Date.now,
  log = console,
} = {}) {
  const router = express.Router()
  const receipts = new Map()
  const origins = new Set(
    [
      config.frontendUrl,
      'https://daraziq.store',
      'https://www.daraziq.store',
    ].map((value) => new URL(value).origin),
  )
  if (config.nodeEnv !== 'production') {
    for (const host of ['localhost', '127.0.0.1'])
      for (const port of [5173, 5174, 5175])
        origins.add(`http://${host}:${port}`)
  }
  router.use(express.json({ limit: '12kb' }))
  router.post(
    '/',
    rateLimit({
      windowMs: 60 * 60 * 1000,
      limit: 5,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: rateMessage,
    }),
    (req, _res, next) => {
      if (req.headers.origin && !origins.has(req.headers.origin))
        return next(
          new ApiError(
            403,
            'This origin cannot submit contact messages.',
            'CONTACT_ORIGIN',
          ),
        )
      if (!req.is('application/json') || !req.body || Array.isArray(req.body))
        return next(
          new ApiError(400, 'Submit a valid contact form.', 'VALIDATION_ERROR'),
        )
      const { name, email, topic, message, requestId, website } = req.body
      if (website)
        return next(
          new ApiError(
            400,
            'The message could not be accepted.',
            'VALIDATION_ERROR',
          ),
        )
      if (
        typeof name !== 'string' ||
        name.trim().length < 2 ||
        name.length > 100 ||
        /[\r\n\x00-\x1f\x7f]/.test(name)
      )
        return next(
          new ApiError(
            400,
            'Enter your name (2 to 100 characters).',
            'VALIDATION_ERROR',
          ),
        )
      if (
        typeof email !== 'string' ||
        email.length > 254 ||
        !emailPattern.test(email.trim())
      )
        return next(
          new ApiError(
            400,
            'Enter a single valid email address.',
            'VALIDATION_ERROR',
          ),
        )
      if (!topics.has(topic))
        return next(
          new ApiError(400, 'Choose a contact topic.', 'VALIDATION_ERROR'),
        )
      if (
        typeof message !== 'string' ||
        message.trim().length < 10 ||
        message.length > 4000 ||
        /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(message)
      )
        return next(
          new ApiError(
            400,
            'Enter a message between 10 and 4,000 characters.',
            'VALIDATION_ERROR',
          ),
        )
      if (
        typeof requestId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          requestId,
        )
      )
        return next(
          new ApiError(
            400,
            'Refresh the page and try again.',
            'VALIDATION_ERROR',
          ),
        )
      req.contact = {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        topic,
        message: message.trim(),
        requestId,
      }
      next()
    },
    rateLimit({
      windowMs: 60 * 60 * 1000,
      limit: 3,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      keyGenerator: (req) => hash(req.contact.email),
      message: rateMessage,
    }),
    asyncHandler(async (req, res) => {
      const input = req.contact
      const key = hash(input.email + ':' + input.requestId)
      const fingerprint = hash(JSON.stringify(input))
      for (const [id, value] of receipts)
        if (value.expires <= now()) receipts.delete(id)
      const previous = receipts.get(key)
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new ApiError(
            409,
            'This form has changed. Please submit it again.',
            'CONTACT_CONFLICT',
          )
        return res.json(await previous.result)
      }
      const transport = mailer()
      if (
        !transport ||
        !config.mail.from ||
        !emailPattern.test(config.contact.recipient)
      )
        throw new ApiError(
          503,
          'Email is temporarily unavailable. Please use our phone or WhatsApp contact.',
          'CONTACT_UNAVAILABLE',
        )
      if (receipts.size >= 2000)
        throw new ApiError(
          503,
          'The contact service is busy. Please try again later.',
          'CONTACT_UNAVAILABLE',
        )
      const reference = randomUUID()
      // Store the pending promise before sending, so concurrent retries share one delivery.
      const result = (async () => {
        try {
          const delivery = await transport.sendMail({
            from: config.mail.from,
            to: config.contact.recipient,
            replyTo: { name: input.name, address: input.email },
            subject: `Daraz IQ contact: ${input.topic}`,
            text: `New Daraz IQ inquiry\nReference: ${reference}\n\nName: ${input.name}\nEmail: ${input.email}\nTopic: ${input.topic}\n\n${input.message}`,
            disableFileAccess: true,
            disableUrlAccess: true,
          })
          if (!delivery.accepted?.length)
            throw new Error('Recipient not accepted')
        } catch (error) {
          log.warn('Contact owner delivery failed', {
            code: error.code || 'SMTP_REJECTED',
          })
          throw new ApiError(
            503,
            'Your message could not be sent. Please try again later or contact us by phone.',
            'CONTACT_DELIVERY_FAILED',
          )
        }
        let confirmationSent = false
        try {
          // A fixed receipt avoids reflecting untrusted messages into third-party inboxes.
          const receipt = await transport.sendMail({
            from: config.mail.from,
            to: input.email,
            replyTo: config.contact.recipient,
            subject: 'We received your message | Daraz IQ',
            text: `Thank you for contacting Daraz IQ. Your message has been sent to our team.\n\nReference: ${reference}\n\nYou can reply to this email with additional details. Please do not send passwords or API keys.\n\nDaraz IQ\nIslamabad, Pakistan\n+92 320 7160645\nhttps://daraziq.store\n\nIf you did not submit a contact form, you can ignore this receipt.`,
            headers: { 'Auto-Submitted': 'auto-replied' },
            disableFileAccess: true,
            disableUrlAccess: true,
          })
          confirmationSent = Boolean(receipt.accepted?.length)
        } catch (error) {
          log.warn('Contact receipt delivery failed', {
            code: error.code || 'SMTP_REJECTED',
          })
        }
        return { sent: true, confirmationSent, reference }
      })()
      receipts.set(key, {
        fingerprint,
        result,
        expires: now() + 60 * 60 * 1000,
      })
      try {
        res.json(await result)
      } catch (error) {
        receipts.delete(key)
        throw error
      }
    }),
  )
  return router
}

module.exports = createContactRouter()
module.exports.createContactRouter = createContactRouter
