import { Kafka, Consumer, Producer, EachMessagePayload } from 'kafkajs'
import Redis from 'ioredis'
import { CodeGeneratedPayload } from '../schemas/types'
import { executeAndTest } from '../services/execution-orchestrator'
import { saveExecutionResult, markTaskError } from '../services/result-store'
import { logger } from '../utils/logger'

let consumer: Consumer
let producer: Producer
let wsPublisher: Redis

const TOPICS = {
  CODE_GENERATED:  'code.generated',    // 消费
  CODE_TESTED:     'code.tested',       // 生产：测试通过
  MANUAL_REVIEW:   'code.manual_review' // 生产：需要人工审查
} as const

export async function startConsumer() {
  const brokers = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',')
  const kafka   = new Kafka({
    clientId: 'executor',
    brokers,
    retry: { initialRetryTime: 3000, retries: 5 }
  })

  consumer = kafka.consumer({
    groupId: 'executor-group',
    // sessionTimeout 必须小于 broker group.max.session.timeout.ms（默认 300000）
    // 设为 30s：broker 在 30s 无心跳后才踢出成员，rebalance 更快
    sessionTimeout: 30000,
    // rebalanceTimeout：成员重新加入的等待窗口，给执行中的任务留出时间
    rebalanceTimeout: 60000,
    // heartbeatInterval 应为 sessionTimeout 的 1/3 以下，保证 2 次心跳失败后才超时
    heartbeatInterval: 3000,
    // 每次最多拉取 1 条消息：执行任务耗时长，避免批量积压
    maxBytesPerPartition: 1048576,
  })
  producer = kafka.producer({ allowAutoTopicCreation: true })

  // WebSocket 推送（通知 VS Code 插件）
  wsPublisher = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')
  wsPublisher.on('error', (err) => logger.error(err, 'WebSocket Redis 连接错误'))

  await consumer.connect()
  await producer.connect()
  await consumer.subscribe({ topic: TOPICS.CODE_GENERATED, fromBeginning: false })

  logger.info({ topic: TOPICS.CODE_GENERATED }, '⚙️  executor 消费者已启动')

  await consumer.run({
    eachMessage: async ({ message }: EachMessagePayload) => {
      if (!message.value) return

      let payload: CodeGeneratedPayload
      try {
        payload = JSON.parse(message.value.toString())
      } catch {
        logger.error('消息解析失败')
        return
      }

      const { taskId, specId } = payload
      logger.info({ taskId, specId, title: payload.spec.title }, '📥 收到代码生成任务')

      try {
        // 执行测试 + Auto-Fix
        const result = await executeAndTest(payload)

        // 持久化
        await saveExecutionResult(result)

        // 推送到下游
        if (result.status === 'test_pass') {
          await producer.send({
            topic: TOPICS.CODE_TESTED,
            messages: [{
              key: taskId,
              value: JSON.stringify({
                taskId, specId,
                status: 'pass',
                files: result.finalFiles,
                testResults: result.testResults,
                fixAttempts: result.fixAttempts.length,
                autoFixSucceeded: result.autoFixSucceeded,
                timestamp: Date.now()
              })
            }]
          })
          logger.info({ taskId }, '✅ 测试通过，已推送 code.tested')

          // 推送 WebSocket 消息：任务完成（测试通过）
          await wsPublisher.publish('task:update', JSON.stringify({
            taskId,
            specId,
            status: 'test_pass',
            fixAttempts: result.fixAttempts.length,
            timestamp: Date.now()
          }))

        } else {
          await producer.send({
            topic: TOPICS.MANUAL_REVIEW,
            messages: [{
              key: taskId,
              value: JSON.stringify({
                taskId, specId,
                reason: `Auto-Fix ${result.fixAttempts.length} 次后仍失败`,
                files: result.finalFiles,
                testResults: result.testResults,
                timestamp: Date.now()
              })
            }]
          })
          logger.warn({ taskId }, '⚠️  已推送 manual_review')

          // 推送 WebSocket 消息：任务完成（需要人工审查）
          await wsPublisher.publish('task:update', JSON.stringify({
            taskId,
            specId,
            status: 'manual_review',
            fixAttempts: result.fixAttempts.length,
            timestamp: Date.now()
          }))
        }

      } catch (err) {
        const errMsg = (err as Error).message || '未知错误'
        logger.error({ taskId, err }, '执行流程异常')

        // 持久化 error 状态到 DB（避免任务永远停在 running）
        await markTaskError(taskId, errMsg)

        // markTaskError 已经发布了 task:update，这里补充 specId 信息
        await wsPublisher.publish('task:update', JSON.stringify({
          taskId,
          specId,
          status: 'error',
          error: errMsg,
          timestamp: Date.now()
        }))
      }
    }
  })
}

export async function stopConsumer() {
  await consumer?.disconnect()
  await producer?.disconnect()
  if (wsPublisher) {
    wsPublisher.disconnect()
  }
}