import express from 'express'
import { createServer } from 'http'
import cors from 'cors'
import { logger } from './utils/logger'
import { initDB, initRedis } from './services/result-store'
import { startConsumer, stopConsumer } from './consumers/code-consumer'
import { taskApiRouter, specApiRouter, initTaskAPI } from './routes/task-api'
import { attachWebSocketServer } from './services/websocket-server'
import 'dotenv/config'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { tenantMiddleware } = require('../../../gateway/tenant-middleware')

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
