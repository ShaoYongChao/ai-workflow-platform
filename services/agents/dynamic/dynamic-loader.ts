/**
 * services/agents/dynamic/dynamic-loader.ts
 *
 * 动态 Skill/Agent 加载器
 *
 * 从 skill_definitions / agent_definitions 表读取配置，
 * 在运行时构建可执行的 Skill 和 Agent 对象。
 * 新增 Skill/Agent 完全不需要改代码，只需在 DB 写一行。
 */

import { Pool }        from 'pg'
import { Skill, BaseAgent, AgentContext, AgentOutput } from '../base/agent'
import { LLMRouter }   from './llm-router'

// ── 变量插值：{{spec.title}} → 实际值 ────────────────────────
function interpolate(template: string, vars: Record<string, any>): string {
  return template.replace(/\{\{([\w.]+)\}\}/g, (_, path) => {
    const keys  = path.split('.')
    let val: any = vars
    for (const k of keys) val = val?.[k]
    if (val === undefined || val === null) return `{{${path}}}`
    return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val)
  })
}

// ── 动态 Skill 工厂 ───────────────────────────────────────────
export class DynamicSkillFactory {
  constructor(
    private pool:   Pool,
    private router: LLMRouter
  ) {}

  // 从数据库构建一个 Skill 实例
  async buildSkill(skillName: string): Promise<Skill> {
    const r = await this.pool.query(
      `SELECT * FROM skill_definitions WHERE name = $1 AND enabled = true`,
      [skillName]
    )
    if (r.rows.length === 0) throw new Error(`Skill "${skillName}" 不存在或已禁用`)
    return this.rowToSkill(r.rows[0])
  }

  // 批量加载
  async buildSkills(names: string[]): Promise<Skill[]> {
    const r = await this.pool.query(
      `SELECT * FROM skill_definitions WHERE name = ANY($1) AND enabled = true`,
      [names]
    )
    return r.rows.map(row => this.rowToSkill(row))
  }

  // 列出所有可用 Skill
  async listSkills(projectId?: string): Promise<any[]> {
    const r = await this.pool.query(
      `SELECT id, name, display_name, description, category, executor_type, enabled, is_builtin, project_id
       FROM skill_definitions
       WHERE enabled = true AND (project_id IS NULL OR project_id = $1)
       ORDER BY is_builtin DESC, category, name`,
      [projectId || null]
    )
    return r.rows
  }

  // DB row → Skill 对象
  private rowToSkill(row: any): Skill {
    const self = this
    return {
      name:        row.name,
      description: row.description,
      async execute(ctx: AgentContext, input: any): Promise<any> {
        switch (row.executor_type) {

          // ── LLM Prompt 模式 ──────────────────────────────
          case 'llm_prompt': {
            const vars = { spec: ctx.spec, context: ctx, input, ...input }
            const system = interpolate(row.system_prompt || '', vars)
            const user   = interpolate(row.user_prompt_template || JSON.stringify(input), vars)
            const res = await self.router.call({
              system, user,
              maxTokens:   row.max_tokens || 4096,
              temperature: parseFloat(row.temperature || '0.2'),
              providerName: row.preferred_llm || undefined
            })
            return { content: res.content, tokens: res.promptTokens + res.completionTokens }
          }

          // ── 内置函数模式 ─────────────────────────────────
          case 'builtin_fn': {
            const builtins = require('../skills/builtin-skills')
            const fn = builtins[row.function_name]
            if (!fn) throw new Error(`内置函数 ${row.function_name} 不存在`)
            return fn.execute(ctx, input)
          }

          // ── HTTP Webhook 模式 ─────────────────────────────
          case 'http_webhook': {
            const fetch = require('node-fetch')
            const resp  = await fetch(row.webhook_url, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json', ...(row.webhook_headers || {}) },
              body:    JSON.stringify({ ctx: { taskId: ctx.taskId, projectId: ctx.projectId }, input }),
              timeout: row.webhook_timeout_ms || 10000
            })
            return resp.json()
          }

          // ── JS 沙箱脚本模式 ───────────────────────────────
          case 'js_script': {
            // 使用 vm 模块隔离执行
            const vm    = require('vm')
            const sandbox = { ctx, input, result: null, require: (m: string) => {
              // 白名单：只允许安全模块
              const allowed = ['path', 'crypto', 'util']
              if (!allowed.includes(m)) throw new Error(`js_script 中禁止 require('${m}')`)
              return require(m)
            }}
            vm.runInNewContext(row.script_code, sandbox, { timeout: 5000 })
            return sandbox.result
          }

          default:
            throw new Error(`未知的 executor_type: ${row.executor_type}`)
        }
      }
    }
  }
}

// ── 动态 Agent 工厂 ───────────────────────────────────────────
export class DynamicAgentFactory {
  constructor(
    private pool:         Pool,
    private skillFactory: DynamicSkillFactory,
    private router:       LLMRouter
  ) {}

  async buildAgent(agentName: string): Promise<BaseAgent> {
    const r = await this.pool.query(
      `SELECT * FROM agent_definitions WHERE name = $1 AND enabled = true`,
      [agentName]
    )
    if (r.rows.length === 0) throw new Error(`Agent "${agentName}" 不存在或已禁用`)
    return this.rowToAgent(r.rows[0])
  }

  async listAgents(projectId?: string): Promise<any[]> {
    const r = await this.pool.query(
      `SELECT id, name, display_name, description, domain, skill_names, enabled, is_builtin, tags, project_id
       FROM agent_definitions
       WHERE enabled = true AND (project_id IS NULL OR project_id = $1)
       ORDER BY is_builtin DESC, domain, name`,
      [projectId || null]
    )
    return r.rows
  }

  private rowToAgent(row: any): BaseAgent {
    const factory = this.skillFactory
    const router  = this.router
    const row_    = row  // 闭包引用

    // 动态创建 Agent 类
    class DynamicAgent extends BaseAgent {
      readonly name        = row_.name
      readonly description = row_.display_name
      readonly domain      = row_.domain || '*'
      skills: Skill[]      = []

      async execute(ctx: AgentContext): Promise<AgentOutput> {
        // 动态加载 Skills（每次执行时检查最新状态）
        try {
          this.skills = await factory.buildSkills(row_.skill_names || [])
        } catch (err) {
          console.warn(`[DynamicAgent:${row_.name}] 加载 Skills 失败:`, (err as Error).message)
          this.skills = []
        }

        // 注入 Agent 级别的 system_prompt（使用最新的 LLM 配置）
        const agentCtx: AgentContext = {
          ...ctx,
          config: {
            ...ctx.config,
            model: await resolveAgentModel(router, row_.preferred_llm),
            temperature: parseFloat(row_.temperature || '0.2'),
            maxRetries:  row_.max_retries || 3,
            timeoutMs:   row_.timeout_ms || 120000,
          }
        }

        // 如果有自定义 system_prompt，注入到 config
        if (row_.system_prompt) {
          const vars = { spec: ctx.spec, domain: ctx.config.domain }
          const interpolated = interpolate(row_.system_prompt, vars)
          ;(agentCtx.config as any).customSystemPrompt = interpolated
        }

        // 执行每个 Skill
        const skillResults: Record<string, any> = {}
        for (const skill of this.skills) {
          try {
            skillResults[skill.name] = await skill.execute(agentCtx, {
              spec:    ctx.spec,
              context: ctx,
              prev:    skillResults
            })
          } catch (err) {
            console.error(`[DynamicAgent:${row_.name}] Skill "${skill.name}" 失败:`, (err as Error).message)
          }
        }

        // 收集所有文件输出
        const files = Object.values(skillResults)
          .flatMap((r: any) => r?.files || [])
          .filter(Boolean)

        return {
          agentName: this.name,
          status:    'done',
          data:      skillResults,
          files:     files.length > 0 ? files : undefined,
          metadata: {
            durationMs: 0,
            retries:    0,
            skillsUsed: this.skills.map(s => s.name)
          }
        }
      }
    }

    return new DynamicAgent()
  }
}

async function resolveAgentModel(router: LLMRouter, preferredLlm?: string): Promise<string> {
  try {
    const p = preferredLlm
      ? await router['resolveProvider'](preferredLlm)
      : await router.getDefaultProvider()
    return p.modelId
  } catch {
    return process.env.LLM_MODEL || 'claude-sonnet-4-20250514'
  }
}
