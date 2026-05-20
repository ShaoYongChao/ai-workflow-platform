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

  // 2. 获取用户指定的生成语言（向后兼容）
  const languages = spec.languages || ['go', 'typescript']
  const validLanguages = ['go', 'typescript', 'csharp', 'java', 'python']
  const selectedLanguages = languages.filter(lang => validLanguages.includes(lang as any))
  const finalLanguages = selectedLanguages.length > 0 ? selectedLanguages : ['go', 'typescript']

  // 3. 为每个选中的语言并发生成
  for (const lang of finalLanguages) {
    const displayName = {
      'go': 'Go',
      'typescript': 'TypeScript',
      'csharp': 'C#',
      'java': 'Java',
      'python': 'Python'
    }[lang] || lang
    await broadcastLog(taskId, `generating_${lang}`, { language: displayName, message: `正在生成 ${displayName} 代码...` })
  }

  const tasks: Promise<GeneratedFile[]>[] = []
  for (const lang of finalLanguages) {
    tasks.push(generateWithRetry(lang as any, spec, context, taskId))
  }

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
      logger.error({ taskId, error: result.reason }, '某语言生成失败')
    }
  }

  const status = allFiles.length > 0 ? 'success' : 'failed'
  const durationMs = Date.now() - start

  if (status === 'success') {
    const languageStats: Record<string, number> = {}
    for (const lang of validLanguages) {
      const count = allFiles.filter(f => f.language === lang).length
      if (count > 0) languageStats[lang] = count
    }
    await broadcastLog(taskId, 'code_ready', {
      fileCount: allFiles.length,
      ...languageStats,
      durationMs,
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
  target: 'go' | 'typescript' | 'csharp' | 'java' | 'python',
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
        : target === 'typescript'
          ? await generateTSFiles(spec, context, attempt)
          : target === 'csharp'
            ? await generateCSharpFiles(spec, context, attempt)
            : target === 'java'
              ? await generateJavaFiles(spec, context, attempt)
              : await generatePythonFiles(spec, context, attempt)

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

// ── C# 生成 ──────────────────────────────────────────────────
async function generateCSharpFiles(
  spec: FeatureSpec,
  context: RetrievalContext,
  attempt: number
): Promise<GeneratedFile[]> {
  const systemPrompt = `你是专业的 C# 开发工程师。根据需求规格生成高质量的 C# 代码。

输出格式：每个文件独占一个 markdown 代码块，第一行是文件路径。
\`\`\`csharp:path/to/file.cs
// 代码内容
\`\`\`

要求：
- 遵循 .NET/C# 最佳实践和命名规范
- 所有公共方法都要有 XML 注释
- 使用 async/await 处理异步操作
- 包含完整的单元测试`

  const userPrompt = `需求：${spec.title}
目标：${spec.goal}

实体：${JSON.stringify(spec.entities)}
API契约：${JSON.stringify(spec.api_contract)}
业务规则：${JSON.stringify(spec.rules)}
验收标准：${JSON.stringify(spec.acceptance)}

${attempt === 2 ? '\n[重试提示] 确保类型安全，每个方法都有适当的异常处理。' : ''}
${attempt === 3 ? '\n[重试提示] 简化实现逻辑，只包含核心功能。' : ''}`

  const response = await callLLM({
    system: systemPrompt,
    user: userPrompt,
    maxTokens: 8192,
    temperature: attempt === 1 ? 0.2 : 0.1
  })

  const files = extractFilesFromLLMOutput(response.content).map(f => ({
    ...f,
    language: 'csharp' as const
  }))
  if (files.length === 0) {
    throw new Error('C# 代码生成输出格式错误，未解析到任何文件')
  }

  logger.info({ fileCount: files.length, paths: files.map(f => f.path) }, 'C# 文件解析完成')
  return files
}

// ── Java 生成 ───────────────────────────────────────────────
async function generateJavaFiles(
  spec: FeatureSpec,
  context: RetrievalContext,
  attempt: number
): Promise<GeneratedFile[]> {
  const systemPrompt = `你是专业的 Java 开发工程师。根据需求规格生成高质量的 Java 代码。

输出格式：每个文件独占一个 markdown 代码块，第一行是文件路径。
\`\`\`java:path/to/File.java
// 代码内容
\`\`\`

要求：
- 遵循 Java 命名规范和最佳实践
- 使用适当的设计模式（如工厂模式、策略模式等）
- 所有公共类和方法都要有 JavaDoc 注释
- 包含 JUnit 单元测试
- 异常处理完整，不使用 Exception 的空捕获块`

  const userPrompt = `需求：${spec.title}
目标：${spec.goal}

实体：${JSON.stringify(spec.entities)}
API契约：${JSON.stringify(spec.api_contract)}
业务规则：${JSON.stringify(spec.rules)}
验收标准：${JSON.stringify(spec.acceptance)}

${attempt === 2 ? '\n[重试提示] 确保多线程安全，使用适当的同步机制。' : ''}
${attempt === 3 ? '\n[重试提示] 简化类结构，减少继承层级。' : ''}`

  const response = await callLLM({
    system: systemPrompt,
    user: userPrompt,
    maxTokens: 8192,
    temperature: attempt === 1 ? 0.2 : 0.1
  })

  const files = extractFilesFromLLMOutput(response.content).map(f => ({
    ...f,
    language: 'java' as const
  }))
  if (files.length === 0) {
    throw new Error('Java 代码生成输出格式错误，未解析到任何文件')
  }

  logger.info({ fileCount: files.length, paths: files.map(f => f.path) }, 'Java 文件解析完成')
  return files
}

// ── Python 生成 ──────────────────────────────────────────────
async function generatePythonFiles(
  spec: FeatureSpec,
  context: RetrievalContext,
  attempt: number
): Promise<GeneratedFile[]> {
  const systemPrompt = `你是专业的 Python 开发工程师。根据需求规格生成高质量的 Python 代码。

输出格式：每个文件独占一个 markdown 代码块，第一行是文件路径。
\`\`\`python:path/to/file.py
# 代码内容
\`\`\`

要求：
- 遵循 PEP 8 风格指南
- 所有函数和类都要有清晰的 docstring
- 使用类型提示（Python 3.7+）
- 包含完整的 pytest 单元测试
- 异常处理明确，不使用空 except
- 使用虚拟环境友好的依赖管理`

  const userPrompt = `需求：${spec.title}
目标：${spec.goal}

实体：${JSON.stringify(spec.entities)}
API契约：${JSON.stringify(spec.api_contract)}
业务规则：${JSON.stringify(spec.rules)}
验收标准：${JSON.stringify(spec.acceptance)}

${attempt === 2 ? '\n[重试提示] 确保代码可读性，合理划分模块和函数。' : ''}
${attempt === 3 ? '\n[重试提示] 使用标准库，减少外部依赖。' : ''}`

  const response = await callLLM({
    system: systemPrompt,
    user: userPrompt,
    maxTokens: 8192,
    temperature: attempt === 1 ? 0.2 : 0.1
  })

  const files = extractFilesFromLLMOutput(response.content).map(f => ({
    ...f,
    language: 'python' as const
  }))
  if (files.length === 0) {
    throw new Error('Python 代码生成输出格式错误，未解析到任何文件')
  }

  logger.info({ fileCount: files.length, paths: files.map(f => f.path) }, 'Python 文件解析完成')
  return files
}

// ── 质量验证 ────────────────────────────────────────────────
function validateFiles(files: GeneratedFile[]): string[] {
  const allIssues: string[] = []
  for (const file of files) {
    const result = file.language === 'go'
      ? validateGoFile(file.content)
      : file.language === 'typescript'
        ? validateTSFile(file.content)
        : validateGenericFile(file.content, file.language)
    if (!result.valid) {
      allIssues.push(...result.issues.map(i => `[${file.path}] ${i}`))
    }
  }
  return allIssues
}

function validateGenericFile(content: string, language: string): { valid: boolean; issues: string[] } {
  const issues: string[] = []

  // 基础检查：不为空
  if (!content || content.trim().length === 0) {
    issues.push('代码为空')
    return { valid: false, issues }
  }

  // 基础检查：看起来像代码（有缩进或括号）
  if (!/[\{\}\[\]\(\):\s]{2,}/m.test(content)) {
    issues.push('代码格式可能不正确')
  }

  return { valid: issues.length === 0, issues }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}