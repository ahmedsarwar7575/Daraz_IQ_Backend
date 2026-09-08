const { Op } = require('sequelize')
const {
  AiProviderSetting,
  CompetitorSnapshot,
  DarazConnection,
  GuardrailConfig,
  ProductSnapshot,
  RepriceLog,
  StoreSnapshot,
  User,
  sequelize,
} = require('../src/models')
const { normalizeEmail } = require('../src/utils')

const DATASET = 'daraziq_seller_showcase_v1'

const productImages = {
  earbuds: 'https://images.unsplash.com/photo-1606220945770-b5b6c2c55bf1?auto=format&fit=crop&w=420&q=80',
  watch: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=420&q=80',
  headset: 'https://images.unsplash.com/photo-1583394838336-acd977736f90?auto=format&fit=crop&w=420&q=80',
  shoes: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=420&q=80',
  backpack: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=420&q=80',
  camera: 'https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?auto=format&fit=crop&w=420&q=80',
  skincare: 'https://images.unsplash.com/photo-1596462502278-27bfdc403348?auto=format&fit=crop&w=420&q=80',
  laptop: 'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?auto=format&fit=crop&w=420&q=80',
}

const products = [
  {
    itemId: 'DRZ-1847201',
    sku: 'AUR-EB-X7-BLK',
    title: 'AuroraSound X7 Wireless Earbuds with ANC and 42H Case',
    query: 'wireless earbuds',
    price: 5290,
    cost: 3475,
    stock: 184,
    rating: 4.7,
    reviewCount: 1284,
    imageCount: 7,
    imageUrl: productImages.earbuds,
  },
  {
    itemId: 'DRZ-1847202',
    sku: 'NOVA-FIT-S2-GRY',
    title: 'NovaFit S2 Bluetooth Calling Smart Watch',
    query: 'smartwatch',
    price: 6990,
    cost: 4550,
    stock: 96,
    rating: 4.6,
    reviewCount: 842,
    imageCount: 8,
    imageUrl: productImages.watch,
  },
  {
    itemId: 'DRZ-1847203',
    sku: 'SONIC-HS-G9',
    title: 'SonicWave G9 Gaming Headset with Noise Cancel Mic',
    query: 'gaming headset',
    price: 4190,
    cost: 2680,
    stock: 142,
    rating: 4.5,
    reviewCount: 613,
    imageCount: 6,
    imageUrl: productImages.headset,
  },
  {
    itemId: 'DRZ-1847204',
    sku: 'STRIDE-RN-41',
    title: 'StrideFlex Lightweight Running Shoes for Men',
    query: 'running shoes',
    price: 3590,
    cost: 2210,
    stock: 211,
    rating: 4.4,
    reviewCount: 932,
    imageCount: 9,
    imageUrl: productImages.shoes,
  },
  {
    itemId: 'DRZ-1847205',
    sku: 'URBAN-BP-18L',
    title: 'UrbanCarry 18L Water Resistant Laptop Backpack',
    query: 'laptop backpack',
    price: 2990,
    cost: 1815,
    stock: 258,
    rating: 4.6,
    reviewCount: 1087,
    imageCount: 7,
    imageUrl: productImages.backpack,
  },
  {
    itemId: 'DRZ-1847206',
    sku: 'PIXEL-MINI-CAM',
    title: 'PixelMini 1080p Vlogging Camera Kit',
    query: 'vlogging camera',
    price: 12990,
    cost: 9050,
    stock: 47,
    rating: 4.3,
    reviewCount: 274,
    imageCount: 8,
    imageUrl: productImages.camera,
  },
  {
    itemId: 'DRZ-1847207',
    sku: 'GLOW-SERUM-C',
    title: 'GlowNest Vitamin C Serum 30ml',
    query: 'vitamin c serum',
    price: 1690,
    cost: 930,
    stock: 319,
    rating: 4.8,
    reviewCount: 1516,
    imageCount: 6,
    imageUrl: productImages.skincare,
  },
  {
    itemId: 'DRZ-1847208',
    sku: 'PRODOCK-USBC-7',
    title: 'ProDock 7-in-1 USB-C Hub for Laptop',
    query: 'usb c hub',
    price: 4490,
    cost: 2860,
    stock: 118,
    rating: 4.5,
    reviewCount: 689,
    imageCount: 6,
    imageUrl: productImages.laptop,
  },
]

const dateKey = (date) => date.toISOString().slice(0, 10)

const dailyOrderSeries = (now) => {
  const values = [18, 22, 19, 24, 21, 28, 33, 25, 29, 31, 27, 36, 34, 38, 41, 37, 44, 39, 42, 47, 43, 50, 46, 54, 58, 53, 61, 57, 65, 68]
  const start = new Date(now)
  start.setDate(start.getDate() - (values.length - 1))
  start.setHours(0, 0, 0, 0)
  return values.map((orders, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return { date: dateKey(date), orders }
  })
}

const buildTopProducts = () => [
  { title: products[0].title, sku: products[0].sku, orders: 286, units: 329, revenue: 1740410 },
  { title: products[6].title, sku: products[6].sku, orders: 238, units: 281, revenue: 474890 },
  { title: products[4].title, sku: products[4].sku, orders: 194, units: 211, revenue: 630890 },
  { title: products[1].title, sku: products[1].sku, orders: 151, units: 169, revenue: 1181310 },
  { title: products[3].title, sku: products[3].sku, orders: 137, units: 152, revenue: 545680 },
]

const marketplaceUrl = (query) => {
  const url = new URL('https://www.daraz.pk/catalog/')
  url.searchParams.set('q', query)
  return url.toString()
}

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

const percentile = (values, percent) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((percent / 100) * (sorted.length - 1))))
  return sorted[index]
}

const competitorProducts = (query, basePrice, imageUrl) => {
  const modifiers = [0.72, 0.81, 0.88, 0.94, 0.98, 1.03, 1.08, 1.14, 1.2, 1.29, 1.38, 1.52]
  const locations = ['Karachi', 'Lahore', 'Islamabad', 'Faisalabad', 'Rawalpindi']
  return modifiers.map((modifier, index) => {
    const price = Math.round((basePrice * modifier) / 10) * 10
    return {
      rank: index + 1,
      page: 1,
      positionOnPage: index + 1,
      itemId: `MKT-${query.replace(/\W+/g, '-').toUpperCase()}-${String(index + 1).padStart(2, '0')}`,
      sku: null,
      title: `${['Prime', 'Metro', 'Value', 'Elite', 'Swift'][index % 5]} ${query} ${index + 1}`,
      productUrl: marketplaceUrl(query),
      imageUrl,
      price,
      priceText: `Rs. ${price.toLocaleString('en-PK')}`,
      currency: 'PKR',
      discountPercent: [8, 12, 15, 19, 22, 25][index % 6],
      soldCount: Math.round(90 + (index + 1) * 37 + (12 - index) * 11),
      reviewCount: Math.round(45 + (index + 1) * 29),
      rating: Math.round((4.1 + ((index % 5) * 0.14)) * 10) / 10,
      location: locations[index % locations.length],
      imageCount: 5 + (index % 4),
    }
  })
}

const competitorMetrics = (items) => {
  const prices = items.map((item) => item.price).filter(Number.isFinite)
  const soldCounts = items.map((item) => item.soldCount).filter(Number.isFinite)
  const reviewCounts = items.map((item) => item.reviewCount).filter(Number.isFinite)
  return {
    count: items.length,
    pricedCount: prices.length,
    minPrice: prices.length ? Math.min(...prices) : null,
    p25Price: percentile(prices, 25),
    medianPrice: median(prices),
    p75Price: percentile(prices, 75),
    maxPrice: prices.length ? Math.max(...prices) : null,
    medianSold: median(soldCounts),
    medianReviews: median(reviewCounts),
  }
}

const snapshotMetrics = (now, offset = 0) => {
  const dailyOrders = dailyOrderSeries(now).map((item) => ({
    ...item,
    orders: Math.max(4, item.orders - offset * 5),
  }))
  const orders = dailyOrders.reduce((sum, item) => sum + item.orders, 0)
  const revenue = Math.round((5254000 - offset * 238000) / 1000) * 1000
  const monthStart = new Date(now)
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  const ordersThisMonth = dailyOrders
    .filter((item) => new Date(item.date) >= monthStart)
    .reduce((sum, item) => sum + item.orders, 0)

  return {
    orders,
    ordersLast30Days: orders,
    ordersThisMonth,
    ordersThisYear: 8430 - offset * 212,
    ordersTotal: 18472 - offset * 341,
    revenue,
    cancelRate: Math.round((1.2 + offset * 0.15) * 10) / 10,
    returnRate: Math.round((2.4 + offset * 0.12) * 10) / 10,
    sellerRating: Math.round((96.8 - offset * 0.2) * 10) / 10,
    shipOnTimeRate: Math.round((94.6 - offset * 0.18) * 10) / 10,
    products: products.length,
    activeProducts: products.length,
    draftProducts: 3,
    charts: {
      dailyOrders,
      statusBreakdown: [
        { status: 'delivered', count: Math.round(orders * 0.76) },
        { status: 'shipped', count: Math.round(orders * 0.13) },
        { status: 'pending', count: Math.round(orders * 0.075) },
        { status: 'returned', count: Math.round(orders * 0.024) },
        { status: 'cancelled', count: Math.max(1, Math.round(orders * 0.011)) },
      ],
      topProducts: buildTopProducts(),
    },
  }
}

const seed = async (email) => {
  if (!email) throw new Error('Provide the showcase account email as the first argument or SHOWCASE_ACCOUNT_EMAIL.')
  const normalizedEmail = normalizeEmail(email)
  const user = await User.findOne({ where: { email: normalizedEmail } })
  if (!user) throw new Error(`Account was not found: ${normalizedEmail}`)

  const now = new Date()
  const result = await sequelize.transaction(async (transaction) => {
    const [connection] = await DarazConnection.findOrCreate({
      where: { userId: user.id },
      defaults: { userId: user.id },
      transaction,
    })
    await connection.update({
      sellerId: 'PK-DIQ-784219',
      sellerName: 'Urban Cart Studio',
      accountPlatform: 'daraz_pk',
      country: 'Pakistan',
      metadata: {
        ...(connection.metadata || {}),
        showcaseDemo: true,
        showcaseDataset: DATASET,
        sellerSegment: 'Growth electronics and lifestyle catalog',
        generatedAt: now.toISOString(),
      },
      encryptedAccessToken: null,
      encryptedRefreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      connectedAt: new Date(now.getTime() - 92 * 24 * 60 * 60 * 1000),
      lastSyncedAt: now,
      disconnectedAt: null,
    }, { transaction })

    await ProductSnapshot.destroy({ where: { userId: user.id, source: 'showcase_snapshot' }, transaction })
    await ProductSnapshot.bulkCreate(products.map((product) => ({
      ...product,
      userId: user.id,
      status: 'active',
      source: 'showcase_snapshot',
      metadata: {
        showcaseDataset: DATASET,
        market: 'PK',
      },
      capturedAt: now,
    })), { transaction })

    await CompetitorSnapshot.destroy({ where: { userId: user.id, source: 'showcase_market' }, transaction })
    const competitorRows = products.slice(0, 6).map((product, index) => {
      const items = competitorProducts(product.query, product.price, product.imageUrl)
      const scrapedAt = new Date(now.getTime() - (index + 1) * 38 * 60 * 1000)
      return {
        userId: user.id,
        query: product.query.toLowerCase(),
        sourceUrl: marketplaceUrl(product.query),
        source: 'showcase_market',
        scrapedAt,
        expiresAt: new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000),
        metrics: competitorMetrics(items),
        products: items,
      }
    })
    await CompetitorSnapshot.bulkCreate(competitorRows, { transaction })

    await StoreSnapshot.destroy({
      where: {
        userId: user.id,
        sourceSummary: { [Op.contains]: { showcaseDataset: DATASET } },
      },
      transaction,
    })
    const storeRows = Array.from({ length: 8 }, (_, index) => {
      const capturedAt = new Date(now.getTime() - index * 7 * 24 * 60 * 60 * 1000)
      const rangeEnd = new Date(capturedAt)
      const rangeStart = new Date(capturedAt)
      rangeStart.setDate(rangeStart.getDate() - 29)
      return {
        userId: user.id,
        rangeStart,
        rangeEnd,
        metrics: snapshotMetrics(capturedAt, index),
        sourceSummary: {
          synced: 3,
          total: 3,
          failed: [],
          sourceLabels: ['Seller profile', 'Orders history', 'Product catalog'],
          showcaseDataset: DATASET,
        },
        capturedAt,
      }
    })
    await StoreSnapshot.bulkCreate(storeRows, { transaction })

    const [guardrails] = await GuardrailConfig.findOrCreate({
      where: { userId: user.id },
      defaults: { userId: user.id },
      transaction,
    })
    await guardrails.update({
      autonomyLevel: 'approval_required',
      minMarginPercent: 12,
      maxDeltaPercent: 8,
      maxRepricesPerSkuPerDay: 2,
      priceFloor: 1490,
      priceCeiling: 24990,
      liveWritesEnabled: false,
    }, { transaction })

    await RepriceLog.destroy({ where: { userId: user.id, actor: 'sellerdesk_showcase' }, transaction })
    await RepriceLog.bulkCreate([
      {
        sku: products[0].sku,
        requestId: 'aur-eb-x7-week-36',
        oldPrice: 5490,
        requestedPrice: 5290,
        newPrice: 5290,
        status: 'approved',
        reason: 'Moved closer to competitor median while keeping 12% margin guardrail.',
      },
      {
        sku: products[1].sku,
        requestId: 'nova-fit-s2-week-36',
        oldPrice: 7290,
        requestedPrice: 6890,
        newPrice: 6990,
        status: 'clamped',
        reason: 'Guardrail limited the move because the requested cut exceeded max delta.',
      },
      {
        sku: products[4].sku,
        requestId: 'urban-bp-18l-week-35',
        oldPrice: 2890,
        requestedPrice: 3090,
        newPrice: 2990,
        status: 'suggested',
        reason: 'Backpack demand remained strong while stock coverage stayed healthy.',
      },
      {
        sku: products[6].sku,
        requestId: 'glow-serum-c-week-35',
        oldPrice: 1590,
        requestedPrice: 1690,
        newPrice: 1690,
        status: 'approved',
        reason: 'High conversion and review advantage supported a controlled price lift.',
      },
      {
        sku: products[3].sku,
        requestId: 'stride-rn-41-week-34',
        oldPrice: 3790,
        requestedPrice: 3290,
        newPrice: 3590,
        status: 'clamped',
        reason: 'Requested markdown was outside the configured daily movement limit.',
      },
      {
        sku: products[5].sku,
        requestId: 'pixel-mini-cam-week-34',
        oldPrice: 12990,
        requestedPrice: 11990,
        newPrice: 12990,
        status: 'rejected',
        reason: 'Daily reprice limit was already reached for this SKU.',
      },
    ].map((log, index) => ({
      ...log,
      userId: user.id,
      actor: 'sellerdesk_showcase',
      guardrailResult: {
        blocked: log.status === 'rejected',
        clamped: log.status === 'clamped',
        runsToday: index % 3,
        maxRepricesPerSkuPerDay: 2,
        maxDeltaPercent: 8,
        priceFloor: 1490,
        priceCeiling: 24990,
        autonomyLevel: 'approval_required',
        liveWritesEnabled: false,
        liveWrite: false,
        showcaseDataset: DATASET,
      },
      createdAt: new Date(now.getTime() - (index + 1) * 30 * 60 * 60 * 1000),
      updatedAt: new Date(now.getTime() - (index + 1) * 30 * 60 * 60 * 1000),
    })), { transaction })

    const [aiSettings] = await AiProviderSetting.findOrCreate({
      where: { userId: user.id },
      defaults: { userId: user.id },
      transaction,
    })
    await aiSettings.update({
      activeProvider: 'openrouter',
      encryptedOpenaiApiKey: null,
      encryptedOpenrouterApiKey: null,
    }, { transaction })

    return {
      userId: user.id,
      products: products.length,
      competitorSnapshots: competitorRows.length,
      storeSnapshots: storeRows.length,
      repriceLogs: 6,
    }
  })

  return result
}

if (require.main === module) {
  seed(process.argv[2] || process.env.SHOWCASE_ACCOUNT_EMAIL)
    .then((result) => {
      console.log(JSON.stringify({ ok: true, dataset: DATASET, ...result }, null, 2))
    })
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, message: error.message }, null, 2))
      process.exitCode = 1
    })
    .finally(() => sequelize.close().catch(() => {}))
}

module.exports = { seed }
