import { Pool } from 'pg'
import Redis from 'ioredis'
import { GenerationResult, FeatureSpec } from '../schemas/types'
import { logger } from '../utils/logger'

let pool: Pool
let redis: Redis

export function initDB() {
  pool = new Pool({ connectionString: process.env.POSTGRES_URL })
}

export function initRedis() {
  redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')
  redis.on('error', (err) => logger.error(err, 'Redis 连接错误'))
}

// ── 创建任务记录 ────────────────────────────────────────────
export async function createTask(specId: string, priority: string): Promise<string> {
  const res = await pool.query(
    `INSERT INTO generation_tasks (spec_id, status, priority, started_at)
     VALUES ($1, 'running', $2, NOW()) RETURNING id`,
    [specId, priority]
  )
  const taskId = res.rows[0].id

  // Redis 缓存任务状态，供 WebSocket 实时推送
  await redis.setex(`task:${taskId}:status`, 3600, JSON.stringify({
    taskId, specId, status: 'running', startedAt: Date.now()
  }))

  logger.info({ taskId, specId }, '任务记录已创建')
  return taskId
}

// ── 保存生成结果 ────────────────────────────────────────────
export async function saveResult(taskId: string, result: GenerationResult) {
  await pool.query(
    `UPDATE generation_tasks
     SET status = $1,
         generated_files = $2,
         kb_chunks_used = $3,
         completed_at = NOW()
     WHERE id = $4`,
    [
      result.status,
      JSON.stringify(result.files),
      JSON.stringify(result.usedChunks),
      taskId
    ]
  )

  await redis.setex(`task:${taskId}:status`, 3600, JSON.stringify({
    taskId,
    status: result.status,
    fileCount: result.files.length,
    completedAt: Date.now()
  }))

  logger.info({ taskId, status: result.status, files: result.files.length, chunksUsed: result.usedChunks.length }, '生成结果已保存')
}

// ── 保存失败样本（用于后续模型优化） ───────────────────────
export async function saveFailureSample(
  taskId: string,
  spec: FeatureSpec,
  error: string,
  generatedCode?: string
) {
  await pool.query(
    `INSERT INTO failure_samples
       (task_id, failure_type, error_detail, spec_snapshot, generated_code)
     VALUES ($1, 'generation_failed', $2, $3, $4)`,
    [taskId, error, JSON.stringify(spec), generatedCode || null]
  )

  // 更新任务状态
  await pool.query(
    `UPDATE generation_tasks
     SET status = 'failed', error_log = $1, completed_at = NOW()
     WHERE id = $2`,
    [error, taskId]
  )

  logger.warn({ taskId }, '失败样本已记录')
}

// ── 查询任务实时状态 ────────────────────────────────────────
export async function getTaskStatus(taskId: string) {
  const cached = await redis.get(`task:${taskId}:status`)
  if (cached) return JSON.parse(cached)
  const res = await pool.query('SELECT * FROM generation_tasks WHERE id = $1', [taskId])
  return res.rows[0] || null
}