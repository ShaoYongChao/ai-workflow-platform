/**
 * services/agents/base/agent.ts
 *
 * Agent 基类
 *
 * 核心设计原则：
 *   - 每个 Agent 只做一件事（单一职责）
 *   - Agent 之间通过 TaskBus 通信，不直接调用
 *   - 技能（Skill）是 Agent 能力的最小单元，可组合复用
 *   - Agent 支持流式输出、重试、超时、评分
 *
 * 继承示例：
 *   class GoCodeAgent extends BaseAgent {
 *     name = 'go-code-agent'
 *     skills = [goGeneratorSkill, goLinterSkill]
 *     async execute(task) { ... }
 *   }
 */

import { EventEmitter } from 'events'

// ── 核心类型 ──────────────────────────────────────────────────

export type AgentStatus = 'idle' | 'running' | 'done' | 'failed' | 'cancelled'

export interface AgentContext {
  taskId:      string
  specId:      string
  projectId:   string
  developerId: string
  spec:        Record<string, any>       // FeatureSpec
  retrieval:   Record<string, any>       // RetrievalContext
  memory:      Record<string, any>       // 从记忆系统注入
  prevOutputs: Record<string, AgentOutput> // 上游 Agent 的输出
  config:      AgentConfig
}

export interface AgentOutput {
  agentName:   string
  status:      AgentStatus
  data:        Record<string, any>       // 任意结构化输出
  files?:      GeneratedFile[]
  metadata:    {
    durationMs:    number
    tokensUsed?:   number
    retries:       number
    skillsUsed:    string[]
  }
  error?:      string
}

export interface AgentConfig {
  maxRetries:   number
  timeoutMs:    number
  temperature:  number
  model:        string
  domain:       DomainConfig            // 领域特定配置（游戏/客服/公文等）
}

export interface DomainConfig {
  name:         string                  // 'game' | 'customer-service' | 'document' | ...
  language:     string[]                // 目标编程语言
  framework?:   string                  // 框架约束
  conventions:  string[]               // 领域规范
  outputFormat: string                  // 'code' | 'document' | 'analysis' | ...
}

export interface GeneratedFile {
  path:     string
  language: string
  content:  string
  role:     string
}

// ── Skill 接口 ────────────────────────────────────────────────

export interface Skill {
  name:        string
  description: string
  execute(ctx: AgentContext, input: any): Promise<any>
}

// ── Agent 基类 ────────────────────────────────────────────────

export abstract class BaseAgent extends EventEmitter {
  abstract readonly name: string
  abstract readonly description: string
  abstract readonly domain: string        // 所属领域，'*' = 通用
  abstract readonly skills: Skill[]

  protected status: AgentStatus = 'idle'
  protected retryCount = 0

  // 子类必须实现
  abstract execute(ctx: AgentContext): Promise<AgentOutput>

  // ── 带重试和超时的执行入口 ────────────────────────────────
  async run(ctx: AgentContext): Promise<AgentOutput> {
    const start     = Date.now()
    const maxRetries = ctx.config.maxRetries ?? 3
    const timeout    = ctx.config.timeoutMs  ?? 120_000

    this.status = 'running'
    this.emit('start', { agentName: this.name, taskId: ctx.taskId })

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        const result = await Promise.race([
          this.execute(ctx),
          this.timeoutPromise(timeout)
        ])

        this.status = 'done'
        const output: AgentOutput = {
          ...result,
          agentName: this.name,
          status:    'done',
          metadata:  {
            ...result.metadata,
            durationMs: Date.now() - start,
            retries:    attempt - 1,
            skillsUsed: result.metadata?.skillsUsed ?? this.skills.map(s => s.name)
          }
        }

        this.emit('done', output)
        return output

      } catch (err) {
        const isLast = attempt > maxRetries
        this.emit('retry', { attempt, error: (err as Error).message })

        if (isLast) {
          this.status = 'failed'
          const failOutput: AgentOutput = {
            agentName: this.name,
            status:    'failed',
            data:      {},
            error:     (err as Error).message,
            metadata:  { durationMs: Date.now() - start, retries: attempt - 1, skillsUsed: [] }
          }
          this.emit('failed', failOutput)
          return failOutput
        }

        // 指数退避
        await sleep(Math.min(1000 * Math.pow(2, attempt - 1), 8000))
      }
    }

    // 不会到这里，满足 TS 类型检查
    throw new Error('unreachable')
  }

  // ── 取消 ──────────────────────────────────────────────────
  cancel(): void {
    this.status = 'cancelled'
    this.emit('cancelled', { agentName: this.name })
  }

  getStatus(): AgentStatus { return this.status }

  private timeoutPromise(ms: number): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Agent ${this.name} 超时 (${ms}ms)`)), ms)
    )
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }
