const { DataTypes, Sequelize } = require('sequelize')
const env = require('./config')

const commonOptions = {
  dialect: 'postgres',
  logging: false,
  dialectOptions: env.database.ssl
    ? { ssl: { require: true, rejectUnauthorized: false } }
    : undefined,
}

const normalizedDatabaseUrl = (url) => {
  if (!url) return url
  try {
    const parsed = new URL(url)
    if (parsed.searchParams.get('sslmode') === 'require') {
      parsed.searchParams.set('sslmode', 'verify-full')
    }
    return parsed.toString()
  } catch {
    return url
  }
}

const sequelize = env.database.url
  ? new Sequelize(normalizedDatabaseUrl(env.database.url), commonOptions)
  : new Sequelize(env.database.name, env.database.user, env.database.password, {
      ...commonOptions,
      host: env.database.host,
      port: env.database.port,
    })

const User = sequelize.define('User', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  email: {
    type: DataTypes.STRING(190),
    allowNull: false,
    unique: true,
    set(value) {
      this.setDataValue('email', String(value).trim().toLowerCase())
    },
  },
  passwordHash: DataTypes.STRING,
  emailVerified: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  authProvider: {
    type: DataTypes.STRING(20),
    defaultValue: 'email',
  },
  googleSub: {
    type: DataTypes.STRING,
    unique: true,
  },
  avatarUrl: DataTypes.TEXT,
  lastLoginAt: DataTypes.DATE,
})

const OtpCode = sequelize.define('OtpCode', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  email: {
    type: DataTypes.STRING(190),
    allowNull: false,
  },
  codeHash: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  purpose: {
    type: DataTypes.STRING(30),
    allowNull: false,
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  consumedAt: DataTypes.DATE,
  attempts: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
})

const OAuthClient = sequelize.define('OAuthClient', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  clientId: {
    type: DataTypes.STRING(260),
    allowNull: false,
    unique: true,
  },
  clientSecretHash: DataTypes.TEXT,
  clientName: {
    type: DataTypes.STRING(160),
    allowNull: false,
  },
  redirectUris: {
    type: DataTypes.JSONB,
    defaultValue: [],
  },
  grantTypes: {
    type: DataTypes.JSONB,
    defaultValue: ['authorization_code'],
  },
  responseTypes: {
    type: DataTypes.JSONB,
    defaultValue: ['code'],
  },
  tokenEndpointAuthMethod: {
    type: DataTypes.STRING(40),
    defaultValue: 'none',
  },
  scope: DataTypes.TEXT,
  metadata: {
    type: DataTypes.JSONB,
    defaultValue: {},
  },
  clientIdIssuedAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
})

const OAuthAuthorizationCode = sequelize.define('OAuthAuthorizationCode', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  codeHash: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true,
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  clientId: {
    type: DataTypes.STRING(260),
    allowNull: false,
  },
  redirectUri: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  scope: DataTypes.TEXT,
  resource: DataTypes.TEXT,
  codeChallenge: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  codeChallengeMethod: {
    type: DataTypes.STRING(20),
    defaultValue: 'S256',
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  consumedAt: DataTypes.DATE,
})

const OAuthRefreshToken = sequelize.define('OAuthRefreshToken', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tokenHash: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true,
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  clientId: {
    type: DataTypes.STRING(260),
    allowNull: false,
  },
  scope: DataTypes.TEXT,
  resource: DataTypes.TEXT,
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  lastUsedAt: DataTypes.DATE,
  revokedAt: DataTypes.DATE,
})

const DarazConnection = sequelize.define('DarazConnection', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
    unique: true,
  },
  sellerId: DataTypes.STRING,
  sellerName: DataTypes.STRING,
  accountPlatform: DataTypes.STRING,
  country: DataTypes.STRING,
  metadata: {
    type: DataTypes.JSONB,
    defaultValue: {},
  },
  encryptedAccessToken: DataTypes.TEXT,
  encryptedRefreshToken: DataTypes.TEXT,
  accessTokenExpiresAt: DataTypes.DATE,
  refreshTokenExpiresAt: DataTypes.DATE,
  connectedAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  lastSyncedAt: DataTypes.DATE,
  disconnectedAt: DataTypes.DATE,
})

const StoreSnapshot = sequelize.define('StoreSnapshot', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  rangeStart: DataTypes.DATE,
  rangeEnd: DataTypes.DATE,
  metrics: {
    type: DataTypes.JSONB,
    defaultValue: {},
  },
  sourceSummary: {
    type: DataTypes.JSONB,
    defaultValue: {},
  },
  capturedAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
})

const CompetitorSnapshot = sequelize.define('CompetitorSnapshot', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  query: {
    type: DataTypes.STRING(220),
    allowNull: false,
  },
  sourceUrl: DataTypes.TEXT,
  source: DataTypes.STRING(40),
  scrapedAt: DataTypes.DATE,
  expiresAt: DataTypes.DATE,
  metrics: {
    type: DataTypes.JSONB,
    defaultValue: {},
  },
  products: {
    type: DataTypes.JSONB,
    defaultValue: [],
  },
})

const ProductSnapshot = sequelize.define('ProductSnapshot', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  itemId: DataTypes.STRING(120),
  sku: {
    type: DataTypes.STRING(190),
    allowNull: false,
  },
  title: {
    type: DataTypes.STRING(260),
    allowNull: false,
  },
  query: DataTypes.STRING(220),
  price: DataTypes.FLOAT,
  cost: DataTypes.FLOAT,
  stock: DataTypes.INTEGER,
  rating: DataTypes.FLOAT,
  reviewCount: DataTypes.INTEGER,
  imageCount: DataTypes.INTEGER,
  imageUrl: DataTypes.TEXT,
  status: {
    type: DataTypes.STRING(40),
    defaultValue: 'active',
  },
  source: {
    type: DataTypes.STRING(40),
    defaultValue: 'sellerdesk_snapshot',
  },
  metadata: {
    type: DataTypes.JSONB,
    defaultValue: {},
  },
  capturedAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
})

const GuardrailConfig = sequelize.define('GuardrailConfig', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
    unique: true,
  },
  autonomyLevel: {
    type: DataTypes.STRING(30),
    defaultValue: 'suggest_only',
  },
  minMarginPercent: {
    type: DataTypes.FLOAT,
    defaultValue: 5,
  },
  maxDeltaPercent: {
    type: DataTypes.FLOAT,
    defaultValue: 15,
  },
  maxRepricesPerSkuPerDay: {
    type: DataTypes.INTEGER,
    defaultValue: 3,
  },
  priceFloor: DataTypes.FLOAT,
  priceCeiling: DataTypes.FLOAT,
  liveWritesEnabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
})

const RepriceLog = sequelize.define('RepriceLog', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  sku: {
    type: DataTypes.STRING(190),
    allowNull: false,
  },
  requestId: {
    type: DataTypes.STRING(120),
    allowNull: false,
  },
  oldPrice: DataTypes.FLOAT,
  requestedPrice: DataTypes.FLOAT,
  newPrice: DataTypes.FLOAT,
  status: DataTypes.STRING(30),
  reason: DataTypes.TEXT,
  actor: DataTypes.STRING(40),
  guardrailResult: {
    type: DataTypes.JSONB,
    defaultValue: {},
  },
})

const AiProviderSetting = sequelize.define('AiProviderSetting', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
    unique: true,
  },
  activeProvider: {
    type: DataTypes.STRING(30),
    defaultValue: env.ai.defaultProvider,
  },
  openaiModel: {
    type: DataTypes.STRING(120),
    defaultValue: env.openai.model,
  },
  openrouterModel: {
    type: DataTypes.STRING(160),
    defaultValue: env.openrouter.model,
  },
  encryptedOpenaiApiKey: DataTypes.TEXT,
  encryptedOpenrouterApiKey: DataTypes.TEXT,
})

User.hasOne(DarazConnection, { foreignKey: 'userId', onDelete: 'CASCADE' })
DarazConnection.belongsTo(User, { foreignKey: 'userId' })
User.hasMany(OAuthAuthorizationCode, { foreignKey: 'userId', onDelete: 'CASCADE' })
User.hasMany(OAuthRefreshToken, { foreignKey: 'userId', onDelete: 'CASCADE' })
User.hasMany(StoreSnapshot, { foreignKey: 'userId', onDelete: 'CASCADE' })
User.hasMany(CompetitorSnapshot, { foreignKey: 'userId', onDelete: 'CASCADE' })
User.hasMany(ProductSnapshot, { foreignKey: 'userId', onDelete: 'CASCADE' })
User.hasOne(GuardrailConfig, { foreignKey: 'userId', onDelete: 'CASCADE' })
User.hasMany(RepriceLog, { foreignKey: 'userId', onDelete: 'CASCADE' })
User.hasOne(AiProviderSetting, { foreignKey: 'userId', onDelete: 'CASCADE' })

module.exports = {
  sequelize,
  User,
  OtpCode,
  OAuthClient,
  OAuthAuthorizationCode,
  OAuthRefreshToken,
  DarazConnection,
  StoreSnapshot,
  CompetitorSnapshot,
  ProductSnapshot,
  GuardrailConfig,
  RepriceLog,
  AiProviderSetting,
}
