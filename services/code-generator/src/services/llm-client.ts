import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { logger } from '../utils/logger'

export interface LLMResponse {
  content: string
  model: string
  promptTokens: number
  completionTokens: number
}

export interface LLMCallOptions {
  system: string
  user: string
  maxTokens?: number
  temperature?: number
}

// ── 统一 LLM 调用入口 ───────────────────────────────────────
export async function callLLM(opts: LLMCallOptions): Promise<LLMResponse> {
  const provider = process.env.LLM_PROVIDER || 'anthropic'
  const { system, user, maxTokens = 8192, temperature = 0.2 } = opts

  logger.info({ provider, maxTokens }, '发起 LLM 调用')
  const start = Date.now()

  try {
    let result: LLMResponse

    if (provider === 'anthropic') {
      result = await callAnthropic(system, user, maxTokens, temperature)
    } else if (['openai','deepseek','qwen','zhipu','custom'].includes(provider)) {
      result = await callOpenAI(system, user, maxTokens, temperature)
    } else {
      throw new Error(`不支持的 LLM Provider: ${provider}`)
    }

    const elapsed = Date.now() - start
    logger.info({
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      elapsedMs: elapsed
    }, 'LLM 调用完成')

    return result
  } catch (err) {
    logger.error({ err, provider }, 'LLM 调用失败')
    throw err
  }
}

// ── Anthropic ───────────────────────────────────────────────
async function callAnthropic(
  system: string,
  user: string,
  maxTokens: number,
  temperature: number
): Promise<LLMResponse> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const model = process.env.LLM_MODEL || 'claude-sonnet-4-20250514'

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: [{ role: 'user', content: user }]
  })

  const content = response.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text as string)
    .join('\n')

  return {
    content,
    model,
    promptTokens: response.usage.input_tokens,
    completionTokens: response.usage.output_tokens
  }
}

// ── OpenAI fallback ─────────────────────────────────────────
async function callOpenAI(
  system: string,
  user: string,
  maxTokens: number,
  temperature: number
): Promise<LLMResponse> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || undefined })
  const model = process.env.LLM_MODEL || 'gpt-4-turbo-preview'

  const response = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    temperature,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  })

  return {
    content: response.choices[0]?.message?.content || '',
    model,
    promptTokens: response.usage?.prompt_tokens || 0,
    completionTokens: response.usage?.completion_tokens || 0
  }
}