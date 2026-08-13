const crypto = require('crypto')
const express = require('express')
const jwt = require('jsonwebtoken')
const { Op } = require('sequelize')
const env = require('../config')
const { OAuthAuthorizationCode, OAuthClient, OAuthRefreshToken, User } = require('../models')
const {
  ApiError,
  asyncHandler,
  compareSecret,
  hashSecret,
  normalizeEmail,
} = require('../utils')

const router = express.Router()

const supportedAuthMethods = ['none', 'client_secret_post', 'client_secret_basic']

const trimSlash = (value) => String(value || '').replace(/\/+$/, '')
const firstHeader = (value) => {
  const header = Array.isArray(value) ? value[0] : value
  return String(header || '').split(',')[0].trim()
}
const isLoopbackUrl = (value) => {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(value).hostname)
  } catch {
    return false
  }
}
const requestOrigin = (req) => {
  const host = firstHeader(req?.headers?.['x-forwarded-host']) || firstHeader(req?.headers?.host)
  if (!host) return ''
  const proto = firstHeader(req?.headers?.['x-forwarded-proto']) || req?.protocol || 'https'
  return trimSlash(`${proto}://${host}`)
}
const issuer = (req) => {
  const configured = trimSlash(env.oauth.issuer || env.apiBaseUrl)
  const origin = requestOrigin(req)
  if (origin && isLoopbackUrl(configured) && !isLoopbackUrl(origin)) return origin
  return configured
}
const mcpResource = (req) => {
  const configured = trimSlash(env.mcp.resourceUrl)
  const origin = requestOrigin(req)
  if (configured && !(origin && isLoopbackUrl(configured) && !isLoopbackUrl(origin))) return configured
  return `${issuer(req)}/api/mcp`
}
const protectedResourceMetadataUrl = (req) => `${issuer(req)}/.well-known/oauth-protected-resource/api/mcp`
const supportedScope = () => env.mcp.scopes.join(' ')

const escapeHtml = (value) => String(value || '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;')

const randomToken = (size = 32) => crypto.randomBytes(size).toString('base64url')
const tokenHash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex')

const durationSeconds = (value) => {
  if (/^\d+$/.test(String(value))) return Number(value)
  const match = String(value).match(/^(\d+)([smhd])$/i)
  if (!match) return 24 * 60 * 60
  const amount = Number(match[1])
  const unit = match[2].toLowerCase()
  return amount * ({ s: 1, m: 60, h: 3600, d: 86400 }[unit] || 86400)
}

const normalizeScope = (scope) => {
  const requested = String(scope || supportedScope())
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
  const allowed = new Set(env.mcp.scopes)
  const valid = requested.filter((item) => allowed.has(item))
  return [...new Set(valid.length ? valid : env.mcp.scopes)].join(' ')
}

const isAllowedRedirectUri = (value) => {
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'https:') return true
    return parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  } catch {
    return false
  }
}

const sameUri = (left, right) => trimSlash(left) === trimSlash(right)

const protectedResourceMetadata = (req) => ({
  resource: mcpResource(req),
  resource_name: 'daraziq.store Daraz MCP',
  authorization_servers: [issuer(req)],
  scopes_supported: env.mcp.scopes,
  bearer_methods_supported: ['header'],
})

const authorizationServerMetadata = (req) => ({
  issuer: issuer(req),
  authorization_endpoint: `${issuer(req)}/api/oauth/authorize`,
  token_endpoint: `${issuer(req)}/api/oauth/token`,
  registration_endpoint: `${issuer(req)}/api/oauth/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: supportedAuthMethods,
  scopes_supported: env.mcp.scopes,
  resource_parameter_supported: true,
  client_id_metadata_document_supported: false,
})

const mcpAuthChallenge = (req) => (
  `Bearer resource_metadata="${protectedResourceMetadataUrl(req)}", scope="${supportedScope()}"`
)

const oauthErrorRedirect = (redirectUri, error, description, state) => {
  const url = new URL(redirectUri)
  url.searchParams.set('error', error)
  if (description) url.searchParams.set('error_description', description)
  if (state) url.searchParams.set('state', state)
  return url.toString()
}

const renderAuthorizePage = ({ params, client, error = '' }) => {
  const hiddenFields = [
    'response_type',
    'client_id',
    'redirect_uri',
    'scope',
    'state',
    'code_challenge',
    'code_challenge_method',
    'resource',
  ].map((key) => (
    `<input type="hidden" name="${key}" value="${escapeHtml(params[key])}">`
  )).join('\n')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect daraziq.store</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f6f8; color: #171c22; font-family: Inter, Arial, sans-serif; }
    main { width: min(440px, calc(100vw - 32px)); border: 1px solid #dfe3e8; background: white; border-radius: 8px; box-shadow: 0 18px 50px rgba(27,35,45,.08); overflow: hidden; }
    header { padding: 24px 26px 18px; border-bottom: 1px solid #e2e5e9; }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; }
    .mark { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 7px; background: #f85606; color: white; }
    h1 { margin: 18px 0 0; font-size: 22px; }
    p { margin: 8px 0 0; color: #687480; font-size: 14px; line-height: 1.6; }
    form { padding: 24px 26px 26px; display: grid; gap: 15px; }
    label { display: grid; gap: 8px; font-size: 13px; font-weight: 650; color: #303640; }
    input { width: 100%; height: 42px; border: 1px solid #d9dde3; border-radius: 6px; padding: 0 12px; color: #171c22; font-size: 14px; outline: none; }
    input:focus { border-color: #f85606; box-shadow: 0 0 0 3px #fdd8c6; }
    .error { border: 1px solid #f1c8bd; background: #fff5f2; color: #9a341f; border-radius: 6px; padding: 10px 12px; font-size: 13px; }
    .scope { border: 1px solid #dfe3e8; background: #f8f9fa; border-radius: 6px; padding: 10px 12px; font-size: 13px; color: #53606c; }
    button { height: 42px; border: 0; border-radius: 6px; background: #f85606; color: white; font-weight: 700; cursor: pointer; }
    button:hover { background: #dd4c04; }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="brand"><span class="mark">IQ</span><span>daraziq.store</span></div>
      <h1>Connect ${escapeHtml(client.clientName)}</h1>
      <p>Sign in to allow this MCP connector to access your daraziq.store workspace.</p>
    </header>
    <form method="post" action="/api/oauth/authorize">
      ${hiddenFields}
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
      <div class="scope">Requested access: ${escapeHtml(normalizeScope(params.scope))}</div>
      <label>Email address
        <input type="email" name="email" autocomplete="email" required autofocus>
      </label>
      <label>Password
        <input type="password" name="password" autocomplete="current-password" required>
      </label>
      <button type="submit">Authorize connector</button>
    </form>
  </main>
</body>
</html>`
}

const validateAuthorizationParams = async (params, req) => {
  if (params.response_type !== 'code') {
    throw new ApiError(400, 'Only authorization code flow is supported.', 'UNSUPPORTED_RESPONSE_TYPE')
  }
  if (!params.client_id || !params.redirect_uri) {
    throw new ApiError(400, 'Missing OAuth client or redirect URI.', 'INVALID_REQUEST')
  }
  if (!params.code_challenge || params.code_challenge_method !== 'S256') {
    throw new ApiError(400, 'PKCE S256 is required.', 'PKCE_REQUIRED')
  }
  if (params.resource && !sameUri(params.resource, mcpResource(req))) {
    throw new ApiError(400, 'Invalid MCP resource.', 'INVALID_RESOURCE')
  }

  const client = await OAuthClient.findOne({ where: { clientId: params.client_id } })
  if (!client) throw new ApiError(400, 'OAuth client was not registered.', 'INVALID_CLIENT')
  if (!client.redirectUris.includes(params.redirect_uri)) {
    throw new ApiError(400, 'Redirect URI is not registered for this OAuth client.', 'INVALID_REDIRECT_URI')
  }
  return client
}

const parseBasicClient = (header) => {
  const match = String(header || '').match(/^Basic\s+(.+)$/i)
  if (!match) return {}
  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8')
    const separator = decoded.indexOf(':')
    return {
      clientId: decodeURIComponent(decoded.slice(0, separator)),
      clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
    }
  } catch {
    return {}
  }
}

const authenticateClient = async (req) => {
  const basic = parseBasicClient(req.headers.authorization)
  const clientId = basic.clientId || req.body.client_id
  const client = clientId ? await OAuthClient.findOne({ where: { clientId } }) : null
  if (!client) throw new ApiError(401, 'Invalid OAuth client.', 'INVALID_CLIENT')

  if (client.tokenEndpointAuthMethod === 'none') return client

  const secret = client.tokenEndpointAuthMethod === 'client_secret_basic'
    ? basic.clientSecret
    : req.body.client_secret
  if (!secret || !client.clientSecretHash || !(await compareSecret(secret, client.clientSecretHash))) {
    throw new ApiError(401, 'Invalid OAuth client secret.', 'INVALID_CLIENT')
  }
  return client
}

const verifyPkce = (verifier, challenge) => {
  if (!verifier) return false
  const digest = crypto.createHash('sha256').update(String(verifier)).digest('base64url')
  return digest === challenge
}

const signMcpAccessToken = (req, user, { clientId, scope, resource }) => {
  const expiresIn = env.mcp.accessTokenExpiresIn
  return {
    accessToken: jwt.sign(
      {
        email: user.email,
        scope,
        token_use: 'mcp_access',
        client_id: clientId,
      },
      env.jwtSecret,
      {
        subject: user.id,
        issuer: issuer(req),
        audience: trimSlash(resource || mcpResource(req)),
        expiresIn,
      },
    ),
    expiresIn: durationSeconds(expiresIn),
  }
}

const refreshTokenExpiresAt = () => (
  new Date(Date.now() + durationSeconds(env.mcp.refreshTokenExpiresIn) * 1000)
)

const issueMcpRefreshToken = async ({ userId, clientId, scope, resource }) => {
  const refreshToken = randomToken(48)
  await OAuthRefreshToken.create({
    tokenHash: tokenHash(refreshToken),
    userId,
    clientId,
    scope,
    resource,
    expiresAt: refreshTokenExpiresAt(),
  })
  return refreshToken
}

const tokenResponse = async (req, user, { clientId, scope, resource }) => {
  const accessToken = signMcpAccessToken(req, user, { clientId, scope, resource })
  const refreshToken = await issueMcpRefreshToken({
    userId: user.id,
    clientId,
    scope,
    resource,
  })
  return {
    access_token: accessToken.accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: accessToken.expiresIn,
    scope,
  }
}

router.get('/oauth-protected-resource', (req, res) => {
  res.json(protectedResourceMetadata(req))
})

router.get('/oauth-protected-resource/api/mcp', (req, res) => {
  res.json(protectedResourceMetadata(req))
})

router.get('/oauth-authorization-server', (req, res) => {
  res.json(authorizationServerMetadata(req))
})

router.get('/openid-configuration', (req, res) => {
  res.json(authorizationServerMetadata(req))
})

router.post('/api/oauth/register', asyncHandler(async (req, res) => {
  const redirectUris = Array.isArray(req.body.redirect_uris) ? req.body.redirect_uris : []
  const tokenEndpointAuthMethod = supportedAuthMethods.includes(req.body.token_endpoint_auth_method)
    ? req.body.token_endpoint_auth_method
    : 'none'

  if (!redirectUris.length || redirectUris.some((uri) => !isAllowedRedirectUri(uri))) {
    throw new ApiError(400, 'At least one valid HTTPS redirect URI is required.', 'INVALID_REDIRECT_URIS')
  }

  const clientId = `sellerdesk_${randomToken(24)}`
  const clientSecret = tokenEndpointAuthMethod === 'none' ? '' : randomToken(32)
  const client = await OAuthClient.create({
    clientId,
    clientSecretHash: clientSecret ? await hashSecret(clientSecret) : null,
    clientName: String(req.body.client_name || 'MCP client').slice(0, 160),
    redirectUris,
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
    tokenEndpointAuthMethod,
    scope: normalizeScope(req.body.scope),
    metadata: req.body,
  })

  res.status(201).json({
    client_id: client.clientId,
    ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(client.clientIdIssuedAt.getTime() / 1000),
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    response_types: client.responseTypes,
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    scope: client.scope,
  })
}))

router.get('/api/oauth/authorize', asyncHandler(async (req, res) => {
  const params = req.query
  const client = await validateAuthorizationParams(params, req)
  res.type('html').send(renderAuthorizePage({ params, client }))
}))

router.post('/api/oauth/authorize', asyncHandler(async (req, res) => {
  const params = req.body
  const client = await validateAuthorizationParams(params, req)
  const user = await User.findOne({ where: { email: normalizeEmail(req.body.email) } })

  if (!user?.passwordHash || !(await compareSecret(req.body.password, user.passwordHash))) {
    res.status(401).type('html').send(renderAuthorizePage({
      params,
      client,
      error: 'Email or password is incorrect.',
    }))
    return
  }
  if (!user.emailVerified) {
    res.status(403).type('html').send(renderAuthorizePage({
      params,
      client,
      error: 'Verify your daraziq.store email before connecting MCP.',
    }))
    return
  }

  await user.update({ lastLoginAt: new Date() })

  const code = randomToken(32)
  await OAuthAuthorizationCode.create({
    codeHash: tokenHash(code),
    userId: user.id,
    clientId: client.clientId,
    redirectUri: params.redirect_uri,
    scope: normalizeScope(params.scope),
    resource: trimSlash(params.resource || mcpResource(req)),
    codeChallenge: params.code_challenge,
    codeChallengeMethod: params.code_challenge_method,
    expiresAt: new Date(Date.now() + env.oauth.codeTtlMinutes * 60 * 1000),
  })

  const redirectUrl = new URL(params.redirect_uri)
  redirectUrl.searchParams.set('code', code)
  redirectUrl.searchParams.set('iss', issuer(req))
  if (params.state) redirectUrl.searchParams.set('state', params.state)
  res.redirect(redirectUrl.toString())
}))

router.post('/api/oauth/token', asyncHandler(async (req, res) => {
  const client = await authenticateClient(req)

  if (req.body.grant_type === 'refresh_token') {
    const refreshRecord = await OAuthRefreshToken.findOne({
      where: {
        tokenHash: tokenHash(req.body.refresh_token),
        clientId: client.clientId,
        revokedAt: null,
        expiresAt: { [Op.gt]: new Date() },
      },
    })
    if (!refreshRecord) throw new ApiError(400, 'Refresh token is invalid or expired.', 'INVALID_GRANT')

    await refreshRecord.update({ revokedAt: new Date(), lastUsedAt: new Date() })
    const user = await User.findByPk(refreshRecord.userId)
    if (!user) throw new ApiError(400, 'User account was not found.', 'INVALID_GRANT')

    res.json(await tokenResponse(req, user, {
      clientId: client.clientId,
      scope: refreshRecord.scope,
      resource: refreshRecord.resource,
    }))
    return
  }

  if (req.body.grant_type !== 'authorization_code') {
    throw new ApiError(400, 'Only authorization_code and refresh_token grants are supported.', 'UNSUPPORTED_GRANT_TYPE')
  }

  const record = await OAuthAuthorizationCode.findOne({
    where: {
      codeHash: tokenHash(req.body.code),
      clientId: client.clientId,
      consumedAt: null,
      expiresAt: { [Op.gt]: new Date() },
    },
  })
  if (!record) throw new ApiError(400, 'Authorization code is invalid or expired.', 'INVALID_GRANT')
  if (record.redirectUri !== req.body.redirect_uri) {
    throw new ApiError(400, 'Redirect URI does not match the authorization code.', 'INVALID_GRANT')
  }
  if (req.body.resource && !sameUri(req.body.resource, record.resource)) {
    throw new ApiError(400, 'Token resource does not match authorization request.', 'INVALID_TARGET')
  }
  if (!verifyPkce(req.body.code_verifier, record.codeChallenge)) {
    throw new ApiError(400, 'PKCE verification failed.', 'INVALID_GRANT')
  }

  await record.update({ consumedAt: new Date() })
  const user = await User.findByPk(record.userId)
  if (!user) throw new ApiError(400, 'User account was not found.', 'INVALID_GRANT')

  res.json(await tokenResponse(req, user, {
    clientId: client.clientId,
    scope: record.scope,
    resource: record.resource,
  }))
}))

module.exports = router
module.exports.mcpAuthChallenge = mcpAuthChallenge
module.exports.mcpResource = mcpResource
module.exports.issuer = issuer
