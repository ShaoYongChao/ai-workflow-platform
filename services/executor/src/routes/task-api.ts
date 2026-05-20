import { Router, Request, Response } from 'express'
import { Pool } from 'pg'
import Redis from 'ioredis'
import * as http from 'http'
import { logger } from '../utils/logger'

export const taskApiRouter = Router()

let pool: Pool
let redis: Redis

export function initTaskAPI() {
  pool  = new Pool({ connectionString: process.env.POSTGRES_URL })
  redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')
}

// ── GET /api/v1/tasks/stats/summary  ─────────────────────────
// 必须放在 /:id/* 动态路由之前，否则 "stats" 会被当作 :id 参数匹配
taskApiRouter.get('/stats/summary', async (_: Request, res: Response) => {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'running')          AS running,
        COUNT(*) FILTER (WHERE status = 'test_pass')        AS pending_review,
        COUNT(*) FILTER (WHERE status = 'human_accepted')   AS accepted,
        COUNT(*) FILTER (WHERE status = 'human_rejected')   AS rejected,
        COUNT(*) FILTER (WHERE status = 'manual_review')    AS manual_review,
        COUNT(*)                                            AS total,
        AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) FILTER (WHERE completed_at IS NOT NULL) AS avg_duration_sec
      FROM generation_tasks
      WHERE created_at > NOW() - INTERVAL '7 days'
    `)
    res.json(r.rows[0])
  } catch (err) {
    logger.error(err, '统计查询失败')
    res.status(500).json({ error: '查询失败' })
  }
})

// ── GET /api/v1/tasks - 任务列表（支持过滤、分页） ──────────
// 匹配 /api/v1/tasks 和 /api/v1/tasks/ 两种写法
taskApiRouter.get(['/', ''], async (req: Request, res: Response) => {
  const status   = req.query.status as string | undefined
  const limit    = Math.min(parseInt(req.query.limit as string) || 50, 200)
  const offset   = parseInt(req.query.offset as string) || 0
  const projectId = req.query.project_id as string | undefined

  try {
    const filters: string[] = []
    const params: any[] = []
    let idx = 1

    if (status) {
      filters.push(`gt.status = $${idx++}`)
      params.push(status)
    }
    if (projectId) {
      filters.push(`fs.project_id = $${idx++}`)
      params.push(projectId)
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''

    const sql = `
      SELECT
        gt.id              AS task_id,
        gt.spec_id,
        gt.status,
        gt.priority,
        gt.retry_count,
        gt.created_at,
        gt.completed_at,
        fs.title           AS spec_title,
        fs.structured_spec AS spec,
        sr.total_score
      FROM generation_tasks gt
      LEFT JOIN feature_specs fs ON gt.spec_id = fs.id
      LEFT JOIN LATERAL (
        SELECT total_score FROM score_records sr WHERE sr.task_id = gt.id ORDER BY created_at DESC LIMIT 1
      ) sr ON true
      ${whereClause}
      ORDER BY gt.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `
    params.push(limit, offset)

    const result = await pool.query(sql, params)
    res.json({ total: result.rowCount, items: result.rows })

  } catch (err) {
    logger.error(err, '查询任务列表失败')
    res.status(500).json({ error: '查询失败' })
  }
})

// ── GET /api/v1/tasks/:id/files - 获取任务的生成文件 ────────
taskApiRouter.get('/:id/files', async (req: Request, res: Response) => {
  try {
    const r = await pool.query(
      `SELECT generated_files, status FROM generation_tasks WHERE id = $1`,
      [req.params.id]
    )
    if (r.rowCount === 0) return res.status(404).json({ error: '任务不存在' })

    const files = r.rows[0].generated_files || []
    res.json({
      taskId: req.params.id,
      status: r.rows[0].status,
      files
    })
  } catch (err) {
    logger.error(err, '查询文件失败')
    res.status(500).json({ error: '查询失败' })
  }
})

// ── GET /api/v1/tasks/:id/result - 完整结果（含测试、评分和 KB chunks） ─
taskApiRouter.get('/:id/result', async (req: Request, res: Response) => {
  try {
    const r = await pool.query(
      `SELECT
         gt.*,
         fs.title AS spec_title,
         fs.structured_spec AS spec,
         sr.correctness_score, sr.test_coverage, sr.quality_score, sr.total_score
       FROM generation_tasks gt
       LEFT JOIN feature_specs fs ON gt.spec_id = fs.id
       LEFT JOIN LATERAL (
         SELECT * FROM score_records WHERE task_id = gt.id ORDER BY created_at DESC LIMIT 1
       ) sr ON true
       WHERE gt.id = $1`,
      [req.params.id]
    )

    if (r.rowCount === 0) return res.status(404).json({ error: '任务不存在' })
    res.json(r.rows[0])

  } catch (err) {
    logger.error(err, '查询完整结果失败')
    res.status(500).json({ error: '查询失败' })
  }
})

// ── POST /api/v1/tasks/:id/decision - Accept/Reject ───────
taskApiRouter.post('/:id/decision', async (req: Request, res: Response) => {
  const { decision, feedback, developerId, humanScore } = req.body as {
    decision: 'accept' | 'reject' | 'partial_accept'
    feedback?: string
    developerId?: string
    humanScore?: number    // 1-5 星
    acceptedFiles?: string[]  // partial_accept 时指定
  }

  if (!['accept', 'reject', 'partial_accept'].includes(decision)) {
    return res.status(400).json({ error: 'decision 必须是 accept/reject/partial_accept' })
  }

  try {
    // 1. 更新任务状态
    const newStatus = decision === 'accept'
      ? 'human_accepted'
      : decision === 'reject' ? 'human_rejected' : 'human_partial_accepted'

    await pool.query(
      `UPDATE generation_tasks SET status = $1 WHERE id = $2`,
      [newStatus, req.params.id]
    )

    // 2. 写入评分（人工评分维度，权重 10%）
    if (humanScore !== undefined) {
      await pool.query(
        `INSERT INTO score_records (task_id, human_score, feedback_text) VALUES ($1, $2, $3)`,
        [req.params.id, humanScore, feedback || null]
      )
    }

    // 3. 拒绝时记录失败样本 + 触发进化
    if (decision === 'reject') {
      await pool.query(
        `INSERT INTO failure_samples (task_id, failure_type, error_detail)
         VALUES ($1, 'human_reject', $2)`,
        [req.params.id, feedback || '开发者主观拒绝']
      )

      // 触发进化引擎：从反馈中提取约束
      try {
        const { EvolutionEngine } = require('../../../../services/scorer/src/evolution-engine')
        const engine = new EvolutionEngine()
        await engine.evolveFromFeedback(req.params.id, feedback || '', humanScore || 1)
        logger.info({ taskId: req.params.id }, '进化引擎已处理拒绝反馈')
      } catch (e) {
        logger.warn({ e }, '进化引擎调用失败（不阻塞主流程）')
      }
    }

    // 接受时记录高分样本 + 沉淀记忆
    if (decision === 'accept' && humanScore && humanScore >= 4) {
      try {
        const { EvolutionEngine } = require('../../../../services/scorer/src/evolution-engine')
        const engine = new EvolutionEngine()
        await engine.learnFromHighScore(req.params.id, 'unknown', (humanScore / 5) * 100)
      } catch { /* 不阻塞 */ }

      // 将成功案例沉淀为项目长期记忆
      try {
        const taskRow = await pool.query(
          `SELECT gt.id, fs.project_id, fs.title, fs.structured_spec
           FROM generation_tasks gt
           JOIN feature_specs fs ON gt.spec_id = fs.id
           WHERE gt.id = $1`,
          [req.params.id]
        )
        if (taskRow.rows.length > 0) {
          const { project_id, title } = taskRow.rows[0]
          const { MemoryService } = require('../../../../services/memory/src/memory-service')
          const mem = new MemoryService({
            postgresUrl: process.env.POSTGRES_URL,
            redisUrl:    process.env.REDIS_URL
          })
          const summary = `功能"${title}"代码生成成功，开发者评分 ${humanScore}/5${feedback ? `。反馈：${feedback}` : ''}`
          await mem.encodeTaskCompletion(
            req.params.id,
            project_id || 'default',
            developerId || 'anonymous',
            summary
          )
          logger.info({ taskId: req.params.id, projectId: project_id }, '任务成功记忆已沉淀')
        }
      } catch (e) {
        logger.warn({ e }, '记忆沉淀失败（不阻塞主流程）')
      }
    }

    // 4. 审计日志
    await pool.query(
      `INSERT INTO audit_logs (action, actor, resource_type, resource_id, metadata)
       VALUES ($1, $2, 'task', $3, $4)`,
      [
        `task_${decision}`,
        developerId || 'anonymous',
        req.params.id,
        JSON.stringify({ feedback, humanScore })
      ]
    )

    // 5. 实时通知所有连接的插件
    await redis.publish('task:decision', JSON.stringify({
      taskId: req.params.id,
      decision,
      developerId
    }))

    logger.info({ taskId: req.params.id, decision, developerId }, 'Review 决策已记录')
    res.json({ success: true, status: newStatus })

  } catch (err) {
    logger.error(err, 'Review 决策保存失败')
    res.status(500).json({ error: '保存失败' })
  }
})

// /stats/summary 已移至文件顶部（动态路由 /:id/* 之前）

// ============================================================
// Spec 路由：供 VS Code 插件手动触发代码生成
// ============================================================
export const specApiRouter = Router()

// ── GET /api/v1/specs - 列出 feature_specs（供 QuickPick 选择） ─
specApiRouter.get(['/', ''], async (req: Request, res: Response) => {
  const limit    = Math.min(parseInt(req.query.limit as string) || 50, 200)
  const offset   = parseInt(req.query.offset as string) || 0
  const status   = req.query.status as string | undefined
  const projectId = req.query.project_id as string | undefined

  const filters: string[] = []
  const params: any[] = []
  let idx = 1

  if (status) {
    filters.push(`status = $${idx++}`)
    params.push(status)
  }
  if (projectId) {
    filters.push(`project_id = $${idx++}`)
    params.push(projectId)
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''

  try {
    // feature_specs 表只有 id/title/raw_input/structured_spec/status/project_id/created_at
    // goal/platform/priority 全部存在 structured_spec JSONB 字段里，用 ->> 提取
    const result = await pool.query(
      `SELECT
         id,
         title,
         status,
         project_id,
         created_at,
         structured_spec->>'goal'     AS goal,
         structured_spec->>'priority' AS priority,
         structured_spec->'platform'  AS platform
       FROM feature_specs
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset]
    )
    res.json({ total: result.rowCount, items: result.rows })
  } catch (err) {
    logger.error(err, '查询 Spec 列表失败')
    res.status(500).json({ error: '查询失败' })
  }
})

// ── POST /api/v1/specs/:specId/generate - 手动触发生成 ──────────
specApiRouter.post('/:specId/generate', async (req: Request, res: Response) => {
  const { specId } = req.params

  try {
    // 1. 从 DB 读取完整 Spec
    const specRow = await pool.query(
      `SELECT id, title, structured_spec, project_id FROM feature_specs WHERE id = $1`,
      [specId]
    )
    if (specRow.rowCount === 0) {
      return res.status(404).json({ error: 'Spec 不存在' })
    }

    const spec = specRow.rows[0].structured_spec
    if (!spec) {
      return res.status(400).json({ error: 'Spec 尚未完成结构化，请先完成对话' })
    }

    // 2. 转发给 code-generator 触发完整流程
    //    code-generator 会自己创建 DB 任务（UUID）、生成代码、发 Kafka code.generated
    //    executor consumer 收到后负责测试 + Auto-Fix
    const codeGenUrl = process.env.CODE_GENERATOR_URL || 'http://code-generator:3003'
    const cgResult = await httpPost(codeGenUrl + '/api/v1/tasks/trigger', {
      spec,                                           // Spec 内容
      specId,                                         // 传 specId 使 DB 关联正确
      projectId: specRow.rows[0].project_id || undefined
    })

    const taskId: string = cgResult.taskId
    logger.info({ taskId, specId }, '手动触发代码生成（完整流程）')

    // 3. 写审计日志
    await pool.query(
      `INSERT INTO audit_logs (action, actor, resource_type, resource_id, metadata)
       VALUES ('manual_generate', $1, 'spec', $2, $3)`,
      [
        req.headers['x-developer-id'] || 'anonymous',
        specId,
        JSON.stringify({ taskId, trigger: 'vscode-plugin' })
      ]
    )

    res.json({
      taskId,
      specTitle: specRow.rows[0].title,
      message: '代码生成已启动，请在 VS Code 控制台查看实时进度'
    })
  } catch (err) {
    logger.error({ specId, err }, '手动触发生成失败')
    res.status(500).json({ error: (err as Error).message || '触发失败' })
  }
})

// ── 简单 HTTP POST 工具函数（避免引入 axios） ────────────────
function httpPost(url: string, body: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const parsed  = new URL(url)
    const req = http.request({
      hostname: parsed.hostname,
      port:     parseInt(parsed.port) || 80,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 10000
    }, (res) => {
      let raw = ''
      res.on('data', (d) => raw += d)
      res.on('end', () => {
        if ((res.statusCode || 0) >= 400) {
          reject(new Error(`code-generator 返回 ${res.statusCode}: ${raw.slice(0, 200)}`))
          return
        }
        try { resolve(raw ? JSON.parse(raw) : {}) }
        catch { resolve({}) }
      })
    })
    req.on('error',   reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('code-generator 请求超时')) })
    req.write(payload)
    req.end()
  })
}
