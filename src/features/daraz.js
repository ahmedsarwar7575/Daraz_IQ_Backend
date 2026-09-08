const crypto = require('crypto')
const express = require('express')
const jwt = require('jsonwebtoken')
const axios = require('axios')
const env = require('../config')
const { DarazConnection, ProductSnapshot, StoreSnapshot } = require('../models')
const { authenticate } = require('../middleware')
const { ApiError, asyncHandler, decrypt, encrypt } = require('../utils')

const router = express.Router()

const trimSlash = (value) => String(value || '').replace(/\/+$/, '')
const firstHeader = (value) => {
  const header = Array.isArray(value) ? value[0] : value
  return String(header || '').split(',')[0].trim()
}

const requestBaseUrl = (req) => {
  const host = firstHeader(req?.headers?.['x-forwarded-host']) || firstHeader(req?.headers?.host)
  if (!host) return ''
  const proto = firstHeader(req?.headers?.['x-forwarded-proto']) || req?.protocol || 'https'
  return trimSlash(`${proto}://${host}`)
}

const requireDarazConfig = () => {
  if (!env.daraz.appKey || !env.daraz.appSecret) {
    throw new ApiError(503, 'Daraz integration is not configured.', 'DARAZ_NOT_CONFIGURED')
  }
}

const createSignature = (path, parameters) => {
  const input = Object.keys(parameters)
    .sort()
    .reduce((value, key) => `${value}${key}${parameters[key]}`, path)
  return crypto.createHmac('sha256', env.daraz.appSecret).update(input).digest('hex').toUpperCase()
}

const darazRequest = async (path, parameters = {}, accessToken, apiUrl = env.daraz.systemApiUrl) => {
  requireDarazConfig()
  const signedParameters = {
    app_key: env.daraz.appKey,
    sign_method: 'sha256',
    timestamp: String(Date.now()),
    ...parameters,
  }
  if (accessToken) signedParameters.access_token = accessToken
  signedParameters.sign = createSignature(path, signedParameters)

  try {
    const { data } = await axios.get(`${apiUrl}${path}`, {
      params: signedParameters,
      timeout: 15000,
    })
    if (data?.code && String(data.code) !== '0') {
      throw new ApiError(502, data.message || 'Daraz rejected the request.', 'DARAZ_API_ERROR', data)
    }
    return data
  } catch (error) {
    if (error instanceof ApiError) throw error
    const details = error.response?.data
    throw new ApiError(
      502,
      details?.message || 'Daraz could not be reached.',
      'DARAZ_API_ERROR',
      details,
    )
  }
}

const secondsFromNow = (seconds) => {
  const parsed = Number(seconds)
  return Number.isFinite(parsed) ? new Date(Date.now() + parsed * 1000) : null
}

const tokenData = (response) => response?.data?.access_token ? response.data : response

const isTokenDecryptError = (error) => (
  /unable to authenticate data|bad decrypt|wrong final block length/i.test(String(error?.message || ''))
)

const isReconnectRequiredError = (error) => (
  error?.code === 'DARAZ_RECONNECT_REQUIRED' || isTokenDecryptError(error)
)

const marketApiUrl = (connection) => {
  if (env.daraz.apiUrl) return env.daraz.apiUrl
  const market = `${connection.country || ''} ${connection.accountPlatform || ''}`.toLowerCase()
  if (/pakistan|\bpk\b/.test(market)) return 'https://api.daraz.pk/rest'
  if (/bangladesh|\bbd\b/.test(market)) return 'https://api.daraz.com.bd/rest'
  if (/sri.?lanka|\blk\b/.test(market)) return 'https://api.daraz.lk/rest'
  if (/nepal|\bnp\b/.test(market)) return 'https://api.daraz.com.np/rest'
  if (/myanmar|\bmm\b/.test(market)) return 'https://api.shop.com.mm/rest'
  return env.daraz.systemApiUrl
}

const saveConnection = async (userId, response) => {
  const data = tokenData(response)
  if (!data?.access_token) {
    throw new ApiError(502, 'Daraz did not return an access token.', 'DARAZ_TOKEN_ERROR', response)
  }

  const [connection] = await DarazConnection.findOrCreate({
    where: { userId },
    defaults: { userId },
  })
  await connection.update({
    sellerId: data.seller_id ? String(data.seller_id) : connection.sellerId,
    sellerName: data.account || data.seller_name || connection.sellerName,
    accountPlatform: data.account_platform || connection.accountPlatform,
    country: data.country || connection.country,
    metadata: {
      ...(connection.metadata || {}),
      countryUserInfo: data.country_user_info || null,
    },
    encryptedAccessToken: encrypt(data.access_token),
    encryptedRefreshToken: data.refresh_token
      ? encrypt(data.refresh_token)
      : connection.encryptedRefreshToken,
    accessTokenExpiresAt: secondsFromNow(data.expires_in),
    refreshTokenExpiresAt: secondsFromNow(data.refresh_expires_in),
    connectedAt: new Date(),
    disconnectedAt: null,
  })
  return connection
}

const refreshConnection = async (connection) => {
  const expiresAt = connection.accessTokenExpiresAt?.getTime() || 0
  if (expiresAt > Date.now() + 10 * 60 * 1000) return connection
  let refreshToken
  try {
    refreshToken = decrypt(connection.encryptedRefreshToken)
  } catch {
    throw new ApiError(401, 'Reconnect your Daraz account.', 'DARAZ_RECONNECT_REQUIRED')
  }
  if (!refreshToken) throw new ApiError(401, 'Reconnect your Daraz account.', 'DARAZ_RECONNECT_REQUIRED')

  const response = await darazRequest('/auth/token/refresh', { refresh_token: refreshToken })
  return saveConnection(connection.userId, response)
}

const extractCount = (response, fallback) => {
  const candidates = [response?.data?.count, response?.count, response?.data?.total, response?.total]
  const value = candidates.find((item) => Number.isFinite(Number(item)))
  return value === undefined ? fallback : Number(value)
}

const arrayFrom = (...values) => values.find((value) => Array.isArray(value)) || []

const orderList = (response) => arrayFrom(
  response?.data?.orders,
  response?.data?.Orders,
  response?.orders,
  response?.Orders,
)

const productList = (response) => arrayFrom(
  response?.data?.products,
  response?.data?.Products,
  response?.data?.items,
  response?.products,
  response?.Products,
)

const startOfMonth = () => {
  const date = new Date()
  date.setDate(1)
  date.setHours(0, 0, 0, 0)
  return date
}

const startOfYear = () => {
  const date = new Date()
  date.setMonth(0, 1)
  date.setHours(0, 0, 0, 0)
  return date
}

const dayKey = (value) => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

const orderCreatedAt = (order) => (
  order.created_at ||
  order.createdAt ||
  order.created_date ||
  order.createTime ||
  order.order_date ||
  order.updated_at ||
  order.updatedAt
)

const buildDailyOrders = (orders, days = 30) => {
  const counts = new Map()
  const start = new Date()
  start.setDate(start.getDate() - (days - 1))
  start.setHours(0, 0, 0, 0)

  for (let i = 0; i < days; i += 1) {
    const date = new Date(start)
    date.setDate(start.getDate() + i)
    counts.set(dayKey(date), 0)
  }

  for (const order of orders) {
    const key = dayKey(orderCreatedAt(order))
    if (key && counts.has(key)) counts.set(key, counts.get(key) + 1)
  }

  return [...counts.entries()].map(([date, ordersCount]) => ({ date, orders: ordersCount }))
}

const buildStatusBreakdown = (orders) => {
  const counts = orders.reduce((items, order) => {
    const raw = String(order.status || order.order_status || 'unknown').trim().toLowerCase() || 'unknown'
    const label = raw.includes('cancel')
      ? 'cancelled'
      : raw.includes('return') || raw.includes('refund')
        ? 'returned'
        : raw.includes('ship') || raw.includes('deliver')
          ? 'shipped'
          : raw.includes('pending') || raw.includes('pack')
            ? 'pending'
            : raw
    items[label] = (items[label] || 0) + 1
    return items
  }, {})

  return Object.entries(counts)
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count)
}

const orderItems = (order) => arrayFrom(
  order.items,
  order.order_items,
  order.OrderItems,
  order.orderItems,
  order.item_list,
)

const buildTopProducts = (orders) => {
  const byProduct = new Map()
  for (const order of orders) {
    for (const item of orderItems(order)) {
      const title = item.name || item.title || item.product_name || item.item_name || item.sku || 'Unknown product'
      const sku = item.sku || item.seller_sku || item.SellerSku || item.item_sku || null
      const key = sku || title
      const current = byProduct.get(key) || { title, sku, orders: 0, units: 0 }
      const quantity = Number(item.quantity || item.qty || item.paid_quantity || 1)
      current.orders += 1
      current.units += Number.isFinite(quantity) ? quantity : 1
      byProduct.set(key, current)
    }
  }
  return [...byProduct.values()]
    .sort((a, b) => b.units - a.units || b.orders - a.orders)
    .slice(0, 5)
}

const countFrom = (response) => extractCount(response, null)

const fetchSellerStats = async (connection) => {
  let accessToken
  try {
    accessToken = decrypt(connection.encryptedAccessToken)
  } catch {
    throw new ApiError(401, 'Reconnect your Daraz account.', 'DARAZ_RECONNECT_REQUIRED')
  }
  const apiUrl = marketApiUrl(connection)
  const now = new Date()
  const createdAfter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const monthStart = startOfMonth().toISOString()
  const yearStart = startOfYear().toISOString()
  const results = await Promise.allSettled([
    darazRequest('/seller/get', {}, accessToken, apiUrl),
    darazRequest('/orders/get', {
      created_after: createdAfter,
      limit: 1,
      offset: 0,
      sort_direction: 'DESC',
    }, accessToken, apiUrl),
    darazRequest('/orders/get', {
      created_after: monthStart,
      limit: 100,
      offset: 0,
      sort_direction: 'DESC',
    }, accessToken, apiUrl),
    darazRequest('/orders/get', {
      created_after: yearStart,
      limit: 100,
      offset: 0,
      sort_direction: 'DESC',
    }, accessToken, apiUrl),
    darazRequest('/orders/get', {
      limit: 1,
      offset: 0,
      sort_direction: 'DESC',
    }, accessToken, apiUrl),
    darazRequest('/products/get', { filter: 'all', limit: 1, offset: 0 }, accessToken, apiUrl),
    darazRequest('/products/get', { filter: 'live', limit: 1, offset: 0 }, accessToken, apiUrl),
    darazRequest('/products/get', { filter: 'pending', limit: 1, offset: 0 }, accessToken, apiUrl),
  ])

  const seller = results[0].status === 'fulfilled' ? results[0].value : null
  const orders = results[1].status === 'fulfilled' ? results[1].value : null
  const monthOrders = results[2].status === 'fulfilled' ? results[2].value : null
  const yearOrders = results[3].status === 'fulfilled' ? results[3].value : null
  const totalOrders = results[4].status === 'fulfilled' ? results[4].value : null
  const products = results[5].status === 'fulfilled' ? results[5].value : null
  const activeProducts = results[6].status === 'fulfilled' ? results[6].value : null
  const draftProducts = results[7].status === 'fulfilled' ? results[7].value : null
  const sellerData = seller?.data || seller || {}
  const recentOrders = orderList(orders)
  const yearOrderRows = orderList(yearOrders)

  await connection.update({
    sellerId: sellerData.seller_id ? String(sellerData.seller_id) : connection.sellerId,
    sellerName: sellerData.name || sellerData.seller_name || connection.sellerName,
    country: sellerData.country || connection.country,
    lastSyncedAt: now,
  })

  return {
    ordersLast30Days: extractCount(orders, recentOrders.length),
    ordersThisMonth: extractCount(monthOrders, orderList(monthOrders).length),
    ordersThisYear: extractCount(yearOrders, yearOrderRows.length),
    ordersTotal: countFrom(totalOrders) ?? extractCount(yearOrders, yearOrderRows.length),
    products: extractCount(products, productList(products).length),
    activeProducts: countFrom(activeProducts),
    draftProducts: countFrom(draftProducts),
    synced: [
      seller,
      orders,
      products,
    ].filter(Boolean).length,
    totalSources: 3,
    sourceLabels: ['Seller profile', 'Orders API', 'Product catalog'],
    lastSyncedAt: now,
    charts: {
      dailyOrders: buildDailyOrders(recentOrders, 30),
      statusBreakdown: buildStatusBreakdown(recentOrders),
      topProducts: buildTopProducts(yearOrderRows.length ? yearOrderRows : recentOrders),
    },
  }
}

const createAuthorizationUrl = (userId, baseUrl = '') => {
  requireDarazConfig()
  const state = jwt.sign(
    { purpose: 'daraz_connect' },
    env.stateSecret,
    { subject: userId, expiresIn: '10m' },
  )
  const url = new URL(env.daraz.authUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', env.daraz.appKey)
  const redirectUri = process.env.DARAZ_REDIRECT_URI ||
    (baseUrl ? `${trimSlash(baseUrl)}/api/daraz/callback` : env.daraz.redirectUri)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('force_auth', 'true')
  return url.toString()
}

const publicConnection = (connection) => ({
  sellerId: connection.sellerId,
  sellerName: connection.sellerName,
  accountPlatform: connection.accountPlatform,
  country: connection.country,
  connectedAt: connection.connectedAt,
})

const isShowcaseConnection = (connection) => Boolean(
  connection?.metadata?.showcaseDemo &&
  connection?.metadata?.showcaseDataset,
)

const showcaseStatusStats = async (connection) => {
  const snapshots = await StoreSnapshot.findAll({
    where: { userId: connection.userId },
    order: [['capturedAt', 'DESC']],
    limit: 12,
  })
  const snapshot = snapshots.find((entry) => (
    entry.sourceSummary?.showcaseDataset === connection.metadata?.showcaseDataset
  )) || snapshots[0]
  const metrics = snapshot?.metrics || {}
  const sourceSummary = snapshot?.sourceSummary || {}
  const productCount = await ProductSnapshot.count({ where: { userId: connection.userId } })

  return {
    ordersLast30Days: metrics.ordersLast30Days ?? metrics.orders ?? 0,
    ordersThisMonth: metrics.ordersThisMonth ?? metrics.orders ?? 0,
    ordersThisYear: metrics.ordersThisYear ?? metrics.ordersTotal ?? metrics.orders ?? 0,
    ordersTotal: metrics.ordersTotal ?? metrics.ordersThisYear ?? metrics.orders ?? 0,
    revenue: metrics.revenue ?? 0,
    cancelRate: metrics.cancelRate ?? null,
    returnRate: metrics.returnRate ?? null,
    sellerRating: metrics.sellerRating ?? null,
    shipOnTimeRate: metrics.shipOnTimeRate ?? null,
    products: metrics.products ?? productCount,
    activeProducts: metrics.activeProducts ?? productCount,
    draftProducts: metrics.draftProducts ?? 0,
    synced: sourceSummary.synced ?? 3,
    totalSources: sourceSummary.total ?? 3,
    sourceLabels: sourceSummary.sourceLabels || ['Seller profile', 'Orders history', 'Product catalog'],
    lastSyncedAt: connection.lastSyncedAt || snapshot?.capturedAt || connection.connectedAt,
    charts: metrics.charts || {
      dailyOrders: [],
      statusBreakdown: [],
      topProducts: [],
    },
  }
}

router.get('/connect', authenticate, asyncHandler(async (req, res) => {
  res.json({ authorizationUrl: createAuthorizationUrl(req.user.id, requestBaseUrl(req)) })
}))

router.get('/callback', async (req, res) => {
  const frontend = new URL(env.frontendUrl)
  try {
    requireDarazConfig()
    if (!req.query.code || !req.query.state) {
      throw new ApiError(400, 'Daraz authorization was cancelled.', 'DARAZ_AUTH_CANCELLED')
    }

    const state = jwt.verify(String(req.query.state), env.stateSecret)
    if (state.purpose !== 'daraz_connect') throw new Error('Invalid OAuth state')
    const response = await darazRequest('/auth/token/create', { code: String(req.query.code) })
    await saveConnection(state.sub, response)
    frontend.searchParams.set('daraz', 'connected')
  } catch (error) {
    frontend.searchParams.set('daraz', 'error')
    frontend.searchParams.set('message', error.message || 'Daraz connection failed.')
  }
  res.redirect(frontend.toString())
})

router.get('/status', authenticate, asyncHandler(async (req, res) => {
  let connection = await DarazConnection.findOne({
    where: { userId: req.user.id, disconnectedAt: null },
  })
  if (connection && isShowcaseConnection(connection) && !connection.encryptedAccessToken) {
    return res.json({
      connected: true,
      showcase: true,
      connection: publicConnection(connection),
      stats: await showcaseStatusStats(connection),
    })
  }
  if (!connection?.encryptedAccessToken) return res.json({ connected: false })

  try {
    connection = await refreshConnection(connection)
    const stats = await fetchSellerStats(connection)
    res.json({
      connected: true,
      connection: publicConnection(connection),
      stats,
    })
  } catch (error) {
    if (!isReconnectRequiredError(error)) throw error
    res.json({
      connected: false,
      reconnectRequired: true,
      message: 'Reconnect your Daraz account.',
      authorizationUrl: createAuthorizationUrl(req.user.id, requestBaseUrl(req)),
      connection: publicConnection(connection),
    })
  }
}))

router.delete('/connection', authenticate, asyncHandler(async (req, res) => {
  const connection = await DarazConnection.findOne({
    where: { userId: req.user.id, disconnectedAt: null },
  })
  if (connection) {
    await connection.update({
      encryptedAccessToken: null,
      encryptedRefreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      disconnectedAt: new Date(),
    })
  }
  res.json({ connected: false })
}))

module.exports = router
module.exports.darazRequest = darazRequest
module.exports.refreshConnection = refreshConnection
module.exports.marketApiUrl = marketApiUrl
module.exports.createAuthorizationUrl = createAuthorizationUrl
module.exports.isReconnectRequiredError = isReconnectRequiredError
module.exports.requestBaseUrl = requestBaseUrl
