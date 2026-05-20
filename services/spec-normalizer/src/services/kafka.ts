import { Kafka, Producer } from 'kafkajs'
import { logger } from '../utils/logger'
import { FeatureSpec } from '../schemas/types'

let producer: Producer

export async function initKafka() {
  const kafka = new Kafka({
    clientId: 'spec-normalizer',
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(',')
  })
  producer = kafka.producer()
  await producer.connect()
}

export async function publishSpecSubmitted(specId: string, spec: FeatureSpec, projectId = 'default') {
  // 确保 languages 字段存在（向后兼容）
  const finalSpec = {
    ...spec,
    languages: spec.languages || ['go', 'typescript']
  }

  await producer.send({
    topic: 'spec.submitted',
    messages: [{
      key: specId,
      value: JSON.stringify({ specId, spec: finalSpec, projectId, timestamp: Date.now() })
    }]
  })
  logger.info({ specId, projectId, languages: finalSpec.languages, topic: 'spec.submitted' }, 'Kafka 消息已发布')
}