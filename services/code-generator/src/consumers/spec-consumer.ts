import { Kafka, Consumer, Producer, EachMessagePayload } from 'kafkajs'
import Redis from 'ioredis'
import { Express } from 'express'
import { SpecSubmittedPayload, GenerationResult } from '../schemas/types'
import { createTask, saveResult, saveFailureSample } from '../services/task-store'
import { logger } from '../utils/logger'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DOMAIN_CONFIGS } = require('../../agents/registry/agent-registry')

let consumer: Consumer
let producer: Producer
let wsPublisher: Redis
let app: Express | null = null
let registry: any = null  // AgentRegistry
let taskBus: any = null   // TaskBus
let llmRouter: any = null // LLMRouter

// ── Topic 定义 ──────────────────────────────────────────────
const TOPICS = {
  SPEC_SUBMITTED: 'spec.submitted',      // 消费：接收新需求
  CODE_GENERATED: 'code.generated',      // 生产：通知执行层
  CODE_FAILED: 'code.generation.failed'  // 生产：记录失败
} as const

// ── 初始化消费者引用（由 index.ts 调用）────────────────────
export function setAppContext(express: Express) {
  app = express
  registry = express.locals.agentRegistry
  taskBus = express.locals.taskBus
  llmRouter = express.locals.llmRouter
}

// ── 根据 Spec 语言确定领域配置 ────────────────────────────
function determineDomain(specLanguages?: string[]): { domainKey: string; config: typeof DOMAIN_CONFIGS[keyof typeof DOMAIN_CONFIGS] } {
  const langs = (specLanguages || ['go', 'typescript']).sort()
  const langSet = new Set(langs)

  // 根据语言组合选择合适的领域
  if (langSet.has('csharp')) {
    return { domainKey: 'game-full', config: DOMAIN_CONFIGS['game-full'] }
  }
  if (langSet.has('python')) {
    return { domainKey: 'customer-service', config: DOMAIN_CONFIGS['customer-service'] }
  }
  // 默认：Go + TypeScript 组合
  return { domainKey: 'game-server', config: DOMAIN_CONFIGS['game-server'] }
}

// ── 初始化 ──────────────────────────────────────────────────
export async function startConsumer(appContext?: Express) {
  // 如果提供了 Express 应用，设置上下文
  if (appContext) {
    setAppContext(appContext)
  }

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
        // 核心：使用 Agent 流水线替代直接的 generateCode() 调用（Phase 4.1）
        if (!registry || !taskBus) {
          throw new Error('Agent system not initialized')
        }

        const { domainKey, config: domainConfig } = determineDomain(spec.languages)

        // 构建 Agent 上下文
        const agentContext: any = {
          taskId,
          specId,
          projectId: projectId || 'default',
          developerId: 'system',  // 从 Kafka 消息提取，暂使用默认值
          spec: spec as any,
          retrieval: {},  // SpecAnalysisAgent 会提供检索上下文
          memory: {},     // MemoryInjectSkill 会填充
          prevOutputs: {},
          config: {
            maxRetries: 2,
            timeoutMs: 120000,
            temperature: 0.2,
            model: process.env.DEFAULT_LLM_MODEL || 'claude-sonnet-4',
            domain: domainConfig
          }
        }

        // 构建和执行流水线
        const pipeline = registry.buildPipeline(domainKey, 'standard')
        const pipelineStart = Date.now()

        const pipelineResult = await taskBus.run({
          id: taskId,
          nodes: pipeline,
          context: agentContext,
          onProgress: (event: any) => {
            logger.debug({ taskId, agentName: event.agentName, status: event.status }, '流水线进度')
          }
        })

        // 转换流水线结果为 GenerationResult
        const codegenOutput = pipelineResult.outputs['codegen-agent']
        if (!codegenOutput) {
          throw new Error('CodeGen Agent 未执行或未生成输出')
        }

        const result: GenerationResult = {
          taskId,
          specId,
          spec,
          files: codegenOutput.files || [],
          status: pipelineResult.status === 'success' ? 'success' : 'failed',
          error: codegenOutput.error,
          durationMs: pipelineResult.totalDurationMs,
          model: agentContext.config.model,
          promptTokens: 0,    // 由各 Skill 累计
          completionTokens: 0,
          usedChunks: (codegenOutput.data?.usedChunks as any) || []
        }

        // 累计各 Agent 的 Token 使用
        for (const agentOutput of Object.values(pipelineResult.outputs) as any[]) {
          if ((agentOutput as any).metadata?.tokensUsed) {
            // Token 统计暂不细分
          }
        }

        // 保存结果
        await saveResult(taskId, result)

        if (result.status === 'success') {
          try { const m = require('../metrics'); m.generationTotal?.inc({ status: 'success' }); m.generationDuration?.observe((Date.now() - genStart) / 1000) } catch {}
          // 推送到执行层（executor 服务消费此 topic）
          await publishCodeGenerated(taskId, result, projectId)

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
async function publishCodeGenerated(taskId: string, result: GenerationResult, projectId = 'default') {
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
        projectId,
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