/**
 * Dynamic Model Catalog
 * 
 * Parses openclaw.json to build model configuration from actual
 * configured providers and models, replacing hardcoded MODEL_CATALOG.
 * 
 * NOTE: This module can be imported by both server and client code.
 * Server-side functions use dynamic imports for fs/path.
 */

import type { Logger } from 'pino'

export interface ModelConfig {
  alias: string
  name: string
  provider: string
  description: string
  costPer1k: number
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: string[]
}

// Cost estimates per provider (fallback when not specified)
const PROVIDER_COSTS: Record<string, { input: number; output: number }> = {
  'anthropic': { input: 3.0, output: 15.0 },
  'openai': { input: 2.5, output: 10.0 },
  'moonshot': { input: 1.0, output: 1.0 },
  'groq': { input: 0.59, output: 0.79 },
  'ollama': { input: 0, output: 0 },
  'minimax': { input: 0.3, output: 0.3 },
}

// Model descriptions by pattern matching
const MODEL_DESCRIPTIONS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /kimi-k2\.5/i, description: 'Moonshot Kimi K2.5 — Long context, strong reasoning' },
  { pattern: /kimi/i, description: 'Moonshot Kimi model' },
  { pattern: /claude-3.*haiku/i, description: 'Claude 3.5 Haiku — Fast, cost-effective' },
  { pattern: /claude.*sonnet/i, description: 'Claude Sonnet — Balanced quality and speed' },
  { pattern: /claude.*opus/i, description: 'Claude Opus — Highest quality, premium pricing' },
  { pattern: /gpt-4o/i, description: 'GPT-4o — Omni-modal, latest GPT-4' },
  { pattern: /gpt-4/i, description: 'GPT-4 — Strong general capability' },
  { pattern: /deepseek/i, description: 'DeepSeek — Open source reasoning' },
  { pattern: /llama.*70b/i, description: 'Llama 3 70B — Open source, strong performance' },
  { pattern: /llama.*8b/i, description: 'Llama 3 8B — Fast, efficient' },
]

// Fallback catalog when openclaw.json can't be read
const FALLBACK_CATALOG: ModelConfig[] = [
  { alias: 'kimi', name: 'moonshot/kimi-k2.5', provider: 'moonshot', description: 'Kimi K2.5 — Primary model', costPer1k: 1.0, contextWindow: 131072, maxTokens: 8192 },
]

// Known aliases for model IDs - maps model ID patterns to aliases
const KNOWN_ALIASES: Array<{ pattern: RegExp; alias: string }> = [
  { pattern: /kimi-k2\.5/i, alias: 'kimi' },
  { pattern: /moonshot-v1-8k/i, alias: 'moonshot-8k' },
  { pattern: /moonshot-v1-32k/i, alias: 'moonshot-32k' },
  { pattern: /moonshot-v1-128k/i, alias: 'moonshot-128k' },
  { pattern: /claude-3.*haiku/i, alias: 'haiku' },
  { pattern: /claude.*sonnet/i, alias: 'sonnet' },
  { pattern: /claude.*opus/i, alias: 'opus' },
  { pattern: /gpt-4o/i, alias: 'gpt4o' },
  { pattern: /gpt-4(?!o)/i, alias: 'gpt4' },
  { pattern: /deepseek/i, alias: 'deepseek' },
  { pattern: /llama.*70b/i, alias: 'llama70b' },
  { pattern: /llama.*8b/i, alias: 'llama8b' },
]

// Track used aliases to ensure uniqueness
let usedAliases = new Set<string>()

interface OpenClawModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: string[]
}

interface OpenClawProvider {
  baseUrl?: string
  apiKey?: string
  api?: string
  models?: OpenClawModel[]
}

interface OpenClawModelAlias {
  alias?: string
}

// Server-side cache (only populated on server)
let serverCache: { models: ModelConfig[]; time: number } | null = null
const CACHE_TTL_MS = 30000

/**
 * Check if we're running on the server
 */
function isServer(): boolean {
  return typeof window === 'undefined'
}

/**
 * Safe logging (works on both server and client)
 */
function log(level: 'info' | 'warn' | 'error', message: string, meta?: any) {
  if (isServer()) {
    // Server: use console (pino will be imported dynamically where needed)
    console[level](message, meta || '')
  }
  // Client: silent (don't pollute browser console)
}

/**
 * Parse openclaw.json and build dynamic model catalog
 * Server-side only - returns fallback on client
 */
export async function parseModelCatalogAsync(): Promise<ModelConfig[]> {
  if (!isServer()) {
    return FALLBACK_CATALOG
  }

  try {
    // Dynamic imports for server-only modules
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { config } = await import('./config')

    if (!fs.existsSync(config.openclawConfigPath)) {
      log('warn', 'openclaw.json not found, using fallback catalog')
      return FALLBACK_CATALOG
    }

    const content = fs.readFileSync(config.openclawConfigPath, 'utf-8')
    const parsed = JSON.parse(content)

    const models: ModelConfig[] = []
    const seenNames = new Set<string>()
    resetUsedAliases() // Reset for new catalog generation

    // 1. Parse from models.providers (explicit provider configs)
    const providers: Record<string, OpenClawProvider> = parsed.models?.providers || {}
    for (const [providerName, provider] of Object.entries(providers)) {
      for (const model of (provider.models || [])) {
        const fullName = `${providerName}/${model.id}`
        if (seenNames.has(fullName)) continue
        seenNames.add(fullName)

        const cost = PROVIDER_COSTS[providerName] || { input: 1.0, output: 1.0 }
        
        models.push({
          alias: generateAlias(model.id),
          name: fullName,
          provider: providerName,
          description: getModelDescription(model.id, model.name),
          costPer1k: (cost.input + cost.output) / 2,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          reasoning: model.reasoning,
          input: model.input,
        })
      }
    }

    // 2. Parse from agents.defaults.models (agent-defined aliases)
    const defaultModels: Record<string, OpenClawModelAlias> = parsed.agents?.defaults?.models || {}
    for (const [fullName, aliasInfo] of Object.entries(defaultModels)) {
      if (seenNames.has(fullName)) continue
      seenNames.add(fullName)

      const [providerName, modelId] = fullName.split('/') as [string, string]
      const cost = PROVIDER_COSTS[providerName] || { input: 1.0, output: 1.0 }

      models.push({
        alias: aliasInfo.alias || generateAlias(modelId),
        name: fullName,
        provider: providerName,
        description: getModelDescription(modelId),
        costPer1k: (cost.input + cost.output) / 2,
      })
    }

    if (models.length === 0) {
      log('warn', 'No models found in openclaw.json, using fallback')
      return FALLBACK_CATALOG
    }

    log('info', `Loaded ${models.length} models from openclaw.json`)
    return models
  } catch (error) {
    log('error', 'Failed to parse model catalog', error)
    return FALLBACK_CATALOG
  }
}

/**
 * Get cached model catalog (server-side with cache, client gets fallback)
 */
export async function getModelCatalogAsync(): Promise<ModelConfig[]> {
  if (!isServer()) {
    return FALLBACK_CATALOG
  }

  const now = Date.now()
  if (serverCache && (now - serverCache.time) < CACHE_TTL_MS) {
    return serverCache.models
  }

  const models = await parseModelCatalogAsync()
  serverCache = { models, time: now }
  return models
}

/**
 * Get model catalog synchronously (uses fallback on client)
 * For client components that need models, fetch from /api/models
 */
export function getModelCatalogSync(): ModelConfig[] {
  if (!isServer()) {
    return FALLBACK_CATALOG
  }
  
  // On server, return cache or fallback (async load happens separately)
  return serverCache?.models || FALLBACK_CATALOG
}

/**
 * Invalidate model cache
 */
export function invalidateModelCache() {
  serverCache = null
  log('info', 'Model cache invalidated')
}

/**
 * Generate a short alias from model ID (ensures uniqueness)
 */
function generateAlias(modelId: string): string {
  const normalized = modelId.toLowerCase()
  
  // Find matching pattern
  for (const { pattern, alias } of KNOWN_ALIASES) {
    if (pattern.test(normalized)) {
      // Ensure uniqueness by appending number if needed
      let uniqueAlias = alias
      let counter = 1
      while (usedAliases.has(uniqueAlias)) {
        uniqueAlias = `${alias}-${counter}`
        counter++
      }
      usedAliases.add(uniqueAlias)
      return uniqueAlias
    }
  }

  // Fallback: truncate and clean
  let fallback = modelId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase()
  let counter = 1
  while (usedAliases.has(fallback)) {
    fallback = `${fallback.slice(0, 6)}-${counter}`
    counter++
  }
  usedAliases.add(fallback)
  return fallback
}

/**
 * Reset used aliases (call before generating new catalog)
 */
function resetUsedAliases() {
  usedAliases = new Set<string>()
}

/**
 * Get description for a model
 */
function getModelDescription(modelId: string, modelName?: string): string {
  for (const { pattern, description } of MODEL_DESCRIPTIONS) {
    if (pattern.test(modelId)) {
      return description
    }
  }
  return modelName || `${modelId} model`
}

/**
 * Get model by alias (sync version - uses cache or fallback)
 */
export function getModelByAlias(alias: string): ModelConfig | undefined {
  return getModelCatalogSync().find(m => m.alias === alias)
}

/**
 * Get model by full name (sync version - uses cache or fallback)
 */
export function getModelByName(name: string): ModelConfig | undefined {
  return getModelCatalogSync().find(m => m.name === name)
}

/**
 * Get all available models (sync version - uses cache or fallback)
 */
export function getAllModels(): ModelConfig[] {
  return [...getModelCatalogSync()]
}

/**
 * Get primary model from config (async)
 */
export async function getPrimaryModelAsync(): Promise<ModelConfig | undefined> {
  if (!isServer()) {
    return FALLBACK_CATALOG[0]
  }

  try {
    const fs = await import('node:fs')
    const { config } = await import('./config')
    
    const content = fs.readFileSync(config.openclawConfigPath, 'utf-8')
    const parsed = JSON.parse(content)
    const primary = parsed.agents?.defaults?.model?.primary
    
    if (primary) {
      const models = await getModelCatalogAsync()
      return models.find(m => m.name === primary)
    }
  } catch {
    // Fallback
  }
  
  return (await getModelCatalogAsync())[0]
}

/**
 * Get primary model sync (fallback)
 */
export function getPrimaryModel(): ModelConfig | undefined {
  return FALLBACK_CATALOG[0]
}

// Legacy exports for backward compatibility
export { FALLBACK_CATALOG as MODEL_CATALOG }
