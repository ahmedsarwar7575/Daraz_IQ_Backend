const express = require('express')
const { McpServer, ResourceTemplate } = require('@modelcontextprotocol/server')
const { NodeStreamableHTTPServerTransport } = require('@modelcontextprotocol/node')
const z = require('zod/v4')
const env = require('../config')
const { authenticateMcp } = require('../middleware')
const { asyncHandler } = require('../utils')
const { services } = require('./copilot')

const router = express.Router()

const optionalText = z.string().trim().min(1).optional()
const numberLike = z.union([z.number(), z.string()])
const optionalNumberLike = numberLike.optional()

const dateRangeSchema = {
  days: z.number().int().min(1).max(90).optional(),
  from: optionalText,
  to: optionalText,
}

const toJsonValue = (payload) => {
  if (payload === undefined) return null
  return JSON.parse(JSON.stringify(payload))
}

const jsonToolResult = (payload) => {
  const cleanPayload = toJsonValue(payload)
  return {
    content: [{ type: 'text', text: JSON.stringify(cleanPayload, null, 2) }],
    structuredContent: cleanPayload,
  }
}

const jsonResourceResult = (uri, payload) => {
  const cleanPayload = toJsonValue(payload)
  return {
    contents: [{
      uri: uri.href,
      mimeType: 'application/json',
      text: JSON.stringify(cleanPayload, null, 2),
    }],
  }
}

const firstVariable = (value) => Array.isArray(value) ? value[0] : value

const promptText = (text) => ({
  messages: [{
    role: 'user',
    content: { type: 'text', text },
  }],
})

const getBearerToken = (req) => {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)
  return match ? match[1] : ''
}

const requestOrigin = (req) => {
  const headers = req?.headers || {}
  const forwardedHost = String(headers['x-forwarded-host'] || '').split(',')[0].trim()
  const host = forwardedHost || headers.host
  if (!host) return ''
  const forwardedProto = String(headers['x-forwarded-proto'] || '').split(',')[0].trim()
  return `${forwardedProto || req?.protocol || 'https'}://${host}`.replace(/\/+$/, '')
}

const createAuthInfo = (req) => ({
  token: getBearerToken(req),
  clientId: req.user.id,
  scopes: env.mcp.scopes,
  expiresAt: req.authPayload?.exp,
  extra: {
    userId: req.user.id,
    email: req.user.email,
  },
})

const registerTools = (server, user, req) => {
  const userId = user.id
  const withRequestOrigin = (input = {}) => ({ ...input, __requestOrigin: requestOrigin(req) })

  server.registerTool(
    'get_store_metrics',
    {
      title: 'Get Store Metrics',
      description: 'Fetch the seller store KPI snapshot for a date range and persist it for trend analysis.',
      inputSchema: z.object(dateRangeSchema),
    },
    async (input) => jsonToolResult(await services.getStoreMetricsPayload(userId, withRequestOrigin(input))),
  )

  server.registerTool(
    'get_metrics_history',
    {
      title: 'Get Metrics History',
      description: 'Return prior saved store KPI snapshots for trend comparison.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(30).optional(),
      }),
    },
    async (input) => jsonToolResult(await services.getMetricsHistoryPayload(userId, input)),
  )

  server.registerTool(
    'analyze_store_performance',
    {
      title: 'Analyze Store Performance',
      description: 'Compute metric-backed store findings, deltas, anomalies, and prioritized next actions.',
      inputSchema: z.object(dateRangeSchema),
    },
    async (input) => jsonToolResult(await services.analyzeStorePerformancePayload(userId, withRequestOrigin(input))),
  )

  server.registerTool(
    'get_own_product',
    {
      title: 'Get Own Product',
      description: 'Fetch one seller listing from Daraz when connected, or normalize supplied manual product inputs.',
      inputSchema: z.object({
        productId: optionalText,
        sku: optionalText,
        title: optionalText,
        currentPrice: optionalNumberLike,
      }),
    },
    async (input) => jsonToolResult(await services.getOwnProductPayload(userId, input)),
  )

  server.registerTool(
    'search_competitors',
    {
      title: 'Search Competitors',
      description: 'Return cached or freshly scraped competitor listings and market price metrics for a query.',
      inputSchema: z.object({
        query: z.string().trim().min(1),
        limit: z.number().int().min(1).max(50).optional(),
        refresh: z.boolean().optional(),
      }),
    },
    async (input) => jsonToolResult(await services.searchCompetitorsPayload(userId, input)),
  )

  server.registerTool(
    'analyze_product',
    {
      title: 'Analyze Product',
      description: 'Compare a seller product against competitors and return metric-cited listing recommendations.',
      inputSchema: z.object({
        productId: optionalText,
        sku: optionalText,
        title: optionalText,
        currentPrice: optionalNumberLike,
        query: optionalText,
        limit: z.number().int().min(1).max(50).optional(),
        refresh: z.boolean().optional(),
      }),
    },
    async (input) => jsonToolResult(await services.analyzeProductPayload(userId, input)),
  )

  server.registerTool(
    'flag_anomalies',
    {
      title: 'Flag Anomalies',
      description: 'Compare latest saved snapshots against a rolling baseline and flag metric anomalies.',
      inputSchema: z.object({
        scope: z.enum(['store', 'product']).default('store'),
      }),
    },
    async (input) => jsonToolResult(await services.flagAnomaliesPayload(userId, input)),
  )

  server.registerTool(
    'analyze_price',
    {
      title: 'Analyze Price',
      description: 'Compute competitor price position and a guardrail-bounded recommended price.',
      inputSchema: z.object({
        sku: optionalText,
        query: optionalText,
        currentPrice: numberLike,
        cost: optionalNumberLike,
        limit: z.number().int().min(1).max(50).optional(),
      }),
    },
    async (input) => jsonToolResult(await services.analyzePricePayload(userId, input)),
  )

  server.registerTool(
    'apply_reprice',
    {
      title: 'Apply Reprice',
      description: 'Validate a requested SKU price against server-side guardrails and log the decision idempotently.',
      inputSchema: z.object({
        sku: z.string().trim().min(1),
        currentPrice: numberLike,
        price: numberLike,
        reason: optionalText,
        requestId: optionalText,
      }),
    },
    async (input) => jsonToolResult(await services.applyRepricePayload(userId, input, 'sellerdesk_mcp')),
  )

  server.registerTool(
    'get_reprice_history',
    {
      title: 'Get Reprice History',
      description: 'Return the audit trail for price recommendations and guarded reprice attempts on a SKU.',
      inputSchema: z.object({
        sku: z.string().trim().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    },
    async (input) => jsonToolResult(await services.getRepriceHistoryPayload(userId, input)),
  )
}

const registerResources = (server, user) => {
  const userId = user.id

  server.registerResource(
    'store_metrics_latest',
    'store://metrics/latest',
    {
      title: 'Latest Store Metrics',
      description: 'Most recent persisted store KPI snapshot for the authenticated seller.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const history = await services.getMetricsHistoryPayload(userId, { limit: 1 })
      return jsonResourceResult(uri, { snapshot: history.snapshots[0] || null })
    },
  )

  server.registerResource(
    'store_metrics_history',
    'store://metrics/history',
    {
      title: 'Store Metrics History',
      description: 'Recent persisted store KPI snapshots for the authenticated seller.',
      mimeType: 'application/json',
    },
    async (uri) => jsonResourceResult(uri, await services.getMetricsHistoryPayload(userId, { limit: 12 })),
  )

  server.registerResource(
    'product_own',
    new ResourceTemplate('product://{id}/own', { list: undefined }),
    {
      title: 'Own Product',
      description: 'Seller listing details for a Daraz product id or seller SKU.',
      mimeType: 'application/json',
    },
    async (uri, variables) => jsonResourceResult(
      uri,
      await services.getOwnProductPayload(userId, { productId: firstVariable(variables.id) }),
    ),
  )

  server.registerResource(
    'product_competitors',
    new ResourceTemplate('product://{id}/competitors', { list: undefined }),
    {
      title: 'Product Competitors',
      description: 'Competitor listings for the supplied product id, SKU, or query text.',
      mimeType: 'application/json',
    },
    async (uri, variables) => jsonResourceResult(
      uri,
      await services.searchCompetitorsPayload(userId, { query: firstVariable(variables.id), limit: 12 }),
    ),
  )

  server.registerResource(
    'pricing_competitor_snapshot',
    new ResourceTemplate('pricing://{sku}/competitor-snapshot', { list: undefined }),
    {
      title: 'Pricing Competitor Snapshot',
      description: 'Cached competitor price snapshot for a SKU or product search term.',
      mimeType: 'application/json',
    },
    async (uri, variables) => jsonResourceResult(
      uri,
      await services.searchCompetitorsPayload(userId, { query: firstVariable(variables.sku), limit: 12 }),
    ),
  )

  server.registerResource(
    'pricing_history',
    new ResourceTemplate('pricing://{sku}/history', { list: undefined }),
    {
      title: 'Pricing History',
      description: 'Reprice audit log for a SKU.',
      mimeType: 'application/json',
    },
    async (uri, variables) => jsonResourceResult(
      uri,
      await services.getRepriceHistoryPayload(userId, { sku: firstVariable(variables.sku), limit: 20 }),
    ),
  )

  server.registerResource(
    'pricing_guardrails',
    new ResourceTemplate('pricing://{sku}/guardrails', { list: undefined }),
    {
      title: 'Pricing Guardrails',
      description: 'Seller guardrail settings applied before any reprice decision for a SKU.',
      mimeType: 'application/json',
    },
    async (uri, variables) => jsonResourceResult(
      uri,
      { sku: firstVariable(variables.sku), ...(await services.getGuardrailsPayload(userId)) },
    ),
  )
}

const registerPrompts = (server) => {
  server.registerPrompt(
    'weekly_store_review',
    {
      title: 'Weekly Store Review',
      description: 'Guide an MCP client through a metric-backed weekly seller performance review.',
      argsSchema: z.object({
        days: optionalText,
      }),
    },
    ({ days }) => promptText(
      `Review my Daraz store for the last ${days || '7'} days. Call get_store_metrics, then get_metrics_history, then analyze_store_performance. Summarize the result as prioritized actions and cite the exact metrics that support each action.`,
    ),
  )

  server.registerPrompt(
    'product_health_check',
    {
      title: 'Product Health Check',
      description: 'Guide an MCP client through a product benchmark against Daraz competitors.',
      argsSchema: z.object({
        query: z.string().trim().min(1),
        productId: optionalText,
        sku: optionalText,
        currentPrice: optionalText,
      }),
    },
    ({ query, productId, sku, currentPrice }) => promptText(
      `Benchmark my Daraz product. Use get_own_product with productId "${productId || ''}", sku "${sku || ''}", and currentPrice "${currentPrice || ''}". Then call search_competitors for "${query}" and analyze_product. Return listing fixes ranked by revenue impact, and cite price percentile, image count, review/rating gap, or title-length metrics wherever available.`,
    ),
  )

  server.registerPrompt(
    'reprice_workflow',
    {
      title: 'Reprice Workflow',
      description: 'Guide an MCP client through safe price analysis and guarded repricing.',
      argsSchema: z.object({
        sku: z.string().trim().min(1),
        query: optionalText,
        currentPrice: z.string().trim().min(1),
        cost: optionalText,
      }),
    },
    ({ sku, query, currentPrice, cost }) => promptText(
      `Analyze SKU "${sku}" for repricing. First call analyze_price with currentPrice "${currentPrice}", query "${query || sku}", and cost "${cost || ''}". Explain the recommendation and guardrails. Only call apply_reprice after explicit seller confirmation, and include a clear reason plus a stable requestId.`,
    ),
  )
}

const createSellerMcpServer = (user, req) => {
  const server = new McpServer({
    name: 'sellerdesk-daraz-copilot',
    version: '1.0.0',
  })

  registerTools(server, user, req)
  registerResources(server, user)
  registerPrompts(server)

  return server
}

router.all('/', authenticateMcp, asyncHandler(async (req, res) => {
  req.auth = createAuthInfo(req)

  const server = createSellerMcpServer(req.user, req)
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  transport.onclose = () => {
    server.close().catch(() => {})
  }

  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
}))

module.exports = router
module.exports.createSellerMcpServer = createSellerMcpServer
