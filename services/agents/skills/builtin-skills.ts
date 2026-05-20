/**
 * services/agents/skills/builtin-skills.ts
 *
 * 内置技能库（Builtin Skills）
 *
 * Skill 是 Agent 能力的最小单元：
 *   - 无状态，纯函数风格
 *   - 可跨 Agent 复用（如 lintSkill 在 Go Agent 和 TS Agent 都用）
 *   - 可被外部注册覆盖（插件机制）
 */

import { Skill, AgentContext } from '../base/agent'

// ── LLM 调用 Skill（所有生成类 Agent 共用） ──────────────────

export const llmCallSkill: Skill = {
  name: 'llm-call',
  description: '调用 LLM API 生成内容（Anthropic/OpenAI 统一封装）',
  async execute(ctx: AgentContext, input: { system: string; user: string; maxTokens?: number }) {
    const provider = process.env.LLM_PROVIDER || 'anthropic'
    const model    = ctx.config.model || process.env.LLM_MODEL || 'claude-sonnet-4-20250514'

    if (provider === 'anthropic') {
      const Anthropic = require('@anthropic-ai/sdk')
      const client    = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY })
      const res = await client.messages.create({
        model,
        max_tokens: input.maxTokens || 8192,
        temperature: ctx.config.temperature ?? 0.2,
        system: input.system,
        messages: [{ role: 'user', content: input.user }]
      })
      return {
        content: res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''),
        tokens:  res.usage.input_tokens + res.usage.output_tokens,
        model
      }
    }

    // OpenAI fallback
    const OpenAI = require('openai')
    const client = new OpenAI.default({ apiKey: process.env.OPENAI_API_KEY })
    const res = await client.chat.completions.create({
      model: model || 'gpt-4-turbo-preview',
      max_tokens: input.maxTokens || 8192,
      temperature: ctx.config.temperature ?? 0.2,
      messages: [{ role: 'system', content: input.system }, { role: 'user', content: input.user }]
    })
    return {
      content: res.choices[0]?.message?.content || '',
      tokens:  res.usage?.total_tokens || 0,
      model
    }
  }
}

// ── 代码文件解析 Skill ────────────────────────────────────────

export const fileParserSkill: Skill = {
  name: 'file-parser',
  description: '从 LLM 输出中解析 ### FILE: 格式的代码文件',
  async execute(_ctx: AgentContext, input: { raw: string }) {
    const files: any[] = []
    const pattern = /###\s*FILE:\s*([^\n]+)\n```(\w+)\n([\s\S]*?)```/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(input.raw)) !== null) {
      const [, filePath, lang, content] = match
      files.push({
        path:     filePath.trim(),
        language: lang.toLowerCase().includes('go') ? 'go'
                : lang.toLowerCase().includes('cs') ? 'csharp'
                : 'typescript',
        content:  content.trim(),
        role:     inferRole(filePath.trim())
      })
    }
    return { files, count: files.length }
  }
}

// ── 代码质量静态分析 Skill ────────────────────────────────────

export const staticAnalysisSkill: Skill = {
  name: 'static-analysis',
  description: '对生成代码做基础静态分析（无需编译器）',
  async execute(_ctx: AgentContext, input: { files: any[] }) {
    const issues: string[] = []
    for (const file of input.files) {
      const c = file.content
      if (file.language === 'go') {
        if (!c.includes('package '))   issues.push(`[${file.path}] 缺少 package 声明`)
        if (c.includes('panic('))      issues.push(`[${file.path}] 包含 panic()，应用层代码禁止使用`)
        const magic = c.match(/\b[0-9]{3,}\b/g)
        if (magic && magic.length > 3) issues.push(`[${file.path}] 疑似 Magic Number: ${magic.slice(0,3).join(',')}`)
      }
      if (file.language === 'typescript' || file.language === 'csharp') {
        if (c.split(': any').length > 4) issues.push(`[${file.path}] 过多 any 类型`)
      }
      if (file.language === 'csharp') {
        if (!c.includes('namespace ')) issues.push(`[${file.path}] 缺少 namespace 声明`)
      }
    }
    const testFiles = input.files.filter(f => f.role === 'test')
    return {
      issues,
      hasTests:      testFiles.length > 0,
      testFileCount: testFiles.length,
      quality:       issues.length === 0 ? 100 : Math.max(0, 100 - issues.length * 15)
    }
  }
}

// ── 知识库检索 Skill ──────────────────────────────────────────

export const knowledgeRetrievalSkill: Skill = {
  name: 'knowledge-retrieval',
  description: '从本地知识库检索相关接口和规范（BM25 + 可选 Neo4j）',
  async execute(_ctx: AgentContext, input: { spec: any }) {
    try {
      const { retrieveContext } = require('../../code-generator/src/services/retrieval')
      return await retrieveContext(input.spec)
    } catch {
      return { relatedInterfaces: [], relatedModels: [], callGraph: [], conventions: [] }
    }
  }
}

// ── 记忆注入 Skill ────────────────────────────────────────────

export const memoryInjectSkill: Skill = {
  name: 'memory-inject',
  description: '从记忆系统检索相关历史经验注入当前上下文',
  async execute(ctx: AgentContext, input: { keywords: string[] }) {
    try {
      const { MemoryService } = require('../../memory/src/memory-service')
      const mem = new MemoryService({ postgresUrl: process.env.POSTGRES_URL, redisUrl: process.env.REDIS_URL })
      const memories  = await mem.retrieveProjectMemory(ctx.projectId, input.keywords)
      const skills    = await mem.retrieveSkills(ctx.projectId, input.keywords)
      return { memories, skills }
    } catch {
      return { memories: [], skills: [] }
    }
  }
}

// ── 辅助函数 ──────────────────────────────────────────────────

function inferRole(path: string): string {
  const p = path.toLowerCase()
  if (p.includes('_test') || p.includes('.test.') || p.includes('test.cs')) return 'test'
  if (p.includes('handler') || p.includes('controller'))  return 'handler'
  if (p.includes('service'))    return 'service'
  if (p.includes('model') || p.includes('entity') || p.includes('dto')) return 'model'
  if (p.includes('types') || p.includes('interface')) return 'types'
  if (p.includes('manager') || p.includes('presenter')) return 'client'
  return 'service'
}
