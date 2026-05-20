import { WebSocketServer, WebSocket } from 'ws'
import { Server as HTTPServer } from 'http'
import Redis from 'ioredis'
import { logger } from '../utils/logger'

// ── 订阅 Redis 频道，向所有连接的客户端广播 ────────────────
const TOPICS = {
  TASK_CREATED:  'task:created',    // 新任务创建（code-generator 发布）
  TASK_UPDATE:   'task:update',     // 任务状态变化
  TASK_DECISION: 'task:decision',   // Review 决策（accept/reject）
  LOG_STREAM:    'task:log',        // 实时执行日志
}

const clients = new Set<WebSocket>()

export function attachWebSocketServer(server: HTTPServer) {
  const wss = new WebSocketServer({ server, path: '/ws/tasks' })

  wss.on('connection', (ws, req) => {
    const clientId = req.headers['x-client-id'] || 'anonymous'
    clients.add(ws)
    logger.info({ clientId, totalClients: clients.size }, 'VS Code 插件已连接')

    ws.send(JSON.stringify({ type: 'hello', message: 'connected to executor' }))

    // 客户端可以订阅特定任务的更新
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'subscribe' && msg.taskId) {
          (ws as any).subscribedTaskIds = (ws as any).subscribedTaskIds || new Set()
          ;(ws as any).subscribedTaskIds.add(msg.taskId)
        }
        if (msg.type === 'unsubscribe' && msg.taskId) {
          ;(ws as any).subscribedTaskIds?.delete(msg.taskId)
        }
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
        }
      } catch (err) {
        logger.warn({ err }, 'WebSocket 消息解析失败')
      }
    })

    ws.on('close', () => {
      clients.delete(ws)
      logger.info({ totalClients: clients.size }, 'VS Code 插件已断开')
    })

    ws.on('error', (err) => logger.error({ err }, 'WebSocket 错误'))
  })

  // ── 订阅 Redis pub/sub，转发到 WebSocket ──────────────────
  const subscriber = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')

  subscriber.subscribe(...Object.values(TOPICS), (err) => {
    if (err) logger.error({ err }, 'Redis 订阅失败')
    else logger.info({ topics: Object.values(TOPICS) }, '已订阅 Redis 频道')
  })

  subscriber.on('message', (channel, message) => {
    try {
      const payload = JSON.parse(message)
      const eventType = channel.replace('task:', 'task_')  // task:update → task_update

      // 广播给所有连接的客户端
      // 如果有任务订阅过滤，只发给订阅了该任务的客户端
      const event = JSON.stringify({ type: eventType, ...payload, ts: Date.now() })

      for (const client of clients) {
        if (client.readyState !== WebSocket.OPEN) continue

        const subscribed = (client as any).subscribedTaskIds as Set<string> | undefined
        if (subscribed && payload.taskId && !subscribed.has(payload.taskId)) {
          continue  // 客户端订阅了特定任务，跳过其他
        }

        client.send(event)
      }
    } catch (err) {
      logger.error({ err, channel }, 'WebSocket 广播失败')
    }
  })

  return wss
}

// ── 工具：从其他服务发布消息（供 code-consumer 调用） ──────
let publisher: Redis | null = null

export function getPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')
  }
  return publisher
}

export async function publishTaskUpdate(payload: {
  taskId: string
  status: string
  stage?: string
  message?: string
}) {
  await getPublisher().publish(TOPICS.TASK_UPDATE, JSON.stringify(payload))
}

export async function publishLog(payload: {
  taskId: string
  level: 'info' | 'warn' | 'error'
  message: string
}) {
  await getPublisher().publish(TOPICS.LOG_STREAM, JSON.stringify(payload))
}
