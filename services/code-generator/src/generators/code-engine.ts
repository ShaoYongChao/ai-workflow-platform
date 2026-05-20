import { FeatureSpec, GenerationResult, GeneratedFile, RetrievalContext } from '../schemas/types'
import { callLLM } from '../services/llm-client'
import { retrieveContext } from '../services/retrieval'
import { buildGoGeneratorPrompt } from '../prompts/go-generator'
import { buildTSGeneratorPrompt } from '../prompts/ts-generator'
import { extractFilesFromLLMOutput, validateGoFile, validateTSFile } from '../utils/code-parser'
import { logger } from '../utils/logger'
import Redis from 'ioredis'

const MAX_RETRIES = 3

// ── Redis 进度广播（懒加载，不阻塞主流程） ───────────────────
let _redis: Redis | null = null
function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')
    _redis.on('error', () => { /* 进度广播失败不影响生成 */ })
  }
  return _redis
}

async function broadcastLog(taskId: string, stage: string, detail?: any) {
  try {
    await getRedis().publish('task:log', JSON.stringify({
      taskId, stage, detail, timestamp: Date.now()
    }))
  } catch { /* 静默，不阻塞生成 */ }
}

// ── 入口：生成一个 Spec 对应的全部代码 ─────────────────────
export async function generateCode(
  taskId: string,
  specId: string,
  spec: FeatureSpec,
  projectId?: string
): Promise<GenerationResult> {
  const start = Date.now()
  logger.info({ taskId, specId, title: spec.title, projectId }, '开始代码生成')
  await broadcastLog(taskId, 'gen_start', { title: spec.title })

  // 1. 检索上下文（KB + 项目历史记忆）
  await broadcastLog(taskId, 'kb_searching', { message: '正在检索知识库和历史记忆...' })
  const context = await retrieveContext(spec, projectId)
  await broadcastLog(taskId, 'kb_retrieved', {
    chunks:     context.usedChunks?.length || 0,
    interfaces: context.relatedInterfaces?.length || 0
  })
  logger.info({ taskId, interfaceCount: context.relatedInterfaces.length }, '检索上下文完成')

  // 2. 判断需要生成哪些端
  const needsServer = spec.platform.includes('server')
  const needsClient = spec.platform.includes('client')

  // 3. 并发生成（Go 和 TS 可同时跑，互不依赖）
  if (needsServer) await broadcastLog(taskId, 'generating_server', { language: 'Go', message: '正在生成服务端 Go 代码...' })
  if (needsClient) await broadcastLog(taskId, 'generating_client', { language: 'TypeScript', message: '正在生成客户端 TS 代码...' })

  const tasks: Promise<GeneratedFile[]>[] = []
  if (needsServer) tasks.push(generateWithRetry('go', spec, context, taskId))
  if (needsClient) tasks.push(generateWithRetry('typescript', spec, context, taskId))

  const results = await Promise.allSettled(tasks)

  // 4. 收集结果
  const allFiles: GeneratedFile[] = []
  let totalPromptTokens = 0
  let totalCompletionTokens = 0
  const errors: string[] = []

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allFiles.push(...result.value)
    } else {
      errors.push(result.reason?.message || '未知错误')
      logger.error({ taskId, error: result.reason }, '某端生成失败')
    }
  }

  const status = allFiles.length > 0 ? 'success' : 'failed'
  const durationMs = Date.now() - start

  if (status === 'success') {
    const goFiles = allFiles.filter(f => f.language === 'go').length
    const tsFiles = allFiles.filter(f => f.language === 'typescript').length
    await broadcastLog(taskId, 'code_ready', {
      fileCount: allFiles.length,
      goFiles, tsFiles, durationMs,
      message: `代码生成完成，共 ${allFiles.length} 个文件，正在转交执行层测试...`
    })
  } else {
    await broadcastLog(taskId, 'gen_failed', { errors, durationMs })
  }

  logger.info({
    taskId,
    status,
    fileCount: allFiles.length,
    durationMs,
    errors: errors.length
  }, '代码生成完成')

  return {
    taskId,
    specId,
    spec,
    files: allFiles,
    status,
    error: errors.length > 0 ? errors.join('; ') : undefined,
    durationMs,
    model: process.env.LLM_MODEL || 'claude-sonnet-4-20250514',
    promptTokens: totalPromptTokens,
    completionTokens: totalCompletionTokens,
    usedChunks: context.usedChunks
  }
}

// ── 带重试的生成（不同重试策略） ───────────────────────────
async function generateWithRetry(
  target: 'go' | 'typescript',
  spec: FeatureSpec,
  context: RetrievalContext,
  taskId: string
): Promise<GeneratedFile[]> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info({ taskId, target, attempt }, '生成尝试')

      const files = target === 'go'
        ? await generateGoFiles(spec, context, attempt)
        : await generateTSFiles(spec, context, attempt)

      // 验证生成文件质量
      const issues = validateFiles(files)
      if (issues.length > 0 && attempt < MAX_RETRIES) {
        logger.warn({ taskId, target, attempt, issues }, '文件验证发现问题，重试')
        // 把问题反馈给下一轮 prompt（通过修改 context）
        context = {
          ...context,
          conventions: [
            ...context.conventions,
            `// 上次生成存在以下问题，本次必须修复：${issues.join('；')}`
          ]
        }
        continue
      }

      return files
    } catch (err) {
      lastError = err as Error
      logger.error({ taskId, target, attempt, err }, '生成失败')

      if (attempt < MAX_RETRIES) {
        const delay = attempt * 2000 // 指数退避：2s, 4s
        logger.info({ delay }, `等待 ${delay}ms 后重试`)
        await sleep(delay)
      }
    }
  }

  throw lastError || new Error(`${target} 代码生成失败，已重试 ${MAX_RETRIES} 次`)
}

// ── Go 服务端生成 ───────────────────────────────────────────
async function generateGoFiles(
  spec: FeatureSpec,
  context: RetrievalContext,
  attempt: number
): Promise<GeneratedFile[]> {
  const { system, user } = buildGoGeneratorPrompt(spec, context)

  // 第2次重试：加强测试覆盖要求
  // 第3次重试：要求简化实现
  const augmentedUser = attempt === 2
    ? user + '\n\n[重试提示] 确保每个验收标准都有对应的测试用例，测试覆盖率须 ≥ 80%'
    : attempt === 3
      ? user + '\n\n[重试提示] 简化实现，专注核心业务逻辑，移除不必要的复杂度'
      : user

  const response = await callLLM({
    system,
    user: augmentedUser,
    maxTokens: 8192,
    temperature: attempt === 1 ? 0.2 : 0.1  // 重试时降低随机性
  })

  const files = extractFilesFromLLMOutput(response.content)
  if (files.length === 0) {
    throw new Error('Go 代码生成输出格式错误，未解析到任何文件')
  }

  logger.info({ fileCount: files.length, paths: files.map(f => f.path) }, 'Go 文件解析完成')
  return files
}

// ── TypeScript 客户端生成 ───────────────────────────────────
async function generateTSFiles(
  spec: FeatureSpec,
  context: RetrievalContext,
  attempt: number
): Promise<GeneratedFile[]> {
  const { system, user } = buildTSGeneratorPrompt(spec, context)

  const augmentedUser = attempt === 2
    ? user + '\n\n[重试提示] 确保所有 API 调用都有错误处理，Promise 必须有 catch'
    : attempt === 3
      ? user + '\n\n[重试提示] 简化实现，确保类型定义完整，不使用 any'
      : user

  const response = await callLLM({
    system,
    user: augmentedUser,
    maxTokens: 6144,
    temperature: attempt === 1 ? 0.2 : 0.1
  })

  const files = extractFilesFromLLMOutput(response.content)
  if (files.length === 0) {
    throw new Error('TS 代码生成输出格式错误，未解析到任何文件')
  }

  logger.info({ fileCount: files.length, paths: files.map(f => f.path) }, 'TS 文件解析完成')
  return files
}

// ── 质量验证 ────────────────────────────────────────────────
function validateFiles(files: GeneratedFile[]): string[] {
  const allIssues: string[] = []
  for (const file of files) {
    const result = file.language === 'go'
      ? validateGoFile(file.content)
      : validateTSFile(file.content)
    if (!result.valid) {
      allIssues.push(...result.issues.map(i => `[${file.path}] ${i}`))
    }
  }
  return allIssues
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}