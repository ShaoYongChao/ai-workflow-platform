/**
 * services/agents/agents/spec-agent.ts
 *
 * 需求分析 Agent
 *   职责：将白话需求转化为标准 Spec
 *   支持领域：所有领域（通用）
 *   输出：structuredSpec
 */

import { BaseAgent, AgentContext, AgentOutput, Skill } from '../base/agent'
import { llmCallSkill, memoryInjectSkill } from '../skills/builtin-skills'

export class SpecAnalysisAgent extends BaseAgent {
  readonly name        = 'spec-analysis-agent'
  readonly description = '需求分析：将自然语言需求转化为结构化 Spec'
  readonly domain      = '*'
  readonly skills: Skill[] = [llmCallSkill, memoryInjectSkill]

  async execute(ctx: AgentContext): Promise<AgentOutput> {
    const spec = ctx.spec

    // 1. 从记忆注入历史相关经验
    const memory = await memoryInjectSkill.execute(ctx, {
      keywords: [spec.title, ...(spec.entities || [])]
    })

    // 2. 构建领域感知的分析 Prompt
    const domainHints = buildDomainHints(ctx.config.domain)

    const system = `你是资深${ctx.config.domain.name}需求分析师。
将自然语言需求转化为结构化 JSON Spec，确保完整性和可测试性。
${domainHints}

历史相关经验：
${memory.memories.slice(0, 3).map((m: any) => `- ${m.title}: ${m.content.slice(0, 100)}`).join('\n') || '无'}

输出格式（严格 JSON，无多余文字）：
{
  "title": "功能名称",
  "goal": "一句话目标",
  "domain": "${ctx.config.domain.name}",
  "entities": ["Entity1"],
  "rules": { "key": "规则" },
  "api_contract": [{"name": "apiName", "type": "GET|POST"}],
  "acceptance": ["可测试的验收标准"],
  "priority": "high|medium|low",
  "domain_specific": {}
}`

    const user = `分析以下需求并输出 JSON Spec：
${JSON.stringify(spec, null, 2)}`

    const result = await llmCallSkill.execute(ctx, { system, user, maxTokens: 2048 })

    let structuredSpec: any
    try {
      const json = result.content.replace(/```json\n?|\n?```/g, '').trim()
      structuredSpec = JSON.parse(json)
    } catch {
      structuredSpec = spec  // fallback 使用原始 spec
    }

    return {
      agentName: this.name,
      status:    'done',
      data:      { structuredSpec, refined: true },
      metadata:  { durationMs: 0, tokensUsed: result.tokens, retries: 0, skillsUsed: ['llm-call', 'memory-inject'] }
    }
  }
}

function buildDomainHints(domain: any): string {
  const hints: Record<string, string> = {
    'game':             '关注游戏性、平衡性、边界条件（0/最大值）和防作弊',
    'customer-service': '关注意图识别、情绪处理、知识库引用、人工转接条件',
    'document':         '关注审批流程、权限分级、版本控制、合规性',
    'analytics':        '关注数据源、聚合规则、时间粒度、可视化要求',
    '*':                '关注功能完整性、错误处理、边界条件'
  }
  return hints[domain.name] || hints['*']
}
