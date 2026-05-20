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