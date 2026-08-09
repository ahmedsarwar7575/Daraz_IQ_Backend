const express = require('express')
const cors = require('cors')
const env = require('./config')
const { sequelize } = require('./models')
const authRoutes = require('./features/auth')
const darazRoutes = require('./features/daraz')
const copilotRoutes = require('./features/copilot')
const mcpRoutes = require('./features/mcp')
const settingsRoutes = require('./features/settings')

const app = express()

app.disable('x-powered-by')
app.use(cors())
app.use(express.json({ limit: '1mb' }))

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))
app.use('/api/auth', authRoutes)
app.use('/api/daraz', darazRoutes)
app.use('/api/copilot', copilotRoutes)
app.use('/api/mcp', mcpRoutes)
app.use('/api/settings', settingsRoutes)

app.use((_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route was not found.' } })
})

app.use((error, _req, res, _next) => {
  if (env.nodeEnv !== 'production') console.error(error)
  res.status(error.status || 500).json({
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: error.status ? error.message : 'Something went wrong.',
      ...(error.details && env.nodeEnv !== 'production' ? { details: error.details } : {}),
    },
  })
})

const start = async () => {
  try {
    await sequelize.authenticate()
    if (env.database.sync) await sequelize.sync()
    app.listen(env.port, () => {
      console.log(`API listening on ${env.apiBaseUrl}`)
    })
  } catch (error) {
    console.error('Unable to start the API:', error)
    process.exitCode = 1
  }
}

start()
