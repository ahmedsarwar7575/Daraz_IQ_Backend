const crypto = require('crypto')
const fs = require('fs/promises')
const path = require('path')
const express = require('express')
const { Op } = require('sequelize')
const env = require('../config')
const {
  CompetitorSnapshot,
  DarazConnection,
  GuardrailConfig,
  ProductSnapshot,
  RepriceLog,
  StoreSnapshot,
} = require('../models')
const { authenticate } = require('../middleware')
const { ApiError, asyncHandler, decrypt } = require('../utils')
const darazFeature = require('./daraz')
const { resolveAiProvider } = require('./settings')

const router = express.Router()

const fixturePath = process.env.COMPETITOR_SOURCE_FILE || path.join(__dirname, '..', 'data', 'products.json')
const scraperPath = process.env.COMPETITOR_SCRAPER_FILE || path.join(__dirname, '..', 'services', 'competitorScraper.js')
const scrapeLocks = new Map()

const manifest = {
  tools: [
    'get_store_metrics',
    'get_metrics_history',
    'analyze_store_performance',
    'get_own_product',
    'search_competitors',
    'analyze_product',
    'flag_anomalies',
    'analyze_price',
    'apply_reprice',
    'get_reprice_history',
  ],
  resources: [
    'store://metrics/latest',
    'store://metrics/history',
    'product://{id}/own',
    'product://{id}/competitors',
    'pricing://{sku}/competitor-snapshot',
    'pricing://{sku}/history',
    'pricing://{sku}/guardrails',
  ],
  prompts: ['weekly_store_review', 'product_health_check', 'reprice_workflow'],
}

const cleanQuery = (value) => String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120)

const numberFromText = (value) => {
  if (value === null || value === undefined || value === '') return null
  if (Number.isFinite(Number(value))) return Number(value)
  const match = String(value).replace(/,/g, '').match(/\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : null
}

const compactDate = (value) => (value ? new Date(value).toISOString() : null)

const median = (values) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

const percentileValue = (values, percentile) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((percentile / 100) * (sorted.length - 1))))
  return sorted[index]
}

const pricePercentile = (price, values) => {
  if (!Number.isFinite(price)) return null
  const valid = values.filter((value) => Number.isFinite(value))
  if (!valid.length) return null
  return Math.round((valid.filter((value) => value <= price).length / valid.length) * 100)
}

const percentChange = (current, previous) => {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null
  return Math.round(((current - previous) / previous) * 1000) / 10
}

const normalizeProduct = (product, index = 0) => {
  const price = numberFromText(product.price ?? product.priceText ?? product.salePrice ?? product.sale_price)
  const title = product.title || product.name || product.productName || 'Untitled product'
  return {
    rank: product.rank || index + 1,
    page: product.page || 1,
    positionOnPage: product.positionOnPage || index + 1,
    itemId: product.itemId || product.item_id || product.id || null,
    sku: product.sku || product.sellerSku || product.seller_sku || null,
    title,
    productUrl: product.productUrl || product.url || null,
    imageUrl: product.imageUrl || product.image || null,
    price,
    priceText: product.priceText || (Number.isFinite(price) ? `Rs. ${price}` : null),
    currency: product.currency || 'PKR',
    discountPercent: numberFromText(product.discountPercent ?? product.discountText),
    soldCount: numberFromText(product.soldCount ?? product.soldText),
    reviewCount: numberFromText(product.reviewCount ?? product.reviewsText),
    rating: numberFromText(product.rating ?? product.ratingScore),
    location: product.location || null,
    imageCount: product.imageCount || (product.imageUrl || product.image ? 1 : 0),
  }
}

const competitorMetrics = (products) => {
  const prices = products.map((product) => product.price).filter((price) => Number.isFinite(price))
  const soldCounts = products.map((product) => product.soldCount).filter((count) => Number.isFinite(count))
  const reviewCounts = products.map((product) => product.reviewCount).filter((count) => Number.isFinite(count))
  return {
    count: products.length,
    pricedCount: prices.length,
    minPrice: prices.length ? Math.min(...prices) : null,
    p25Price: percentileValue(prices, 25),
    medianPrice: median(prices),
    p75Price: percentileValue(prices, 75),
    maxPrice: prices.length ? Math.max(...prices) : null,
    medianSold: median(soldCounts),
    medianReviews: median(reviewCounts),
  }
}

const buildSearchUrl = (query) => {
  const url = new URL('https://www.daraz.pk/catalog/')
  url.searchParams.set('q', query)
  return url.toString()
}

const readFixtureProducts = async (query, limit) => {
  const raw = JSON.parse(await fs.readFile(fixturePath, 'utf8'))
  const normalizedQuery = query.toLowerCase()
  let products = (raw.products || [])
    .map(normalizeProduct)
    .filter((product) => product.title.toLowerCase().includes(normalizedQuery))

  if (!products.length) products = (raw.products || []).map(normalizeProduct)
  return {
    sourceUrl: raw.sourceUrl,
    scrapedAt: raw.scrapedAt,
    source: 'sample_fixture',
    products: products.slice(0, limit),
  }
}

const scrapeProductsLive = async (query, limit) => {
  const key = query.toLowerCase()
  if (scrapeLocks.has(key)) return scrapeLocks.get(key)

  const job = (async () => {
    const { scrapeProducts } = require(scraperPath)
    const sourceUrl = buildSearchUrl(query)
    const result = await scrapeProducts(sourceUrl, {
      maxPages: env.copilot.scrapeMaxPages,
      headless: true,
    })
    return {
      sourceUrl,
      scrapedAt: result.scrapedAt,
      source: 'live_scrape',
      products: (result.products || []).map(normalizeProduct).slice(0, limit),
    }
  })().finally(() => scrapeLocks.delete(key))

  scrapeLocks.set(key, job)
  return job
}

const loadCompetitors = async (userId, query, limit = 12, refresh = false) => {
  const normalizedQuery = cleanQuery(query)
  if (!normalizedQuery) throw new ApiError(400, 'Search query is required.', 'QUERY_REQUIRED')

  const now = new Date()
  const cached = !refresh && await CompetitorSnapshot.findOne({
    where: {
      userId,
      query: normalizedQuery.toLowerCase(),
      expiresAt: { [Op.gt]: now },
    },
    order: [['createdAt', 'DESC']],
  })

  if (cached) {
    const products = (cached.products || []).map(normalizeProduct).slice(0, limit)
    return {
      query: normalizedQuery,
      source: cached.source || 'database_cache',
      sourceUrl: cached.sourceUrl,
      scrapedAt: cached.scrapedAt,
      cachedUntil: cached.expiresAt,
      metrics: competitorMetrics(products),
      products,
    }
  }

  let payload
  if (env.copilot.liveScrapeEnabled && refresh) {
    payload = await scrapeProductsLive(normalizedQuery, limit).catch(() => null)
  }
  if (!payload) payload = await readFixtureProducts(normalizedQuery, limit)

  const products = payload.products.map(normalizeProduct).slice(0, limit)
  const metrics = competitorMetrics(products)
  const expiresAt = new Date(Date.now() + env.copilot.competitorCacheTtlHours * 60 * 60 * 1000)
  await CompetitorSnapshot.create({
    userId,
    query: normalizedQuery.toLowerCase(),
    sourceUrl: payload.sourceUrl || buildSearchUrl(normalizedQuery),
    source: payload.source,
    scrapedAt: payload.scrapedAt ? new Date(payload.scrapedAt) : now,
    expiresAt,
    metrics,
    products,
  })

  return {
    query: normalizedQuery,
    source: payload.source,
    sourceUrl: payload.sourceUrl || buildSearchUrl(normalizedQuery),
    scrapedAt: payload.scrapedAt || now,
    cachedUntil: expiresAt,
    metrics,
    products,
  }
}

const dateRangeFrom = (input = {}) => {
  const now = new Date()
  const days = Math.max(1, Math.min(90, Number(input.days || 7)))
  return {
    start: input.from ? new Date(input.from) : new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
    end: input.to ? new Date(input.to) : now,
  }
}

const arrayFrom = (...values) => values.find((value) => Array.isArray(value)) || []

const extractCount = (response, fallback = null) => {
  const candidates = [response?.data?.count, response?.count, response?.data?.total, response?.total]
  const value = candidates.find((item) => Number.isFinite(Number(item)))
  return value === undefined ? fallback : Number(value)
}

const orderValue = (order) => (
  numberFromText(order.price) ||
  numberFromText(order.item_price) ||
  numberFromText(order.paid_price) ||
  numberFromText(order.order_value) ||
  numberFromText(order.grand_total)
)

const statusMatches = (order, pattern) => {
  const status = String(order.status || order.order_status || '').toLowerCase()
  return pattern.test(status)
}

const safeDarazReconnectUrl = (userId, baseUrl = '') => {
  try {
    return darazFeature.createAuthorizationUrl(userId, baseUrl)
  } catch {
    return null
  }
}

const disconnectedStorePayload = (userId, reason = 'daraz_connection', baseUrl = '') => ({
  connected: false,
  reconnectRequired: reason === 'daraz_auth',
  reconnectUrl: reason === 'daraz_auth' ? safeDarazReconnectUrl(userId, baseUrl) : null,
  metrics: {
    orders: 0,
    revenue: null,
    cancelRate: null,
    returnRate: null,
    sellerRating: null,
  },
  sourceSummary: { synced: 0, total: 3, failed: [reason] },
})

const getConnectionContext = async (userId, baseUrl = '') => {
  try {
    let connection = await DarazConnection.findOne({ where: { userId, disconnectedAt: null } })
    if (!connection?.encryptedAccessToken) return null
    connection = await darazFeature.refreshConnection(connection)
    return {
      connection,
      accessToken: decrypt(connection.encryptedAccessToken),
      apiUrl: darazFeature.marketApiUrl(connection),
    }
  } catch (error) {
    if (darazFeature.isReconnectRequiredError(error)) {
      return { reconnectRequired: true, reason: 'daraz_auth', reconnectUrl: safeDarazReconnectUrl(userId, baseUrl) }
    }
    throw error
  }
}

const fetchStoreMetrics = async (userId, range, baseUrl = '') => {
  const context = await getConnectionContext(userId, baseUrl)
  if (!context) {
    return disconnectedStorePayload(userId, 'daraz_connection', baseUrl)
  }
  if (context.reconnectRequired) {
    return disconnectedStorePayload(userId, context.reason, baseUrl)
  }

  const createdAfter = range.start.toISOString()
  const createdBefore = range.end.toISOString()
  const calls = await Promise.allSettled([
    darazFeature.darazRequest('/orders/get', {
      created_after: createdAfter,
      created_before: createdBefore,
      limit: 100,
      offset: 0,
      sort_direction: 'DESC',
    }, context.accessToken, context.apiUrl),
    darazFeature.darazRequest('/finance/transaction/details/get', {
      start_time: createdAfter,
      end_time: createdBefore,
      limit: 100,
      offset: 0,
    }, context.accessToken, context.apiUrl),
    darazFeature.darazRequest('/seller/metrics/get', {}, context.accessToken, context.apiUrl),
  ])

  const ordersResponse = calls[0].status === 'fulfilled' ? calls[0].value : null
  const financeResponse = calls[1].status === 'fulfilled' ? calls[1].value : null
  const sellerMetrics = calls[2].status === 'fulfilled' ? calls[2].value : null
  const orders = arrayFrom(
    ordersResponse?.data?.orders,
    ordersResponse?.data?.Orders,
    ordersResponse?.orders,
    ordersResponse?.Orders,
  )
  const transactions = arrayFrom(
    financeResponse?.data?.transactions,
    financeResponse?.data?.transaction_details,
    financeResponse?.transactions,
  )
  const orderCount = extractCount(ordersResponse, orders.length)
  const cancelled = orders.filter((order) => statusMatches(order, /cancel/)).length
  const returned = orders.filter((order) => statusMatches(order, /return|refund/)).length
  const orderRevenue = orders.map(orderValue).filter(Number.isFinite).reduce((sum, value) => sum + value, 0)
  const financeRevenue = transactions
    .map((item) => numberFromText(item.amount || item.credit || item.payout || item.transaction_amount))
    .filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0)
  const sellerData = sellerMetrics?.data || sellerMetrics || {}

  return {
    connected: true,
    metrics: {
      orders: orderCount,
      revenue: orderRevenue || financeRevenue || null,
      cancelRate: orderCount ? Math.round((cancelled / orderCount) * 1000) / 10 : null,
      returnRate: orderCount ? Math.round((returned / orderCount) * 1000) / 10 : null,
      sellerRating: numberFromText(sellerData.positive_seller_rating || sellerData.positiveSellerRating || sellerData.rating),
      shipOnTimeRate: numberFromText(sellerData.ship_on_time_rate || sellerData.shipOnTimeRate),
    },
    sourceSummary: {
      synced: calls.filter((call) => call.status === 'fulfilled').length,
      total: calls.length,
      failed: calls
        .map((call, index) => call.status === 'rejected' ? ['orders', 'finance', 'seller_metrics'][index] : null)
        .filter(Boolean),
    },
  }
}

const saveStoreSnapshot = async (userId, range, payload) => StoreSnapshot.create({
  userId,
  rangeStart: range.start,
  rangeEnd: range.end,
  metrics: payload.metrics,
  sourceSummary: payload.sourceSummary,
  capturedAt: new Date(),
})

const storeRecommendations = (current, history) => {
  const previous = history[0]?.metrics || null
  const revenueDelta = previous ? percentChange(current.revenue, Number(previous.revenue)) : null
  const orderDelta = previous ? percentChange(current.orders, Number(previous.orders)) : null
  const findings = []

  if (current.orders === 0) {
    findings.push({
      severity: 'high',
      title: 'Order activity needs attention',
      metric: `Orders: ${current.orders}`,
      action: 'Review active listings, stock availability, and competitor prices before increasing spend.',
    })
  } else if (orderDelta !== null && orderDelta < -15) {
    findings.push({
      severity: 'high',
      title: 'Orders are trending down',
      metric: `Orders delta: ${orderDelta}%`,
      action: 'Compare the top sold SKUs against fresh competitor pricing and check stockouts.',
    })
  }

  if (revenueDelta !== null && revenueDelta < -10) {
    findings.push({
      severity: 'medium',
      title: 'Revenue softened versus the prior snapshot',
      metric: `Revenue delta: ${revenueDelta}%`,
      action: 'Prioritize high-volume SKUs with prices above competitor median.',
    })
  }

  if (Number.isFinite(current.cancelRate) && current.cancelRate > 8) {
    findings.push({
      severity: 'medium',
      title: 'Cancellation rate is elevated',
      metric: `Cancel rate: ${current.cancelRate}%`,
      action: 'Check inventory accuracy and fulfillment cutoff handling for recent orders.',
    })
  }

  if (!findings.length) {
    findings.push({
      severity: 'low',
      title: 'No major anomaly in the current snapshot',
      metric: `Orders: ${current.orders}, revenue: ${current.revenue ?? 'not available'}`,
      action: 'Run product-level benchmarks on the SKUs with the highest revenue impact.',
    })
  }

  return findings
}

const normalizeOwnProduct = (response, fallback = {}) => {
  const data = response?.data || response || {}
  const product = data.product || data.item || data
  const skus = arrayFrom(product.skus, product.Skus, product.sku_list, product.Sku)
  const firstSku = skus[0] || {}
  const images = arrayFrom(product.images, product.Images, product.image_urls)
  const price = numberFromText(fallback.currentPrice) ||
    numberFromText(product.price) ||
    numberFromText(product.sale_price) ||
    numberFromText(firstSku.price) ||
    numberFromText(firstSku.sale_price)

  return {
    itemId: product.item_id || product.itemId || fallback.productId || null,
    sku: firstSku.SellerSku || firstSku.seller_sku || fallback.sku || fallback.productId || null,
    title: product.name || product.title || fallback.title || 'Own product',
    price,
    stock: numberFromText(product.quantity || product.stock || firstSku.quantity || firstSku.stock),
    rating: numberFromText(product.rating || product.review_rating),
    reviewCount: numberFromText(product.review_count || product.reviews),
    imageCount: images.length || (product.image ? 1 : 0),
    imageUrl: images[0] || product.image || null,
    source: response ? 'daraz_product_api' : 'manual_input',
  }
}

const publicProductSnapshot = (product) => ({
  id: product.id,
  itemId: product.itemId,
  sku: product.sku,
  title: product.title,
  query: product.query || product.title,
  price: product.price,
  cost: product.cost,
  stock: product.stock,
  rating: product.rating,
  reviewCount: product.reviewCount,
  imageCount: product.imageCount,
  imageUrl: product.imageUrl,
  status: product.status,
  source: product.source,
  capturedAt: product.capturedAt,
})

const listProductsPayload = async (userId) => {
  const products = await ProductSnapshot.findAll({
    where: { userId },
    order: [['capturedAt', 'DESC'], ['title', 'ASC']],
  })
  return { products: products.map(publicProductSnapshot) }
}

const findProductSnapshot = async (userId, input = {}) => {
  const identifiers = [input.productId, input.sku]
    .map((value) => cleanQuery(value))
    .filter(Boolean)
  if (!identifiers.length) return null

  return ProductSnapshot.findOne({
    where: {
      userId,
      [Op.or]: [
        { sku: { [Op.in]: identifiers } },
        { itemId: { [Op.in]: identifiers } },
      ],
    },
    order: [['capturedAt', 'DESC']],
  })
}

const fetchOwnProduct = async (userId, input) => {
  const snapshot = await findProductSnapshot(userId, input)
  if (snapshot) {
    return {
      itemId: snapshot.itemId || snapshot.id,
      sku: snapshot.sku,
      title: snapshot.title,
      price: numberFromText(input.currentPrice) || snapshot.price,
      cost: numberFromText(input.cost) || snapshot.cost,
      stock: snapshot.stock,
      rating: snapshot.rating,
      reviewCount: snapshot.reviewCount,
      imageCount: snapshot.imageCount,
      imageUrl: snapshot.imageUrl,
      query: snapshot.query || snapshot.title,
      source: snapshot.source || 'sellerdesk_snapshot',
    }
  }

  if (!input.productId) return normalizeOwnProduct(null, input)
  const context = await getConnectionContext(userId)
  if (!context) return normalizeOwnProduct(null, input)

  const id = String(input.productId)
  const params = /^\d+$/.test(id) ? { item_id: id } : { seller_sku: id }
  try {
    const response = await darazFeature.darazRequest('/product/item/get', params, context.accessToken, context.apiUrl)
    return normalizeOwnProduct(response, input)
  } catch (error) {
    return {
      ...normalizeOwnProduct(null, input),
      source: 'manual_input',
      apiWarning: error.message,
    }
  }
}

const productRecommendations = (ownProduct, competitors) => {
  const prices = competitors.map((product) => product.price).filter(Number.isFinite)
  const metrics = competitorMetrics(competitors)
  const ownPrice = Number(ownProduct.price)
  const titleLength = ownProduct.title?.length || 0
  const competitorTitleMedian = median(competitors.map((product) => product.title.length))
  const priceRank = pricePercentile(ownPrice, prices)
  const findings = []

  if (Number.isFinite(ownPrice) && Number.isFinite(metrics.medianPrice)) {
    const gap = Math.round(((ownPrice - metrics.medianPrice) / metrics.medianPrice) * 1000) / 10
    findings.push({
      severity: Math.abs(gap) > 15 ? 'high' : 'medium',
      title: gap > 0 ? 'Price is above competitor median' : 'Price is below competitor median',
      metric: `Own price: ${ownPrice}, competitor median: ${metrics.medianPrice}, gap: ${gap}%`,
      action: gap > 0
        ? 'Test a guarded price move toward the 25th-to-50th percentile band.'
        : 'Protect margin before going lower; improve title/images instead of racing down.',
    })
  }

  if (priceRank !== null) {
    findings.push({
      severity: priceRank > 75 ? 'medium' : 'low',
      title: 'Competitive price position computed',
      metric: `Price percentile: ${priceRank} of ${prices.length} priced competitors`,
      action: priceRank > 75 ? 'Investigate why higher-priced competitors still rank.' : 'Hold pricing unless margin or stock pressure changes.',
    })
  }

  if (competitorTitleMedian && titleLength < competitorTitleMedian * 0.65) {
    findings.push({
      severity: 'low',
      title: 'Title may be under-specified',
      metric: `Title length: ${titleLength}, competitor median: ${competitorTitleMedian}`,
      action: 'Add material, fit/use case, quantity, and audience terms that match the winning listings.',
    })
  }

  return findings
}

const getGuardrails = async (userId) => {
  const [guardrails] = await GuardrailConfig.findOrCreate({
    where: { userId },
    defaults: { userId },
  })
  return guardrails
}

const publicGuardrails = (guardrails) => ({
  autonomyLevel: guardrails.autonomyLevel,
  minMarginPercent: guardrails.minMarginPercent,
  maxDeltaPercent: guardrails.maxDeltaPercent,
  maxRepricesPerSkuPerDay: guardrails.maxRepricesPerSkuPerDay,
  priceFloor: guardrails.priceFloor,
  priceCeiling: guardrails.priceCeiling,
  liveWritesEnabled: guardrails.liveWritesEnabled,
})

const analyzePricePayload = async (userId, input) => {
  const currentPrice = numberFromText(input.currentPrice)
  if (!Number.isFinite(currentPrice)) {
    throw new ApiError(400, 'Current price is required for price analysis.', 'CURRENT_PRICE_REQUIRED')
  }

  const competitors = await loadCompetitors(userId, input.query || input.sku, Number(input.limit || 12), false)
  const metrics = competitors.metrics
  const guardrails = await getGuardrails(userId)
  const cost = numberFromText(input.cost)
  const marginFloor = Number.isFinite(cost)
    ? Math.round(cost * (1 + guardrails.minMarginPercent / 100))
    : null
  const explicitFloor = numberFromText(guardrails.priceFloor)
  const floor = Math.max(...[marginFloor, explicitFloor, 0].filter(Number.isFinite))
  const ceiling = numberFromText(guardrails.priceCeiling) || metrics.p75Price || Math.round(currentPrice * 1.3)
  const maxMove = currentPrice * (guardrails.maxDeltaPercent / 100)
  const marketTarget = metrics.p25Price || metrics.medianPrice || currentPrice
  const rawRecommendation = Math.round(marketTarget)
  const recommendedPrice = Math.round(Math.max(
    floor,
    Math.min(ceiling, currentPrice + maxMove, Math.max(currentPrice - maxMove, rawRecommendation)),
  ))

  return {
    sku: input.sku || null,
    query: competitors.query,
    currentPrice,
    cost,
    recommendedPrice,
    deltaPercent: Math.round(((recommendedPrice - currentPrice) / currentPrice) * 1000) / 10,
    pricePercentile: pricePercentile(currentPrice, competitors.products.map((product) => product.price)),
    competitorMetrics: metrics,
    guardrails: publicGuardrails(guardrails),
    rationale: [
      `Competitor median: ${metrics.medianPrice ?? 'not available'}`,
      `Target band: ${metrics.p25Price ?? metrics.medianPrice ?? 'not available'}`,
      `Floor enforced: ${floor || 'none'}`,
      `Max delta per run: ${guardrails.maxDeltaPercent}%`,
    ],
  }
}

const getStoreMetricsPayload = async (userId, input = {}) => {
  const range = dateRangeFrom(input)
  const payload = await fetchStoreMetrics(userId, range, input.__requestOrigin)
  const snapshot = await saveStoreSnapshot(userId, range, payload)
  return {
    range: { from: compactDate(range.start), to: compactDate(range.end) },
    snapshotId: snapshot.id,
    ...payload,
  }
}

const getMetricsHistoryPayload = async (userId, input = {}) => {
  const limit = Math.max(1, Math.min(30, Number(input.limit || 8)))
  const snapshots = await StoreSnapshot.findAll({
    where: { userId },
    order: [['capturedAt', 'DESC']],
    limit,
  })
  return {
    snapshots: snapshots.map((snapshot) => ({
      id: snapshot.id,
      capturedAt: snapshot.capturedAt,
      range: { from: snapshot.rangeStart, to: snapshot.rangeEnd },
      metrics: snapshot.metrics,
      sourceSummary: snapshot.sourceSummary,
    })),
  }
}

const analyzeStorePerformancePayload = async (userId, input = {}) => {
  const range = dateRangeFrom(input)
  const payload = await fetchStoreMetrics(userId, range, input.__requestOrigin)
  const snapshot = await saveStoreSnapshot(userId, range, payload)
  const history = await StoreSnapshot.findAll({
    where: {
      userId,
      id: { [Op.ne]: snapshot.id },
    },
    order: [['capturedAt', 'DESC']],
    limit: 6,
  })
  const reconnectRecommendations = [{
    severity: 'high',
    title: 'Daraz reconnect required',
    metric: `Synced ${payload.sourceSummary.synced}/${payload.sourceSummary.total} Daraz data sources`,
    action: payload.reconnectUrl
      ? 'Open the reconnectUrl and authorize Daraz again before using live store metrics.'
      : 'Reconnect Daraz in SellerDesk before using live store metrics.',
  }]
  return {
    range: { from: compactDate(range.start), to: compactDate(range.end) },
    snapshotId: snapshot.id,
    connected: payload.connected,
    reconnectRequired: payload.reconnectRequired,
    reconnectUrl: payload.reconnectUrl,
    metrics: payload.metrics,
    sourceSummary: payload.sourceSummary,
    recommendations: payload.reconnectRequired ? reconnectRecommendations : storeRecommendations(payload.metrics, history),
    historyCompared: history.length,
  }
}

const searchCompetitorsPayload = (userId, input = {}) => loadCompetitors(
  userId,
  input.query,
  Number(input.limit || 12),
  Boolean(input.refresh),
)

const getOwnProductPayload = (userId, input = {}) => fetchOwnProduct(userId, input)

const analyzeProductPayload = async (userId, input = {}) => {
  const ownProduct = await fetchOwnProduct(userId, input)
  const competitors = await loadCompetitors(
    userId,
    input.query || ownProduct.title,
    Number(input.limit || 12),
    Boolean(input.refresh),
  )
  const computed = {
    ownPrice: ownProduct.price,
    competitorMedianPrice: competitors.metrics.medianPrice,
    pricePercentile: pricePercentile(ownProduct.price, competitors.products.map((product) => product.price)),
    titleLength: ownProduct.title?.length || 0,
    competitorTitleMedian: median(competitors.products.map((product) => product.title.length)),
    imageCount: ownProduct.imageCount,
  }
  return {
    ownProduct,
    competitors,
    computed,
    recommendations: productRecommendations(ownProduct, competitors.products),
  }
}

const flagAnomaliesPayload = async (userId, input = {}) => {
  const scope = input.scope || 'store'
  if (scope !== 'store') return { scope, anomalies: [] }

  const latest = await StoreSnapshot.findOne({ where: { userId }, order: [['capturedAt', 'DESC']] })
  const previous = await StoreSnapshot.findAll({ where: { userId }, order: [['capturedAt', 'DESC']], offset: 1, limit: 5 })
  if (!latest || !previous.length) return { scope, anomalies: [] }

  const baselineOrders = median(previous.map((snapshot) => Number(snapshot.metrics?.orders)))
  const orderDrop = percentChange(Number(latest.metrics?.orders), baselineOrders)
  const anomalies = []
  if (orderDrop !== null && orderDrop < -20) {
    anomalies.push({
      severity: 'high',
      metric: `Orders delta vs baseline: ${orderDrop}%`,
      message: 'Orders fell sharply against the rolling snapshot baseline.',
    })
  }
  return { scope, anomalies }
}

const getGuardrailsPayload = async (userId) => ({
  guardrails: publicGuardrails(await getGuardrails(userId)),
})

const cleanForAi = (payload) => JSON.parse(JSON.stringify(payload || {}))

const compactAiPayload = (mode, payload) => {
  const cleanPayload = cleanForAi(payload)
  if (mode === 'product' && cleanPayload.competitors?.products) {
    cleanPayload.competitors.products = cleanPayload.competitors.products.slice(0, 8)
  }
  if (mode === 'pricing' && cleanPayload.competitorMetrics) {
    return cleanPayload
  }
  return cleanPayload
}

const extractOpenAiText = (data) => {
  if (data.output_text) return String(data.output_text).trim()
  const chunks = []
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.text) chunks.push(content.text)
      if (content.type === 'output_text' && content.text) chunks.push(content.text)
    }
  }
  return chunks.join('\n').trim()
}

const extractOpenRouterText = (data) => {
  const content = data.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((item) => item.text || item.content || '')
      .join('\n')
      .trim()
  }
  return ''
}

const localAiBrief = (mode, payload) => {
  if (mode === 'store') {
    const metrics = payload.metrics || {}
    const actions = (payload.recommendations || []).slice(0, 3)
      .map((item, index) => `${index + 1}. ${item.title}: ${item.action}`)
      .join('\n')
    return [
      'The selected AI provider is not configured, so this brief was generated locally from store metrics.',
      `Orders: ${metrics.orders ?? 'not available'}. Revenue: ${metrics.revenue ?? 'not available'}. Cancel rate: ${metrics.cancelRate ?? 'not available'}.`,
      actions || 'No recommendations are available yet.',
    ].join('\n\n')
  }

  if (mode === 'product') {
    const computed = payload.computed || {}
    const own = payload.ownProduct || {}
    const actions = (payload.recommendations || []).slice(0, 3)
      .map((item, index) => `${index + 1}. ${item.title}: ${item.action}`)
      .join('\n')
    return [
      'The selected AI provider is not configured, so this brief was generated locally from the product benchmark.',
      `${own.title || 'Product'} is at price ${computed.ownPrice ?? 'not available'} with competitor median ${computed.competitorMedianPrice ?? 'not available'}.`,
      actions || 'No product recommendations are available yet.',
    ].join('\n\n')
  }

  const rationale = (payload.rationale || []).map((item) => `- ${item}`).join('\n')
  return [
    'The selected AI provider is not configured, so this brief was generated locally from the pricing analysis.',
    `SKU ${payload.sku || 'not provided'}: current price ${payload.currentPrice ?? 'not available'}, recommended price ${payload.recommendedPrice ?? 'not available'}, delta ${payload.deltaPercent ?? 'not available'}%.`,
    rationale || 'No pricing rationale is available yet.',
  ].join('\n\n')
}

const buildAiPrompt = (mode, payload, user) => `
You are SellerDesk AI, a professional ecommerce operating analyst for Daraz sellers.
Write a concise SaaS-style brief for the authenticated seller.

Rules:
- Use only the structured data below.
- Do not invent orders, revenue, prices, ratings, stock, or competitor numbers.
- Cite exact metrics when you recommend an action.
- Keep the tone professional, direct, and practical.
- Use these sections: Executive summary, What changed, Recommended actions, Risk checks.
- Keep it under 220 words.

Seller:
${user.name} <${user.email}>

Workflow:
${mode}

Structured data:
${JSON.stringify(compactAiPayload(mode, payload), null, 2).slice(0, 14000)}
`.trim()

const callOpenAiBrief = async (aiProvider, mode, payload, user) => {
  const response = await fetch(`${aiProvider.baseUrl}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${aiProvider.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: aiProvider.model,
      input: buildAiPrompt(mode, payload, user),
      max_output_tokens: 900,
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error?.message || 'OpenAI request failed.')
  }
  const brief = extractOpenAiText(data)
  if (!brief) throw new Error('OpenAI returned an empty response.')
  return brief
}

const callOpenRouterBrief = async (aiProvider, mode, payload, user) => {
  const response = await fetch(`${aiProvider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${aiProvider.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': aiProvider.siteUrl,
      'X-OpenRouter-Title': aiProvider.appName,
    },
    body: JSON.stringify({
      model: aiProvider.model,
      messages: [{ role: 'user', content: buildAiPrompt(mode, payload, user) }],
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error?.message || 'OpenRouter request failed.')
  }
  const brief = extractOpenRouterText(data)
  if (!brief) throw new Error('OpenRouter returned an empty response.')
  return brief
}

const callAiBrief = async (userId, mode, payload, user) => {
  const aiProvider = await resolveAiProvider(userId)
  if (!aiProvider.apiKey) {
    return {
      aiAvailable: false,
      source: 'local_fallback',
      provider: aiProvider.provider,
      providerLabel: aiProvider.label,
      model: aiProvider.model,
      warning: `${aiProvider.label} API key is not configured.`,
      brief: localAiBrief(mode, payload),
    }
  }

  try {
    const brief = aiProvider.provider === 'openai'
      ? await callOpenAiBrief(aiProvider, mode, payload, user)
      : await callOpenRouterBrief(aiProvider, mode, payload, user)

    return {
      aiAvailable: true,
      source: aiProvider.provider,
      provider: aiProvider.provider,
      providerLabel: aiProvider.label,
      model: aiProvider.model,
      usingUserKey: aiProvider.usingUserKey,
      brief,
    }
  } catch (error) {
    return {
      aiAvailable: false,
      source: 'local_fallback',
      provider: aiProvider.provider,
      providerLabel: aiProvider.label,
      model: aiProvider.model,
      usingUserKey: aiProvider.usingUserKey,
      warning: error.message,
      brief: localAiBrief(mode, payload),
    }
  }
}

const generateAiBriefPayload = async (userId, user, input = {}) => {
  const mode = String(input.mode || 'store').trim().toLowerCase()
  const supportedModes = ['store', 'product', 'pricing']
  if (!supportedModes.includes(mode)) {
    throw new ApiError(400, 'Supported AI brief modes are store, product, and pricing.', 'INVALID_AI_MODE')
  }

  let payload
  if (mode === 'store') {
    payload = await analyzeStorePerformancePayload(userId, { days: Number(input.days || 7) })
  } else if (mode === 'product') {
    payload = await analyzeProductPayload(userId, {
      productId: input.productId || input.sku,
      sku: input.sku,
      title: input.title,
      currentPrice: input.currentPrice,
      query: input.query || input.title || input.sku,
      limit: Number(input.limit || 12),
      refresh: Boolean(input.refresh),
    })
  } else {
    payload = await analyzePricePayload(userId, {
      sku: input.sku,
      query: input.query || input.sku,
      currentPrice: input.currentPrice,
      cost: input.cost,
      limit: Number(input.limit || 12),
    })
  }

  const ai = await callAiBrief(userId, mode, payload, user)
  return {
    mode,
    generatedAt: new Date(),
    ...ai,
    data: payload,
  }
}

const updateGuardrailsPayload = async (userId, input = {}) => {
  const guardrails = await getGuardrails(userId)
  await guardrails.update({
    autonomyLevel: input.autonomyLevel || guardrails.autonomyLevel,
    minMarginPercent: numberFromText(input.minMarginPercent) ?? guardrails.minMarginPercent,
    maxDeltaPercent: numberFromText(input.maxDeltaPercent) ?? guardrails.maxDeltaPercent,
    maxRepricesPerSkuPerDay: numberFromText(input.maxRepricesPerSkuPerDay) ?? guardrails.maxRepricesPerSkuPerDay,
    priceFloor: input.priceFloor === '' ? null : numberFromText(input.priceFloor) ?? guardrails.priceFloor,
    priceCeiling: input.priceCeiling === '' ? null : numberFromText(input.priceCeiling) ?? guardrails.priceCeiling,
    liveWritesEnabled: Boolean(input.liveWritesEnabled),
  })
  return { guardrails: publicGuardrails(guardrails) }
}

const getRepriceHistoryPayload = async (userId, input = {}) => {
  const sku = cleanQuery(input.sku)
  if (!sku) throw new ApiError(400, 'SKU is required.', 'SKU_REQUIRED')
  const logs = await RepriceLog.findAll({
    where: { userId, sku },
    order: [['createdAt', 'DESC']],
    limit: Math.max(1, Math.min(50, Number(input.limit || 20))),
  })
  return { logs }
}

const applyRepricePayload = async (userId, input = {}, actor = 'sellerdesk_web') => {
  const sku = cleanQuery(input.sku)
  if (!sku) throw new ApiError(400, 'SKU is required.', 'SKU_REQUIRED')

  const requestId = input.requestId || crypto
    .createHash('sha256')
    .update(`${userId}:${sku}:${input.price}:${input.reason || ''}`)
    .digest('hex')
    .slice(0, 32)

  const existing = await RepriceLog.findOne({ where: { userId, sku, requestId } })
  if (existing) return { idempotent: true, log: existing }

  const guardrails = await getGuardrails(userId)
  const currentPrice = numberFromText(input.currentPrice)
  const requestedPrice = numberFromText(input.price)
  if (!Number.isFinite(requestedPrice)) throw new ApiError(400, 'Target price is required.', 'PRICE_REQUIRED')
  if (!Number.isFinite(currentPrice)) throw new ApiError(400, 'Current price is required.', 'CURRENT_PRICE_REQUIRED')

  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const runsToday = await RepriceLog.count({
    where: {
      userId,
      sku,
      createdAt: { [Op.gte]: dayStart },
      status: { [Op.in]: ['suggested', 'applied', 'clamped'] },
    },
  })

  const maxMove = currentPrice * (guardrails.maxDeltaPercent / 100)
  const floor = numberFromText(guardrails.priceFloor) || 0
  const ceiling = numberFromText(guardrails.priceCeiling) || Number.POSITIVE_INFINITY
  let finalPrice = Math.max(floor, Math.min(ceiling, currentPrice + maxMove, Math.max(currentPrice - maxMove, requestedPrice)))
  finalPrice = Math.round(finalPrice)
  const blocked = runsToday >= guardrails.maxRepricesPerSkuPerDay
  const clamped = finalPrice !== requestedPrice
  const status = blocked
    ? 'rejected'
    : guardrails.autonomyLevel === 'suggest_only'
      ? 'suggested'
      : clamped
        ? 'clamped'
        : 'approved'

  const log = await RepriceLog.create({
    userId,
    sku,
    requestId,
    oldPrice: currentPrice,
    requestedPrice,
    newPrice: blocked ? currentPrice : finalPrice,
    status,
    reason: input.reason || 'Copilot pricing workflow',
    actor,
    guardrailResult: {
      blocked,
      clamped,
      runsToday,
      maxRepricesPerSkuPerDay: guardrails.maxRepricesPerSkuPerDay,
      maxDeltaPercent: guardrails.maxDeltaPercent,
      priceFloor: floor || null,
      priceCeiling: Number.isFinite(ceiling) ? ceiling : null,
      autonomyLevel: guardrails.autonomyLevel,
      liveWritesEnabled: guardrails.liveWritesEnabled,
      liveWrite: false,
    },
  })

  const message = blocked
    ? 'Reprice rejected by daily guardrail.'
    : guardrails.autonomyLevel === 'suggest_only'
      ? 'Suggest-only mode logged the reprice without changing Daraz.'
      : clamped
        ? 'Requested price was clamped by guardrails and logged. Live Daraz writes are disabled in this phase.'
        : 'Reprice approved by guardrails and logged. Live Daraz writes are disabled in this phase.'

  return {
    applied: false,
    log,
    message,
  }
}

router.get('/manifest', authenticate, asyncHandler(async (_req, res) => {
  res.json(manifest)
}))

router.get('/store/metrics', authenticate, asyncHandler(async (req, res) => {
  res.json(await getStoreMetricsPayload(req.user.id, req.query))
}))

router.get('/store/history', authenticate, asyncHandler(async (req, res) => {
  res.json(await getMetricsHistoryPayload(req.user.id, req.query))
}))

router.get('/products', authenticate, asyncHandler(async (req, res) => {
  res.json(await listProductsPayload(req.user.id))
}))

router.post('/store/analyze', authenticate, asyncHandler(async (req, res) => {
  res.json(await analyzeStorePerformancePayload(req.user.id, req.body))
}))

router.post('/competitors/search', authenticate, asyncHandler(async (req, res) => {
  res.json(await searchCompetitorsPayload(req.user.id, req.body))
}))

router.post('/products/analyze', authenticate, asyncHandler(async (req, res) => {
  res.json(await analyzeProductPayload(req.user.id, req.body))
}))

router.post('/anomalies', authenticate, asyncHandler(async (req, res) => {
  res.json(await flagAnomaliesPayload(req.user.id, req.body))
}))

router.get('/pricing/guardrails', authenticate, asyncHandler(async (req, res) => {
  res.json(await getGuardrailsPayload(req.user.id))
}))

router.put('/pricing/guardrails', authenticate, asyncHandler(async (req, res) => {
  res.json(await updateGuardrailsPayload(req.user.id, req.body))
}))

router.post('/pricing/analyze', authenticate, asyncHandler(async (req, res) => {
  res.json(await analyzePricePayload(req.user.id, req.body))
}))

router.get('/pricing/history/:sku', authenticate, asyncHandler(async (req, res) => {
  res.json(await getRepriceHistoryPayload(req.user.id, { sku: req.params.sku }))
}))

router.post('/pricing/reprice', authenticate, asyncHandler(async (req, res) => {
  res.json(await applyRepricePayload(req.user.id, req.body))
}))

router.post('/ai/brief', authenticate, asyncHandler(async (req, res) => {
  res.json(await generateAiBriefPayload(req.user.id, req.user, req.body))
}))

module.exports = router
module.exports.services = {
  manifest,
  getStoreMetricsPayload,
  getMetricsHistoryPayload,
  analyzeStorePerformancePayload,
  listProductsPayload,
  getOwnProductPayload,
  searchCompetitorsPayload,
  analyzeProductPayload,
  flagAnomaliesPayload,
  analyzePricePayload,
  applyRepricePayload,
  getRepriceHistoryPayload,
  getGuardrailsPayload,
  updateGuardrailsPayload,
  generateAiBriefPayload,
}
