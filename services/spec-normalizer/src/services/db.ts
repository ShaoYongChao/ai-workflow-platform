import { Pool } from 'pg'
import { logger } from '../utils/logger'
import { FeatureSpec } from '../schemas/types'

let pool: Pool

export async function initDB() {
  pool = new Pool({ connectionString: process.env.POSTGRES_URL })
  await pool.query('SELECT 1') // 连接测试
}

export async function saveSpec(data: {
  title: string
  rawInput: string
  structuredSpec: FeatureSpec
  completenessScore: number
}) {
  const result = await pool.query(
    `INSERT INTO feature_specs (title, raw_input, structured_spec, completeness_score, status)
     VALUES ($1, $2, $3, $4, 'submitted') RETURNING id`,
    [data.title, data.rawInput, JSON.stringify(data.structuredSpec), data.completenessScore]
  )
  return result.rows[0]
}

export async function getSpec(id: string) {
  const result = await pool.query('SELECT * FROM feature_specs WHERE id = $1', [id])
  return result.rows[0] || null
}

export async function getLLMProviderConfig(projectId = 'default') {
  try {
    // 优先获取项目特定配置，如果没有则获取默认配置
    const result = await pool.query(
      `SELECT name, provider_type, api_key, api_base_url, model_list
       FROM llm_providers
       WHERE enabled = true
       ORDER BY created_at DESC
       LIMIT 1`
    )
    if (result.rows.length > 0) {
      return result.rows[0]
    }
  } catch (err) {
    logger.warn({ err }, '从数据库读取LLM配置失败，将使用环境变量')
  }
  return null
}

export async function getSystemSetting(key: string, projectId = 'default') {
  try {
    const result = await pool.query(
      'SELECT value FROM system_settings WHERE key = $1 AND (project_id = $2 OR project_id IS NULL) ORDER BY project_id DESC LIMIT 1',
      [key, projectId]
    )
    return result.rows[0]?.value || null
  } catch (err) {
    logger.warn({ key, err }, '从数据库读取系统设置失败')
    return null
  }
}