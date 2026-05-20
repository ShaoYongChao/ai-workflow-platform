import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { WebSocket } from 'ws'
import { logger } from '../utils/logger'
import { FeatureSpec, DialogueMessage, DialogueSession } from '../schemas/types'
import { getSpecRefinerPrompt } from '../prompts/spec-refiner'
import { validateSpec } from '../schemas/feature-spec'
import { getLLMProviderConfig } from './db'

const MAX_CLARIFICATION_ROUNDS = 5

// ── LLM 初始化（从数据库或环境变量） ──────────────────────
async function getLLMClient(projectId = 'default') {
  // 优先从数据库读取配置
  const dbConfig = await getLLMProviderConfig(projectId)
  if (dbConfig) {
    const apiKey = dbConfig.api_key || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY
    if (dbConfig.provider_type === 'anthropic' || dbConfig.provider_type === 'claude') {
      return new Anthropic({ apiKey })
    } else if (dbConfig.provider_type === 'openai') {
      return new OpenAI({ apiKey, baseURL: dbConfig.api_base_url })
    }
  }

  // 降级：使用环境变量配置
  const provider = process.env.LLM_PROVIDER || 'anthropic'
  if (provider === 'anthropic') {
    return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
}

export class DialogueService {
  private ws: WebSocket
  private projectId: string
  private session: DialogueSession = {
    messages: [],
    round: 0,
    currentSpec: null
  }

  constructor(ws: WebSocket, projectId = 'default') {
    this.ws = ws
    this.projectId = projectId
  }

  // ── 消息路由 ───────────────────────────────────────────────
  async handle(msg: { type: string; payload: unknown }) {
    switch (msg.type) {
      case 'user_input':
        await this.processUserInput(msg.payload as string)
        break
      case 'confirm_spec':
        await this.submitSpec(msg.payload as FeatureSpec)
        break
      case 'reset':
        this.resetSession()
        break
      default:
        this.send({ type: 'error', message: `未知消息类型: ${msg.type}` })
    }
  }

  // ── 核心：处理用户白话输入 ─────────────────────────────────
  private async processUserInput(input: string) {
    if (this.session.round >= MAX_CLARIFICATION_ROUNDS) {
      this.send({ type: 'error', message: '对话轮次已达上限，请重新开始' })
      return
    }

    // 加入对话历史
    this.session.messages.push({ role: 'user', content: input })
    this.session.round++

    try {
      // 流式调用 LLM
      await this.streamLLMResponse()
    } catch (err) {
      logger.error(err, 'LLM 调用失败')
      this.send({ type: 'error', message: 'AI 服务暂时不可用，请稍后重试' })
    }
  }

  // ── 流式 LLM 调用（支持多个提供商） ───────────────────────
  private async streamLLMResponse() {
    // 优先从数据库读取LLM配置，降级到环境变量
    const dbConfig = await getLLMProviderConfig(this.projectId)
    const provider = dbConfig?.provider_type || process.env.LLM_PROVIDER || 'anthropic'
    const apiKey = dbConfig?.api_key ||
      (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY) ||
      ''
    const baseURL = dbConfig?.api_base_url || process.env.OPENAI_BASE_URL

    const systemPrompt = getSpecRefinerPrompt()

    // 通知前端开始流式输出
    this.send({ type: 'stream_start' })

    let fullResponse = ''

    if (provider === 'anthropic' || provider === 'claude') {
      const client = new Anthropic({ apiKey })
      const stream = client.messages.stream({
        model: process.env.LLM_SPEC_MODEL || 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        system: systemPrompt,
        messages: this.session.messages as Anthropic.MessageParam[]
      })

      for await (const chunk of stream) {
        if (
          chunk.type === 'content_block_delta' &&
          chunk.delta.type === 'text_delta'
        ) {
          const text = chunk.delta.text
          fullResponse += text
          this.send({ type: 'stream_chunk', text })
        }
      }
    } else {
      // OpenAI-compatible fallback（支持 OpenAI、Qwen、DeepSeek 等）
      const client = new OpenAI({
        apiKey,
        baseURL: baseURL || undefined   // 使用从数据库或环境变量读取的 baseURL
      })
      const stream = await client.chat.completions.create({
        model: process.env.LLM_SPEC_MODEL || 'gpt-4o-mini',
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
          ...this.session.messages as OpenAI.ChatCompletionMessageParam[]
        ]
      })
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || ''
        fullResponse += text
        if (text) this.send({ type: 'stream_chunk', text })
      }
    }

    // 将 AI 回复加入历史
    this.session.messages.push({ role: 'assistant', content: fullResponse })

    // 尝试解析 Spec
    const parsedSpec = this.extractSpecFromResponse(fullResponse)
    const completeness = parsedSpec ? this.calculateCompleteness(parsedSpec) : 0

    // AI 主动声明"已完整"的信号（prompt 里要求输出 ✅ 需求信息已完整）
    const aiDeclaredComplete = fullResponse.includes('✅ 需求信息已完整')

    // canSubmit 规则：
    //  1. 至少经过 2 轮对话（防止第 1 轮就出完整模版）
    //  2. 完整度 ≥ 70%
    //  3. 没有未确认的 TBD 字段
    const hasTBD = parsedSpec ? JSON.stringify(parsedSpec).includes('TBD:') : true
    const canSubmit = this.session.round >= 2 && completeness >= 70 && !hasTBD

    this.send({
      type: 'stream_end',
      spec: parsedSpec,
      completeness,
      canSubmit,
      aiDeclaredComplete   // 供前端判断是否高亮提交按钮
    })
  }

  // ── 从 AI 回复中提取 JSON Spec ──────────────────────────────
  private extractSpecFromResponse(response: string): FeatureSpec | null {
    try {
      const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/)
      if (!jsonMatch) return null
      const parsed = JSON.parse(jsonMatch[1])
      const validation = validateSpec(parsed)
      if (!validation.success) return null
      return parsed as FeatureSpec
    } catch {
      return null
    }
  }

  // ── 计算 Spec 完整度 ────────────────────────────────────────
  private calculateCompleteness(spec: Partial<FeatureSpec>): number {
    const requiredFields: (keyof FeatureSpec)[] = [
      'title', 'goal', 'platform', 'rules', 'entities', 'api_contract', 'acceptance'
    ]

    // 字段存在性得分
    const filled = requiredFields.filter(f => {
      const val = spec[f]
      return val !== undefined && val !== null &&
        (Array.isArray(val) ? val.length > 0 : Object.keys(val as object).length > 0)
    })
    const fieldScore = Math.round((filled.length / requiredFields.length) * 100)

    // TBD 扣分：每个 TBD 项减 15%，最多扣到 30%
    const specStr = JSON.stringify(spec)
    const tbdCount = (specStr.match(/TBD:/g) || []).length
    const tbdPenalty = Math.min(tbdCount * 15, 70)

    // 轮次限制：第 1 轮最高显示 40%（哪怕 AI 给了完整 JSON，也不骗策划说已完整）
    const roundCap = this.session.round === 1 ? 40 : 100

    return Math.min(roundCap, Math.max(0, fieldScore - tbdPenalty))
  }

  // ── 提交最终 Spec ───────────────────────────────────────────
  private async submitSpec(spec: FeatureSpec) {
    const { saveSpec } = await import('./db')
    const saved = await saveSpec({
      title: spec.title,
      rawInput: this.session.messages[0]?.content as string || '',
      structuredSpec: spec,
      completenessScore: this.calculateCompleteness(spec)
    })

    // 发送到 Kafka，触发后续生成流程
    const { publishSpecSubmitted } = await import('./kafka')
    await publishSpecSubmitted(saved.id, spec, this.projectId)

    this.send({ type: 'spec_submitted', specId: saved.id })
    logger.info({ specId: saved.id }, 'Spec 已提交并推送到生成队列')
  }

  private resetSession() {
    this.session = { messages: [], round: 0, currentSpec: null }
    this.send({ type: 'session_reset' })
  }

  private send(data: object) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }
}