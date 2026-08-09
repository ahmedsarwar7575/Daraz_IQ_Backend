const jwt = require('jsonwebtoken')
const env = require('./config')
const { User } = require('./models')
const { ApiError, asyncHandler } = require('./utils')

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

module.exports = { authenticate }
