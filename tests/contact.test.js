const { test } = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { randomUUID } = require('node:crypto')
const express = require('express')
const { createContactRouter } = require('../src/features/contact')

const config = {
  nodeEnv: 'production',
  frontendUrl: 'https://daraziq.store',
  mail: { from: 'Daraz IQ <mail@example.com>' },
  contact: { recipient: 'owner@example.com' },
}
const form = () => ({
  name: 'Demo Seller',
  email: 'seller@example.com',
  topic: 'Products and pricing',
  message: 'Please help me understand the pricing rules.',
  requestId: randomUUID(),
  website: '',
})

async function setup(t, sendMail) {
  const messages = []
  const app = express()
  app.use(
    '/api/contact',
    createContactRouter({
      config,
      log: { warn() {} },
      mailer: () => ({
        sendMail: async (mail) => {
          messages.push(mail)
          return sendMail
            ? sendMail(mail, messages.length)
            : { accepted: [mail.to] }
        },
      }),
    }),
  )
  app.use((error, _req, res, _next) =>
    res
      .status(error.status || 500)
      .json({ error: { code: error.code, message: error.message } }),
  )
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const post = async (body, origin = 'https://daraziq.store') => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/contact`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify(body),
      },
    )
    return { status: response.status, data: await response.json() }
  }
  return { post, messages }
}

test('sends the owner inquiry and a fixed sender receipt through SMTP', async (t) => {
  const { post, messages } = await setup(t)
  const body = {
    ...form(),
    message: '<script>alert(1)</script> Please help me with pricing.',
  }
  const result = await post(body)
  assert.equal(result.status, 200)
  assert.equal(result.data.sent, true)
  assert.equal(result.data.confirmationSent, true)
  assert.equal(messages.length, 2)
  assert.equal(messages[0].to, config.contact.recipient)
  assert.deepEqual(messages[0].replyTo, {
    name: 'Demo Seller',
    address: 'seller@example.com',
  })
  assert.equal(messages[0].html, undefined)
  assert.equal(messages[1].to, 'seller@example.com')
  assert.equal(messages[1].text.includes(body.message), false)
  assert.equal(messages[1].from, config.mail.from)
})

test('concurrent duplicate requests share one pair of messages', async (t) => {
  const { post, messages } = await setup(t, async (mail) => {
    await new Promise((resolve) => setTimeout(resolve, 30))
    return { accepted: [mail.to] }
  })
  const body = form()
  const [first, second] = await Promise.all([post(body), post(body)])
  assert.equal(first.status, 200)
  assert.deepEqual(first.data, second.data)
  assert.equal(messages.length, 2)
  const changed = await post({ ...body, message: 'This is a changed request.' })
  assert.equal(changed.status, 409)
})

test('owner failure never reports success or sends a receipt', async (t) => {
  const { post, messages } = await setup(t, () => {
    throw Object.assign(new Error('Private SMTP details'), {
      code: 'ECONNECTION',
    })
  })
  const result = await post(form())
  assert.equal(result.status, 503)
  assert.equal(result.data.error.code, 'CONTACT_DELIVERY_FAILED')
  assert.equal(JSON.stringify(result.data).includes('Private SMTP'), false)
  assert.equal(messages.length, 1)
})

test('receipt failure reports partial delivery and retries do not duplicate the inquiry', async (t) => {
  const { post, messages } = await setup(t, (mail, count) => {
    if (count === 2) throw new Error('Receipt unavailable')
    return { accepted: [mail.to] }
  })
  const body = form()
  const first = await post(body)
  assert.equal(first.data.sent, true)
  assert.equal(first.data.confirmationSent, false)
  assert.deepEqual((await post(body)).data, first.data)
  assert.equal(messages.length, 2)
})

test('rejects header injection, arbitrary recipients, and invalid topics', async (t) => {
  const { post, messages } = await setup(t)
  for (const invalid of [
    { email: 'a@example.com,b@example.com' },
    { name: 'Demo\r\nBcc: victim@example.com' },
    { topic: 'Arbitrary\r\nsubject' },
    { message: 'short' },
    { requestId: 'not-a-uuid' },
  ])
    assert.equal((await post({ ...form(), ...invalid })).status, 400)
  assert.equal(messages.length, 0)
})

test('blocks honeypots and unapproved origins', async (t) => {
  const { post, messages } = await setup(t)
  assert.equal((await post({ ...form(), website: 'spam.example' })).status, 400)
  assert.equal((await post(form(), 'https://untrusted.example')).status, 403)
  assert.equal(messages.length, 0)
})

test('rate limits repeated messages and rejects oversized payloads', async (t) => {
  const { post, messages } = await setup(t)
  for (let i = 0; i < 3; i++) assert.equal((await post(form())).status, 200)
  assert.equal((await post(form())).status, 429)
  assert.equal(messages.length, 6)
  assert.equal(
    (await post({ ...form(), message: 'a'.repeat(14000) })).status,
    413,
  )
})
