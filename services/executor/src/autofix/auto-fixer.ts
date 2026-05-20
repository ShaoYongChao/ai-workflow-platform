import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import {
  GeneratedFile, TestRunResult, FixAttempt, FixStrategy, FeatureSpec
} from '../schemas/types'
import { extractFilesFromOutput } from './file-extractor'
import { summarizeErrors } from './error-summarizer'
import { logger } from '../utils/logger'

const MAX_FIX_ATTEMPTS = 3

// ── 修复策略配置 ─────────────────────────────────────────────
const STRATEGIES: Record<number, { strategy: FixStrategy; instruction: string }> = {
  1: {
    strategy: 'direct_fix',
    instruction: '直接根据错误信息修复代码。保持原有架构不变，只修改有问题的部分。'
  },
  2: {
    strategy: 'rethink_then_fix',
    instruction: '先分析失败根因（可能是逻辑错误或接口理解偏差），重新思考实现方案后再修复。特别注意边界条件和并发安全。'
  },
  3: {
    strategy: 'simplify_then_fix',
    instruction: '简化实现：去掉不必要的复杂逻辑，用最直接的方式实现功能。确保每个测试用例都有对应的代码路径。'
  }
}

// ── Auto-Fix 主函数 ──────────────────────────────────────────
export async function autoFix(
  attempt: number,
  spec: FeatureSpec,
  currentFiles: GeneratedFile[],
  testResults: TestRunResult[]
): Promise<FixAttempt> {
  const start        = Date.now()
  const { strategy, instruction } = STRATEGIES[attempt] || STRATEGIES[3]
  const errorSummary = summarizeErrors(testResults)

  logger.info({ attempt, strategy, errorLen: errorSummary.length }, `Auto-Fix 第 ${attempt} 次`)

  const { system, user } = buildFixPrompt(spec, currentFiles, errorSummary, instruction)

  let fixedFiles: GeneratedFile[] = []
  let success = false

  try {
    const content = await callLLM(system, user)
    fixedFiles = extractFilesFromOutput(content)

    if (fixedFiles.length === 0) {
      logger.warn({ attempt }, 'Auto-Fix LLM 输出未解析到文件，保持原文件')
      fixedFiles = currentFiles
    } else {
      // 合并：用修复后的文件替换原文件，未修改的保留
      fixedFiles = mergeFiles(currentFiles, fixedFiles)
      success = true
      logger.info({ attempt, fixedCount: fixedFiles.length }, 'Auto-Fix 文件解析完成')
    }
  } catch (err) {
    logger.error({ attempt, err }, 'Auto-Fix LLM 调用失败，保持原文件')
    fixedFiles = currentFiles
  }

  return {
    attempt,
    strategy,
    errorSummary,
    fixedFiles,
    testResult: testResults[testResults.length - 1],  // 最后一次测试结果
    success,
    durationMs: Date.now() - start
  }
}

// ── 构建修复 Prompt ──────────────────────────────────────────
function buildFixPrompt(
  spec: FeatureSpec,
  files: GeneratedFile[],
  errorSummary: string,
  instruction: string
): { system: string; user: string } {
  const system = `你是一名资深工程师，专门修复自动生成代码中的问题。
你只需输出修改过的文件，未改动的文件不要重复输出。

## 输出格式（严格遵守）
### FILE: <文件路径>
\`\`\`<语言>
<修复后的完整文件内容>
\`\`\`

## 修复原则
- ${instruction}
- 不改动已通过测试的文件
- 保持接口签名不变（测试依赖它）
- 错误处理必须完整
- 禁止 Magic Number`

  // 只把失败相关的文件发给 LLM（节省 token）
  const failedLangs = new Set(
    files.filter(f => f.role === 'test'
      ? false  // test 文件通常不改
      : true
    ).map(f => f.language)
  )

  const relevantFiles = files
    .filter(f => failedLangs.has(f.language))
    .map(f => `### FILE: ${f.path}\n\`\`\`${f.language}\n${f.content}\n\`\`\``)
    .join('\n\n')

  const user = `## 需求 Spec
标题: ${spec.title}
验收标准:
${spec.acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n')}

## 当前代码
${relevantFiles}

## 测试失败信息
${errorSummary}

## 任务
请修复上述问题，只输出修改了的文件。`

  return { system, user }
}

// ── 合并文件：修复后的覆盖原有的，其余保留 ─────────────────
function mergeFiles(original: GeneratedFile[], fixed: GeneratedFile[]): GeneratedFile[] {
  const fixedMap = new Map(fixed.map(f => [f.path, f]))
  return original.map(f => fixedMap.get(f.path) || f)
}

// ── LLM 调用 ────────────────────────────────────────────────
async function callLLM(system: string, user: string): Promise<string> {
  const provider = process.env.LLM_PROVIDER || 'anthropic'

  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const res = await client.messages.create({
      model: process.env.LLM_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      temperature: 0.1,  // 修复时要更确定性
      system,
      messages: [{ role: 'user', content: user }]
    })
    return res.content.filter(b => b.type === 'text').map(b => (b as any).text).join('')
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const res = await client.chat.completions.create({
    model: process.env.LLM_MODEL || 'gpt-4-turbo-preview',
    max_tokens: 8192,
    temperature: 0.1,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
  })
  return res.choices[0]?.message?.content || ''
}