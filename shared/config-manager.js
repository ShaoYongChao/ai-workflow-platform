/**
 * shared/config-manager.js
 * 系统配置管理器
 *
 * 优先级：use_env_config=true → .env → 数据库系统设置 → 硬编码默认值
 *
 * 用法：
 *   const config = require('./config-manager')
 *   await config.init(pool)  // 初始化（加载数据库配置）
 *   config.get('default_llm')
 *   config.getAll()
 */

'use strict'

const DEFAULT_CONFIG = {
  default_llm: process.env.DEFAULT_LLM || 'claude-sonnet-4',
  default_pipeline_domain: process.env.DEFAULT_PIPELINE_DOMAIN || '*',
  enable_vector_search: process.env.ENABLE_VECTOR_SEARCH === 'true',
  max_retries: parseInt(process.env.MAX_RETRIES || '3', 10),
  use_env_config: process.env.USE_ENV_CONFIG === 'true',
  kb_quality_threshold: parseInt(process.env.KB_QUALITY_THRESHOLD || '60', 10),
  retrieval_service_url: process.env.RETRIEVAL_SERVICE_URL || null,
  openai_api_key: process.env.OPENAI_API_KEY || null,
  anthropic_api_key: process.env.ANTHROPIC_API_KEY || null,
}

let pool = null
let dbConfig = {}
let cacheTime = 0
const CACHE_TTL = 60000 // 60秒缓存
let redisPubSub = null

async function init(pgPool, redisClient = null) {
  pool = pgPool
  await refresh()

  // 如果提供了 Redis 客户端，订阅配置刷新消息
  if (redisClient) {
    try {
      redisPubSub = redisClient.duplicate()
      await redisPubSub.subscribe('config:refresh', (message) => {
        const data = JSON.parse(message)
        console.log('📢 收到配置刷新通知:', data.key)
        refresh().catch(err => console.error('配置刷新失败:', err.message))
      })
    } catch (err) {
      console.warn('⚠️ Redis 订阅初始化失败，使用缓存刷新:', err.message)
    }
  }
}

async function refresh() {
  if (!pool) return
  try {
    const r = await pool.query(`SELECT key, value FROM system_settings`)
    dbConfig = {}
    for (const { key, value } of r.rows) {
      try {
        dbConfig[key] = typeof value === 'string' ? JSON.parse(value) : value
      } catch {
        dbConfig[key] = value
      }
    }
    cacheTime = Date.now()
  } catch (err) {
    console.error('❌ 加载系统设置失败:', err.message)
  }
}

function get(key) {
  // 检查缓存是否过期
  if (Date.now() - cacheTime > CACHE_TTL && pool) {
    refresh().catch(() => {})
  }

  // 如果启用了 env 配置，优先使用 .env
  if (dbConfig.use_env_config || DEFAULT_CONFIG.use_env_config) {
    const envKey = key.toUpperCase()
    if (process.env[envKey] !== undefined) {
      return tryParse(process.env[envKey])
    }
  }

  // 其次使用数据库配置
  if (dbConfig[key] !== undefined) {
    return dbConfig[key]
  }

  // 最后使用默认值
  return DEFAULT_CONFIG[key]
}

function getAll() {
  return {
    ...DEFAULT_CONFIG,
    ...dbConfig,
  }
}

function tryParse(val) {
  if (val === 'true') return true
  if (val === 'false') return false
  if (/^\d+$/.test(val)) return parseInt(val, 10)
  try {
    return JSON.parse(val)
  } catch {
    return val
  }
}

module.exports = {
  init,
  get,
  getAll,
  refresh,
}
