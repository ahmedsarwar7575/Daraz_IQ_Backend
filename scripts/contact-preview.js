const express = require('express')
const cors = require('cors')
const env = require('../src/config')
const { createContactRouter } = require('../src/features/contact')

const app = express()
app.disable('x-powered-by')
app.use(
  cors({
    origin: [
      'http://127.0.0.1:5174',
      'http://localhost:5174',
      'http://127.0.0.1:5175',
      'http://localhost:5175',
    ],
  }),
)
app.use(
  '/api/contact',
  createContactRouter({ config: { ...env, nodeEnv: 'development' } }),
)
app.use((error, _req, res, _next) =>
  res
    .status(error.status || 500)
    .json({
      error: {
        code: error.code || 'CONTACT_UNAVAILABLE',
        message: error.status
          ? error.message
          : 'The contact service is unavailable.',
      },
    }),
)
app.listen(4001, '127.0.0.1', () =>
  console.log(
    'Contact-only SMTP preview: http://127.0.0.1:4001 (no database connection)',
  ),
)
