import express from 'express'
import { createServer } from 'http'
import cors from 'cors'
import { logger } from './utils/logger'
import { initDB, initRedis, getRedis } from './services/result-store'
import { startConsumer, stopConsumer } from './consumers/code-consumer'
import { taskApiRouter, specApiRouter, initTaskAPI } from './routes/task-api'
import { attachWebSocketServer } from './services/websocket-server'
import { initializeConfigLoader, setAppContext } from './services/execution-orchestrator'
import 'dotenv/config'
import { Pool } from 'pg'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const configManager = require('../../../shared/config-manager')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { tenantMiddleware } = require('../../../gateway/tenant-middleware')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initializeAgentSystem } = require('../../agents')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getLLMRouter } = require('../../agents/dynamic/llm-router')

const app  = express()
const PORT = process.env.PORT || 3004

app.use(cors({ origin: '*' }))
app.use(express.json())

// ── 健康检查（不需要租户验证） ──────────────────────────────
app.get('/health', (_, res) =>
  res.json({ status: 'ok', service: 'executor', ts: Date.now() })
)

// ── Prometheus 指标 ─────────────────────────────────────────
app.get('/metrics', async (_, res) => {
  try {
    const { register } = require('./metrics')
    if (!register) return res.status(503).send('# prom-client not installed\n')
    res.set('Content-Type', register.contentType)
    res.end(await register.metrics())
  } catch (err) {
    res.status(500).send('# metrics error\n')
  }
})

// ── 任务 API（带多租户中间件，required: false 保持向后兼容） ─
app.use('/api/v1/tasks', tenantMiddleware({ required: false }), taskApiRouter)

// ── Spec API（手动触发代码生成，required: false 保持向后兼容） ─
app.use('/api/v1/specs', tenantMiddleware({ required: false }), specApiRouter)

async function bootstrap() {
  try {
    initDB()
    logger.info('✅ PostgreSQL 初始化')

    initRedis()
    logger.info('✅ Redis 初始化')

    // 为 ConfigLoader 初始化 pool
    const configPool = new Pool({ connectionString: process.env.POSTGRES_URL })
    initializeConfigLoader(configPool)
    logger.info('✅ ConfigLoader 初始化')

    // 初始化配置管理器
    const redis = getRedis()
    await configManager.init(configPool, redis)
    logger.info('✅ 配置管理器初始化')

    // 初始化 Agent 系统（Phase 4.2）
    const llmRouter = getLLMRouter(configPool)
    const { registry, taskBus } = await initializeAgentSystem(configPool, llmRouter)
    logger.info(`✅ Agent 系统初始化，${registry.list().length} 个内置 Agent`)

    // 将 registry、taskBus 和 configManager 传递给执行编排器
    setAppContext({ registry, taskBus, llmRouter, configManager })

    initTaskAPI()
    logger.info('✅ Task API 初始化')

    // HTTP server（WebSocket 需要原生 http.Server）
    const server = createServer(app)
    attachWebSocketServer(server)
    logger.info('✅ WebSocket 服务已挂载 /ws/tasks')

    server.listen(PORT, () =>
      logger.info(`🚀 executor 服务启动，端口 ${PORT}`)
    )

    await startConsumer()
  } catch (err) {
    logger.error(err, '启动失败')
    process.exit(1)
  }
}

process.on('SIGTERM', async () => { await stopConsumer(); process.exit(0) })
process.on('SIGINT',  async () => { await stopConsumer(); process.exit(0) })

bootstrap()
