import { Router, Request, Response } from 'express'
import Redis from 'ioredis'
import { getTaskStatus, createTask, saveResult, saveFailureSample } from '../services/task-store'
import { generateCode } from '../generators/code-engine'
import { FeatureSpecSchema } from '../schemas/types'
import { publishCodeGeneratedEvent, publishCodeFailedEvent } from '../kafka/producer'
import { logger } from '../utils/logger'

export const taskRouter = Router()

// 懒加载 Redis publisher（复用连接，用于广播任务状态）
let _redis: Redis | null = null
function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')
    _redis.on('error', (e) => logger.warn({ e }, 'tasks-route Redis error'))
  }
  return _redis
}

// ── GET /tasks/:id - 查询任务状态 ──────────────────────────
taskRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const task = await getTaskStatus(req.params.id)
    if (!task) return res.status(404).json({ error: '任务不存在' })
    res.json(task)
  } catch (err) {
    logger.error(err, '查询任务状态失败')
    res.status(500).json({ error: '服务内部错误' })
  }
})

// ── POST /tasks/trigger - 手动触发完整流程（VS Code 插件调用） ─
// 与 Kafka 消费者走相同管道：
//   createTask → generateCode → Kafka code.generated → executor 测试
taskRouter.post('/trigger', async (req: Request, res: Response) => {
  // spec 字段放在 body 的 spec 字段，或直接平铺（兼容两种格式）
  const specBody = req.body.spec || req.body
  const specId   = req.body.specId   || 'manual'
  const projectId = req.body.projectId

  const parsed = FeatureSpecSchema.safeParse(specBody)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Spec 格式错误', details: parsed.error.issues })
  }

  const spec = parsed.data!
  const priorityMap: Record<string, string> = { high: 'P0', medium: 'P1', low: 'P2' }
  const priority = priorityMap[spec.priority] || 'P1'

  // 1. 在 DB 创建任务（UUID，与 Kafka 流程完全一致）
  let taskId: string
  try {
    taskId = await createTask(specId, priority)
  } catch (err) {
    logger.error({ specId, err }, '创建任务记录失败')
    return res.status(500).json({ error: '创建任务失败' })
  }

  // 2. 通知 VS Code：新任务已创建
  await getRedis().publish('task:created', JSON.stringify({
    taskId, specId, title: spec.title, priority, status: 'running', timestamp: Date.now()
  }))

  // 3. 立即返回 taskId（客户端可用来订阅 WS 更新）
  res.json({ taskId, message: '代码生成已启动，请在 VS Code 控制台查看实时进度' })

  // 4. 后台异步：生成代码 → 发 Kafka → executor 负责测试
  ;(async () => {
    try {
      const result = await generateCode(taskId, specId, spec, projectId)
      await saveResult(taskId, result)

      if (result.status === 'success') {
        // 发布到 Kafka，executor consumer 接收后运行测试 + Auto-Fix
        await publishCodeGeneratedEvent(taskId, result)

        await getRedis().publish('task:update', JSON.stringify({
          taskId, specId, status: 'generated',
          fileCount: result.files.length, timestamp: Date.now()
        }))
        logger.info({ taskId, files: result.files.length }, '✅ 手动触发：代码已发送到执行队列')
      } else {
        await saveFailureSample(taskId, spec, result.error || '生成失败')
        await publishCodeFailedEvent(taskId, specId, result.error || '生成失败')
        await getRedis().publish('task:update', JSON.stringify({
          taskId, specId, status: 'error', error: result.error, timestamp: Date.now()
        }))
      }
    } catch (err) {
      const msg = (err as Error).message
      logger.error({ taskId, specId, err }, '手动触发生成失败')
      await saveFailureSample(taskId, spec, msg).catch(() => {})
      await publishCodeFailedEvent(taskId, specId, msg).catch(() => {})
      await getRedis().publish('task:update', JSON.stringify({
        taskId, specId, status: 'error', error: msg, timestamp: Date.now()
      })).catch(() => {})
    }
  })()
  // handler 返回（res 已在上方发送）
})