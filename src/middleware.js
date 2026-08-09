const jwt = require('jsonwebtoken')
const env = require('./config')
const { User } = require('./models')
const { ApiError, asyncHandler } = require('./utils')
const { issuer, mcpAuthChallenge, mcpResource } = require('./features/oauth')

const authenticate = asyncHandler(async (req, _res, next) => {
  const [scheme, token] = String(req.headers.authorization || '').split(' ')
  if (scheme !== 'Bearer' || !token) {
    throw new ApiError(401, 'Authentication is required.', 'UNAUTHORIZED')
  }

  let payload
  try {
    payload = jwt.verify(token, env.jwtSecret, { maxAge: env.sessionExpiresIn })
  } catch {
    throw new ApiError(401, 'Your session has expired.', 'SESSION_EXPIRED')
  }

  const user = await User.findByPk(payload.sub)
  if (!user) throw new ApiError(401, 'User account was not found.', 'UNAUTHORIZED')
  req.authPayload = payload
  req.user = user
  next()
})

const authenticateMcp = asyncHandler(async (req, res, next) => {
  const [scheme, token] = String(req.headers.authorization || '').split(' ')
  if (scheme !== 'Bearer' || !token) {
    res.set('WWW-Authenticate', mcpAuthChallenge())
    throw new ApiError(401, 'Authentication is required.', 'UNAUTHORIZED')
  }

  let payload
  try {
    payload = jwt.verify(token, env.jwtSecret)
  } catch {
    res.set('WWW-Authenticate', mcpAuthChallenge())
    throw new ApiError(401, 'Your MCP session has expired.', 'SESSION_EXPIRED')
  }

  if (payload.token_use === 'mcp_access') {
    const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    const validAudience = audience.map((value) => String(value || '').replace(/\/+$/, '')).includes(mcpResource())
    const validIssuer = payload.iss === issuer()
    if (!validAudience || !validIssuer) {
      res.set('WWW-Authenticate', mcpAuthChallenge())
      throw new ApiError(401, 'MCP token is not valid for this server.', 'INVALID_TOKEN')
    }
  }

  const user = await User.findByPk(payload.sub)
  if (!user) {
    res.set('WWW-Authenticate', mcpAuthChallenge())
    throw new ApiError(401, 'User account was not found.', 'UNAUTHORIZED')
  }

  req.authPayload = payload
  req.user = user
  next()
})

module.exports = { authenticate, authenticateMcp }
