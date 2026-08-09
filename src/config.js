const path = require('path')
const net = require('net')

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })

if (typeof net.setDefaultAutoSelectFamily === 'function') {
  net.setDefaultAutoSelectFamily(false)
}

const asBoolean = (value, fallback = false) => {
  if (value === undefined) return fallback
  return String(value).toLowerCase() === 'true'
}

const port = Number(process.env.PORT || 4000)
const apiBaseUrl = process.env.API_BASE_URL || `http://localhost:${port}`

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port,
  apiBaseUrl,
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  jwtSecret: process.env.JWT_SECRET || 'replace-this-development-jwt-secret',
  sessionExpiresIn: process.env.SESSION_EXPIRES_IN || '1d',
  stateSecret: process.env.OAUTH_STATE_SECRET || process.env.JWT_SECRET || 'replace-this-development-state-secret',
  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET || 'replace-this-development-token-key',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  database: {
    url: process.env.DATABASE_URL || '',
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    name: process.env.DB_NAME || 'daraz_console',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    ssl: asBoolean(process.env.DB_SSL),
    sync: asBoolean(process.env.DB_SYNC, true),
  },
  mail: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: asBoolean(process.env.SMTP_SECURE),
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.MAIL_FROM || 'Daraz Console <no-reply@example.com>',
  },
  daraz: {
    appKey: process.env.DARAZ_APP_KEY || '',
    appSecret: process.env.DARAZ_APP_SECRET || '',
    authUrl: process.env.DARAZ_AUTH_URL || 'https://api.daraz.pk/oauth/authorize',
    systemApiUrl: process.env.DARAZ_SYSTEM_API_URL || 'https://api.daraz.pk/rest',
    apiUrl: process.env.DARAZ_API_URL || '',
    redirectUri: process.env.DARAZ_REDIRECT_URI || `${apiBaseUrl}/api/daraz/callback`,
  },
  copilot: {
    competitorCacheTtlHours: Number(process.env.COMPETITOR_CACHE_TTL_HOURS || 6),
    liveScrapeEnabled: asBoolean(process.env.COMPETITOR_LIVE_SCRAPE_ENABLED),
    scrapeMaxPages: Number(process.env.COMPETITOR_SCRAPE_MAX_PAGES || 1),
  },
  ai: {
    defaultProvider: ['openai', 'openrouter'].includes(process.env.AI_PROVIDER)
      ? process.env.AI_PROVIDER
      : 'openrouter',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'openrouter/free',
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    siteUrl: process.env.OPENROUTER_SITE_URL || process.env.FRONTEND_URL || 'http://localhost:5173',
    appName: process.env.OPENROUTER_APP_NAME || 'SellerDesk',
  },
}

module.exports = env
