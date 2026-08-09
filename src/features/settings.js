const express = require('express')
const env = require('../config')
const { AiProviderSetting } = require('../models')
const { authenticate } = require('../middleware')
const { ApiError, asyncHandler, decrypt, encrypt } = require('../utils')

const router = express.Router()
const providers = ['openai', 'openrouter']

const cleanModel = (value, fallback) => {
  const model = String(value || '').trim()
  return model ? model.slice(0, 160) : fallback
}

const getAiSetting = async (userId) => {
  const [setting] = await AiProviderSetting.findOrCreate({
    where: { userId },
    defaults: {
      userId,
      activeProvider: env.ai.defaultProvider,
      openaiModel: env.openai.model,
      openrouterModel: env.openrouter.model,
    },
  })
  return setting
}

const publicAiSetting = (setting) => ({
  activeProvider: providers.includes(setting.activeProvider) ? setting.activeProvider : env.ai.defaultProvider,
  providers: {
    openai: {
      label: 'OpenAI GPT',
      model: setting.openaiModel || env.openai.model,
      hasUserKey: Boolean(setting.encryptedOpenaiApiKey),
      hasPlatformKey: Boolean(env.openai.apiKey),
      ready: Boolean(setting.encryptedOpenaiApiKey || env.openai.apiKey),
    },
    openrouter: {
      label: 'OpenRouter',
      model: setting.openrouterModel || env.openrouter.model,
      hasUserKey: Boolean(setting.encryptedOpenrouterApiKey),
      hasPlatformKey: Boolean(env.openrouter.apiKey),
      ready: Boolean(setting.encryptedOpenrouterApiKey || env.openrouter.apiKey),
    },
  },
  defaults: {
    openaiModel: env.openai.model,
    openrouterModel: env.openrouter.model,
  },
  updatedAt: setting.updatedAt,
})

const decryptKey = (encryptedValue) => {
  if (!encryptedValue) return ''
  try {
    return decrypt(encryptedValue)
  } catch {
    return ''
  }
}

const resolveAiProvider = async (userId) => {
  const setting = await getAiSetting(userId)
  const activeProvider = providers.includes(setting.activeProvider) ? setting.activeProvider : env.ai.defaultProvider
  if (activeProvider === 'openai') {
    const userKey = decryptKey(setting.encryptedOpenaiApiKey)
    return {
      provider: 'openai',
      label: 'OpenAI GPT',
      model: setting.openaiModel || env.openai.model,
      apiKey: userKey || env.openai.apiKey,
      baseUrl: env.openai.baseUrl.replace(/\/$/, ''),
      usingUserKey: Boolean(userKey),
    }
  }

  const userKey = decryptKey(setting.encryptedOpenrouterApiKey)
  return {
    provider: 'openrouter',
    label: 'OpenRouter',
    model: setting.openrouterModel || env.openrouter.model,
    apiKey: userKey || env.openrouter.apiKey,
    baseUrl: env.openrouter.baseUrl.replace(/\/$/, ''),
    siteUrl: env.openrouter.siteUrl,
    appName: env.openrouter.appName,
    usingUserKey: Boolean(userKey),
  }
}

router.get('/ai', authenticate, asyncHandler(async (req, res) => {
  res.json({ settings: publicAiSetting(await getAiSetting(req.user.id)) })
}))

router.put('/ai', authenticate, asyncHandler(async (req, res) => {
  const setting = await getAiSetting(req.user.id)
  const activeProvider = String(req.body.activeProvider || setting.activeProvider).trim().toLowerCase()
  if (!providers.includes(activeProvider)) {
    throw new ApiError(400, 'Choose OpenAI GPT or OpenRouter.', 'INVALID_AI_PROVIDER')
  }

  const updates = {
    activeProvider,
    openaiModel: cleanModel(req.body.openaiModel, setting.openaiModel || env.openai.model),
    openrouterModel: cleanModel(req.body.openrouterModel, setting.openrouterModel || env.openrouter.model),
  }

  if (req.body.clearOpenaiKey) updates.encryptedOpenaiApiKey = null
  if (req.body.clearOpenrouterKey) updates.encryptedOpenrouterApiKey = null

  const openaiApiKey = String(req.body.openaiApiKey || '').trim()
  const openrouterApiKey = String(req.body.openrouterApiKey || '').trim()
  if (openaiApiKey) updates.encryptedOpenaiApiKey = encrypt(openaiApiKey)
  if (openrouterApiKey) updates.encryptedOpenrouterApiKey = encrypt(openrouterApiKey)

  await setting.update(updates)
  res.json({ settings: publicAiSetting(setting) })
}))

module.exports = router
module.exports.getAiSetting = getAiSetting
module.exports.resolveAiProvider = resolveAiProvider
module.exports.publicAiSetting = publicAiSetting
