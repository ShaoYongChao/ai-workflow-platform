import { logger } from '../utils/logger'
import { Pool } from 'pg'

// ── 系统配置缓存 ────────────────────────────────────────────
interface SystemConfig {
  sandbox_timeout_seconds: number
  enable_memory_system: boolean
  enable_sonarqube: boolean
  max_auto_fix_retries: number
  default_project_id: string
  [key: string]: any
}

let configCache: Partial<SystemConfig> = {}
let lastConfigLoadTime = 0
const CONFIG_CACHE_TTL = 60000 // 1分钟缓存

export class ConfigLoader {
  private pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  // ── 加载系统配置（带缓存） ──────────────────────────────────
  async loadSystemConfig(projectId = 'default'): Promise<SystemConfig> {
    const now = Date.now()
    if (now - lastConfigLoadTime < CONFIG_CACHE_TTL) {
      return configCache as SystemConfig
    }

    try {
      const result = await this.pool.query(
        'SELECT key, value FROM system_settings WHERE project_id IS NULL OR project_id = $1',
        [projectId]
      )

      const config: Partial<SystemConfig> = {
        sandbox_timeout_seconds: 300,
        enable_memory_system: true,
        enable_sonarqube: false,
        max_auto_fix_retries: 3,
        default_project_id: projectId
      }

      // 解析数据库中的配置
      for (const row of result.rows) {
        const { key, value } = row
        if (key === 'sandbox_timeout_seconds' || key === 'max_auto_fix_retries') {
          config[key] = parseInt(value, 10)
        } else if (key === 'enable_memory_system' || key === 'enable_sonarqube') {
          config[key] = value === 'true' || value === '1'
        } else {
          config[key] = value
        }
      }

      configCache = config
      lastConfigLoadTime = now
      logger.info({ projectId, keys: Object.keys(config) }, '系统配置已加载')
      return config as SystemConfig
    } catch (err) {
      logger.warn({ err }, '加载系统配置失败，使用默认值')
      return {
        sandbox_timeout_seconds: parseInt(process.env.SANDBOX_TIMEOUT_SECONDS || '300', 10),
        enable_memory_system: process.env.ENABLE_MEMORY_SYSTEM === 'true',
        enable_sonarqube: process.env.ENABLE_SONARQUBE === 'true',
        max_auto_fix_retries: 3,
        default_project_id: projectId
      }
    }
  }

  // ── 清除缓存（用于测试或配置更新） ──────────────────────────
  clearCache() {
    configCache = {}
    lastConfigLoadTime = 0
  }
}
