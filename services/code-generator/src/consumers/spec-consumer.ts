import { Kafka, Consumer, Producer, EachMessagePayload } from 'kafkajs'
import Redis from 'ioredis'
import { SpecSubmittedPayload, GenerationResult } from '../schemas/types'
import { generateCode } from '../generators/code-engine'
import { createTask, saveResult, saveFailureSample } from '../services/task-store'
import { logger } from '../utils/logger'

let consumer: Consumer
let producer: Producer
let wsPublisher: Redis

// ── Topic 定义 ──────────────────────────────────────────────
const TOPICS = {
  SPEC_SUBMITTED: 'spec.submitted',      // 消费：接收新需求
  CODE_GENERATED: 'code.generated',      // 生产：通知执行层
  CODE_FAILED: 'code.generation.failed'  // 生产：记录失败
} as const

// ── 初始化 ──────────────────────────────────────────────────
export async function startConsumer() {
  const brokers = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',')

  const kafka = new Kafka({
    clientId: 'code-generator',
    brokers,
    retry: { initialRetryTime: 3000, retries: 5 }
  })

  consumer = kafka.consumer({
    groupId: 'code-generator-group',
    // 同一开发者的任务串行执行（通过 specId 作为 partition key）
    sessionTimeout: 30000,
    heartbeatInterval: 3000
  })

  producer = kafka.producer({
    allowAutoTopicCreation: true,
    transactionTimeout: 60000
  })

  // WebSocket 推送（通知 VS Code 插件）
  wsPublisher = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')
  wsPublisher.on('error', (err) => logger.error(err, 'WebSocket Redis 连接错误'))

  await consumer.connect()
  await producer.connect()

  // 订阅需求提交事件
  await consumer.subscribe({
    topic: TOPICS.SPEC_SUBMITTED,
    fromBeginning: false
  })

  logger.info({ topic: TOPICS.SPEC_SUBMITTED }, 'Kafka 消费者已启动，等待任务...')

  // ── 主消费循环 ────────────────────────────────────────────
  await consumer.run({
    // 同一 partition 内串行处理，防止同一用户任务并发
    eachMessage: async (payload: EachMessagePayload) => {
      const { topic, partition, message } = payload

      if (!message.value) {
        logger.warn({ partition }, '收到空消息，跳过')
        return
      }

      let parsed: SpecSubmittedPayload
      try {
        parsed = JSON.parse(message.value.toString())
      } catch (err) {
        logger.error({ err, raw: message.value.toString() }, '消息 JSON 解析失败')
        return
      }

      const { specId, spec, projectId } = parsed
      logger.info({ specId, title: spec.title, projectId, partition }, '收到新需求，开始处理')

      // 任务优先级：priority → P0/P1/P2
      const priorityMap: Record<string, string> = {
        high: 'P0', medium: 'P1', low: 'P2'
      }
      const priority = priorityMap[spec.priority] || 'P1'

      // 创建任务记录
      const taskId = await createTask(specId, priority)
      const genStart = Date.now()
      try { const m = require('../metrics'); m.generationTotal?.inc({ status: 'started' }) } catch {}

      // 推送 WebSocket 消息：任务已创建
      await wsPublisher.publish('task:created', JSON.stringify({
        taskId,
        specId,
        title: spec.title,
        priority,
        status: 'running',
        timestamp: Date.now()
      }))

      try {
        // 核心：调用生成引擎（携带 projectId 注入项目历史记忆）
        const result = await generateCode(taskId, specId, spec, projectId)

        // 保存结果
        await saveResult(taskId, result)

        if (result.status === 'success') {
          try { const m = require('../metrics'); m.generationTotal?.inc({ status: 'success' }); m.generationDuration?.observe((Date.now() - genStart) / 1000) } catch {}
          // 推送到执行层（executor 服务消费此 topic）
          await publishCodeGenerated(taskId, result)

          // 推送 WebSocket 消息：代码生成成功
          await wsPublisher.publish('task:update', JSON.stringify({
            taskId,
            specId,
            status: 'generated',
            fileCount: result.files.length,
            timestamp: Date.now()
          }))

          logger.info({ taskId, specId, files: result.files.length }, '✅ 代码生成成功，已推送到执行队列')
        } else {
          await publishCodeFailed(taskId, specId, result.error || '生成失败')

          // 推送 WebSocket 消息：生成失败
          await wsPublisher.publish('task:update', JSON.stringify({
            taskId,
            specId,
            status: 'error',
            error: result.error || '生成失败',
            timestamp: Date.now()
          }))
        }

      } catch (err) {
        const errorMsg = (err as Error).message
        logger.error({ taskId, specId, err }, '代码生成异常')

        // 记录失败样本
        try { const m = require('../metrics'); m.generationTotal?.inc({ status: 'failed' }) } catch {}
        await saveFailureSample(taskId, spec, errorMsg)
        await publishCodeFailed(taskId, specId, errorMsg)

        // 推送 WebSocket 消息：生成异常
        await wsPublisher.publish('task:update', JSON.stringify({
          taskId,
          specId,
          status: 'error',
          error: errorMsg,
          timestamp: Date.now()
        }))
      }
    }
  })
}

// ── 生产：通知 executor 执行测试 ────────────────────────────
async function publishCodeGenerated(taskId: string, result: GenerationResult) {
  await producer.send({
    topic: TOPICS.CODE_GENERATED,
    messages: [{
      // 用 taskId 作为 key，保证同一任务的消息在同一 partition
      key: taskId,
      value: JSON.stringify({
        taskId,
        specId: result.specId,
        spec: result.spec,
        files: result.files,
        durationMs: result.durationMs,
        model: result.model,
        timestamp: Date.now()
      })
    }]
  })
}

async function publishCodeFailed(taskId: string, specId: string, error: string) {
  await producer.send({
    topic: TOPICS.CODE_FAILED,
    messages: [{
      key: taskId,
      value: JSON.stringify({ taskId, specId, error, timestamp: Date.now() })
    }]
  })
}

// ── 优雅关闭 ────────────────────────────────────────────────
export async function stopConsumer() {
  logger.info('正在关闭 Kafka 连接...')
  await consumer.disconnect()
  await producer.disconnect()
  if (wsPublisher) {
    wsPublisher.disconnect()
  }
}