import express, { Request, Response } from 'express'
import { Pool } from 'pg'
import { logger } from './utils/logger'
import { initDB, initRedis, getPool, getRedis } from './services/task-store'
import { startConsumer, stopConsumer } from './consumers/spec-consumer'
import { taskRouter } from './routes/tasks'
import 'dotenv/config'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const configManager = require('../../../shared/config-manager')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { tenantMiddleware } = require('../../../gateway/tenant-middleware')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initializeAgentSystem } = require('../../agents')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getLLMRouter } = require('../../agents/dynamic/llm-router')

const app = express()
const PORT = parseInt(process.env.PORT || '3003', 10)

app.use(express.json())

// ── 健康检查 ────────────────────────────────────────────────
app.get('/health', (_: Request, res: Response) => {
  res.json({ status: 'ok', service: 'code-generator', ts: Date.now() })
})

// ── Prometheus 指标 ─────────────────────────────────────────
app.get('/metrics', async (_, res: Response) => {
  try {
    const { register } = require('./metrics')
    if (!register) return res.status(503).send('# prom-client not installed\n')
    res.set('Content-Type', register.contentType)
    res.end(await register.metrics())
  } catch {
    res.status(500).send('# metrics error\n')
  }
})

// ── 任务 API ────────────────────────────────────────────────
app.use('/api/v1/tasks', tenantMiddleware({ required: false }), taskRouter)

// ── 启动 ────────────────────────────────────────────────────
async function bootstrap() {
  try {
    // 1. 初始化存储
    initDB()
    logger.info('✅ PostgreSQL 连接初始化')

    initRedis()
    logger.info('✅ Redis 连接初始化')

    // 2. 初始化配置管理器
    const pool = getPool()
    const redis = getRedis()
    await configManager.init(pool, redis)
    logger.info('✅ 配置管理器初始化')

    // 3. 初始化 Agent 系统（Phase 4）
    const llmRouter = getLLMRouter(pool)
    const { registry, taskBus } = await initializeAgentSystem(pool, llmRouter)
    logger.info(`✅ Agent 系统初始化，${registry.list().length} 个内置 Agent`)

    // 将全局注册表、任务总线和配置管理器存储到应用上下文（供消费者使用）
    app.locals.agentRegistry = registry
    app.locals.taskBus = taskBus
    app.locals.llmRouter = llmRouter
    app.locals.configManager = configManager

    // 4. 启动 HTTP（先起来，让健康检查可用）
    app.listen(PORT, () => {
      logger.info(`🚀 code-generator HTTP 服务启动，端口 ${PORT}`)
    })

    // 5. 启动 Kafka 消费者（传入 app 上下文以获取初始化的 Agent 系统）
    await startConsumer(app)

  } catch (err) {
    logger.error(err, '服务启动失败')
    process.exit(1)
  }
}

// ── 优雅关闭 ────────────────────────────────────────────────
async function shutdown(signal: string) {
  logger.info({ signal }, '收到退出信号，开始优雅关闭')
  await stopConsumer()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

bootstrap()