import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket as WsSocket } from 'ws'
import cors from 'cors'
import helmet from 'helmet'
import { logger } from './utils/logger'
import { specRouter } from './routes/spec'
import { healthRouter } from './routes/health'
import { initKafka } from './services/kafka'
import { initDB } from './services/db'
import { DialogueService } from './services/dialogue'
import 'dotenv/config'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { tenantMiddleware } = require('../../../gateway/tenant-middleware')

const app = express()
const PORT = process.env.PORT || 3001

// ── 中间件 ──────────────────────────────────────────────────
app.use(helmet())
app.use(cors({ origin: '*' }))  // 生产环境收紧
app.use(express.json({ limit: '1mb' }))

// ── 路由 ────────────────────────────────────────────────────
app.use('/health', healthRouter)
app.use('/api/v1/specs', tenantMiddleware({ required: false }), specRouter)

// ── Prometheus 指标 ─────────────────────────────────────────
app.get('/metrics', async (_, res) => {
  try {
    const { register } = require('./metrics')
    if (!register) return res.status(503).send('# prom-client not installed\n')
    res.set('Content-Type', register.contentType)
    res.end(await register.metrics())
  } catch {
    res.status(500).send('# metrics error\n')
  }
})

// ── HTTP Server ─────────────────────────────────────────────
const server = createServer(app)

// ── WebSocket Server（实时对话流） ───────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' })

// 每个连接维护独立的 DialogueService 实例（保证多轮对话上下文不丢失）
const connectionMap = new Map<WsSocket, DialogueService>()

wss.on('connection', (ws, req) => {
  const clientId = (req.headers['x-client-id'] as string) || 'anonymous'
  // project_id 支持两种传入：URL query param（浏览器 WS 无法设请求头）或 x-project-id 请求头
  const projectId =
    new URL(req.url || '/', 'http://localhost').searchParams.get('project_id') ||
    (req.headers['x-project-id'] as string) ||
    'default'

  logger.info({ clientId, projectId }, '新 WebSocket 连接建立')
  try { const { wsConnections } = require('./metrics'); wsConnections?.inc() } catch {}

  // 为本次连接创建专属 DialogueService，整个会话共享同一实例
  const dialogueService = new DialogueService(ws, projectId)
  connectionMap.set(ws, dialogueService)

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString())
      await dialogueService.handle(msg)
    } catch (err) {
      logger.error(err, 'WebSocket 消息处理失败')
      if (ws.readyState === WsSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: '消息处理失败' }))
      }
    }
  })

  ws.on('close', () => {
    connectionMap.delete(ws)
    logger.info({ clientId }, 'WebSocket 连接关闭，会话已清理')
    try { const { wsConnections } = require('./metrics'); wsConnections?.dec() } catch {}
  })
})

// ── 启动 ────────────────────────────────────────────────────
async function bootstrap() {
  try {
    await initDB()
    logger.info('✅ 数据库连接成功')

    await initKafka()
    logger.info('✅ Kafka 连接成功')

    server.listen(PORT, () => {
      logger.info(`🚀 spec-normalizer 服务启动，端口 ${PORT}`)
    })
  } catch (err) {
    logger.error(err, '服务启动失败')
    process.exit(1)
  }
}

bootstrap()