import { Kafka, Producer } from 'kafkajs'
import { logger } from '../utils/logger'

let _producer: Producer | null = null

// ── 惰性初始化（第一次调用时连接，后续复用） ────────────────
export async function getSharedProducer(): Promise<Producer> {
  if (_producer) return _producer

  const brokers = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',')
  const kafka = new Kafka({
    clientId: 'code-generator-http',
    brokers,
    retry: { initialRetryTime: 3000, retries: 5 }
  })

  _producer = kafka.producer({ allowAutoTopicCreation: true, transactionTimeout: 60000 })
  await _producer.connect()
  logger.info('✅ Kafka producer (HTTP trigger) 已连接')
  return _producer
}

// ── 发布代码生成完成事件到 executor 消费 ─────────────────────
export async function publishCodeGeneratedEvent(taskId: string, result: {
  specId: string
  spec: any
  files: any[]
  durationMs: number
  model: string
}) {
  const producer = await getSharedProducer()
  await producer.send({
    topic: 'code.generated',
    messages: [{
      key:   taskId,
      value: JSON.stringify({
        taskId,
        specId:    result.specId,
        spec:      result.spec,
        files:     result.files,
        durationMs: result.durationMs,
        model:     result.model,
        timestamp: Date.now()
      })
    }]
  })
  logger.info({ taskId, fileCount: result.files.length }, '已发布 code.generated → executor')
}

export async function publishCodeFailedEvent(taskId: string, specId: string, error: string) {
  const producer = await getSharedProducer()
  await producer.send({
    topic: 'code.generation.failed',
    messages: [{
      key:   taskId,
      value: JSON.stringify({ taskId, specId, error, timestamp: Date.now() })
    }]
  })
}
