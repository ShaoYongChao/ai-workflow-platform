import { Pool } from 'pg'
import Redis from 'ioredis'
import { ExecutionResult, TestRunResult } from '../schemas/types'
import { logger } from '../utils/logger'

let pool: Pool
let redis: Redis

export function initDB()    { pool  = new Pool({ connectionString: process.env.POSTGRES_URL }) }
export function initRedis() {
  redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')
  redis.on('error', err => logger.error(err, 'Redis 错误'))
}

export function getRedis(): Redis {
  if (!redis) throw new Error('Redis not initialized. Call initRedis() first.')
  return redis
}

// ── 保存执行结果到 DB ────────────────────────────────────────
export async function saveExecutionResult(result: ExecutionResult) {
  const { taskId, status, finalFiles, testResults, fixAttempts, totalDurationMs } = result

  // 更新 generation_tasks
  await pool.query(
    `UPDATE generation_tasks
     SET status         = $1,
         generated_files = $2,
         test_result    = $3,
         retry_count    = $4,
         completed_at   = NOW()
     WHERE id = $5`,
    [
      status,
      JSON.stringify(finalFiles),
      JSON.stringify(testResults),
      fixAttempts.length,
      taskId
    ]
  )

  // 计算并保存评分
  const score = calculateScore(testResults)
  if (score) {
    await pool.query(
      `INSERT INTO score_records
         (task_id, correctness_score, test_coverage, quality_score, total_score)
       VALUES ($1, $2, $3, $4, $5)`,
      [taskId, score.correctness, score.coverage, score.quality, score.total]
    )
  }

  // 如果有失败，保存失败样本
  if (status === 'manual_review') {
    await saveFailureSample(taskId, result)
  }

  // 更新 Redis 状态
  await redis.setex(`task:${taskId}:status`, 3600, JSON.stringify({
    taskId,
    status,
    testSummary: summarizeTestResults(testResults),
    fixAttempts: fixAttempts.length,
    durationMs: totalDurationMs,
    updatedAt: Date.now()
  }))

  // ★ 发布到 Redis pub/sub，让 WebSocket 实时通知所有 VS Code 插件
  await redis.publish('task:update', JSON.stringify({
    taskId,
    status,
    fixAttempts: fixAttempts.length,
    durationMs: totalDurationMs,
    score: score?.total,
    finalFilesCount: finalFiles.length,
    timestamp: Date.now()
  }))

  logger.info({ taskId, status, score: score?.total }, '执行结果已保存')
}

// ── 执行异常时标记任务为 error 状态 ─────────────────────────
export async function markTaskError(taskId: string, errorMessage: string) {
  try {
    await pool.query(
      `UPDATE generation_tasks
       SET status       = 'error',
           completed_at = NOW()
       WHERE id = $1 AND status = 'running'`,
      [taskId]
    )

    await pool.query(
      `INSERT INTO failure_samples (task_id, failure_type, error_detail)
       VALUES ($1, 'execution_exception', $2)
       ON CONFLICT DO NOTHING`,
      [taskId, errorMessage.slice(0, 1000)]
    )

    if (redis) {
      await redis.setex(`task:${taskId}:status`, 3600, JSON.stringify({
        taskId, status: 'error', error: errorMessage, updatedAt: Date.now()
      }))
      await redis.publish('task:update', JSON.stringify({
        taskId, status: 'error', error: errorMessage, timestamp: Date.now()
      }))
    }

    logger.info({ taskId }, '任务已标记为 error 状态')
  } catch (err) {
    logger.error({ taskId, err }, 'markTaskError 失败')
  }
}

// ── 阶段性进度广播（执行编排各阶段调用） ─────────────────────
export async function broadcastProgress(taskId: string, stage: string, detail?: any) {
  if (!redis) return
  try {
    await redis.publish('task:log', JSON.stringify({
      taskId, stage, detail, timestamp: Date.now()
    }))
  } catch (err) {
    logger.warn({ err }, '进度广播失败（不阻塞主流程）')
  }
}

// ── 评分计算（Phase 1 简化版，Phase 3 接 SonarQube） ────────
function calculateScore(testResults: TestRunResult[]): {
  correctness: number
  coverage: number
  quality: number
  total: number
} | null {
  if (testResults.length === 0) return null

  const lastResults = getLastRoundResults(testResults)

  // 正确性：测试通过率（权重 35%）
  const totalTests  = lastResults.reduce((s, r) => s + r.totalTests, 0)
  const passedTests = lastResults.reduce((s, r) => s + r.passedTests, 0)
  const correctness = totalTests > 0 ? (passedTests / totalTests) * 100 : 0

  // 测试覆盖率（权重 25%）
  const coverages = lastResults.map(r => r.coverage).filter(c => c !== undefined) as number[]
  const coverage  = coverages.length > 0
    ? coverages.reduce((s, c) => s + c, 0) / coverages.length
    : 0

  // 代码质量（Phase 1 简化：全部通过 = 80 分，否则按比例）
  const quality = correctness >= 100 ? 80 : correctness * 0.8

  // 加权总分
  const total = correctness * 0.35 + coverage * 0.25 + quality * 0.20

  return { correctness, coverage, quality, total: Math.round(total) }
}

// ── 取最后一轮测试结果 ───────────────────────────────────────
function getLastRoundResults(results: TestRunResult[]): TestRunResult[] {
  const goResults = results.filter(r => r.language === 'go')
  const tsResults = results.filter(r => r.language === 'typescript')
  return [
    goResults[goResults.length - 1],
    tsResults[tsResults.length - 1]
  ].filter(Boolean)
}

function summarizeTestResults(results: TestRunResult[]) {
  return results.map(r => ({
    lang: r.language,
    status: r.status,
    passed: r.passedTests,
    total: r.totalTests,
    coverage: r.coverage
  }))
}

async function saveFailureSample(taskId: string, result: ExecutionResult) {
  const lastTest = result.testResults[result.testResults.length - 1]
  const fixLog   = result.fixAttempts.map(a => ({
    attempt: a.attempt,
    strategy: a.strategy,
    error: a.errorSummary.slice(0, 300)
  }))

  await pool.query(
    `INSERT INTO failure_samples
       (task_id, failure_type, error_detail, fix_attempts)
     VALUES ($1, 'test_failure', $2, $3)
     ON CONFLICT DO NOTHING`,
    [
      taskId,
      lastTest?.rawOutput?.slice(0, 1000) || '未知错误',
      JSON.stringify(fixLog)
    ]
  )
}