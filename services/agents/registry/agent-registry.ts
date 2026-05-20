/**
 * services/agents/registry/agent-registry.ts
 *
 * Agent 注册表
 *
 * 核心能力：
 *   1. 注册/注销 Agent（插件机制，运行时动态扩展）
 *   2. 根据领域和任务类型自动组装流水线
 *   3. 内置三条默认流水线（游戏/客服/公文）
 *   4. 自定义流水线支持（JSON 配置驱动）
 */

import { BaseAgent, DomainConfig } from '../base/agent'
import { PipelineNode, TaskBus } from '../bus/task-bus'
import { SpecAnalysisAgent } from '../agents/spec-agent'
import { CodeGenAgent } from '../agents/codegen-agent'
import { TestAgent, RefactorAgent } from '../agents/test-refactor-agents'
import { Unity3DAgent, UNITY_DOMAIN_CONFIG } from '../unity-agent/unity3d-agent'

// ── 内置领域配置 ──────────────────────────────────────────────

export const DOMAIN_CONFIGS: Record<string, DomainConfig> = {
  // 游戏服务端（Go + TS）
  'game-server': {
    name:         'game',
    language:     ['go', 'typescript'],
    framework:    'Go 1.21 + Gin',
    conventions: ['Clean Architecture', '禁止 Magic Number', '所有错误显式处理'],
    outputFormat: 'code'
  },

  // 游戏全栈（Go + TS + Unity C#）
  'game-full':  {
    name:         'game',
    language:     ['go', 'typescript', 'csharp'],
    framework:    'Go + Unity 2022.3',
    conventions: ['Clean Architecture', 'MVP 模式'],
    outputFormat: 'code'
  },

  // 智能客服（Python + 对话流）
  'customer-service': {
    name:         'customer-service',
    language:     ['python', 'typescript'],
    framework:    'FastAPI + React',
    conventions: [
      '意图识别置信度 < 0.7 时转人工',
      '对话历史最多保留 20 轮',
      '敏感词过滤必须在响应前执行',
      '超时 30s 自动转人工'
    ],
    outputFormat: 'code'
  },

  // 智能分析师（Python + SQL + 可视化）
  'analytics': {
    name:         'analytics',
    language:     ['python', 'sql'],
    framework:    'Pandas + SQLAlchemy + ECharts',
    conventions: [
      '数据查询必须加时间范围限制',
      '聚合查询超过 1M 行需分批处理',
      '可视化图表必须有图例和单位',
      '敏感数据字段自动脱敏'
    ],
    outputFormat: 'analysis'
  },

  // 公文处理（Python + 审批流）
  'document': {
    name:         'document',
    language:     ['python', 'typescript'],
    framework:    'Django + React',
    conventions: [
      '审批节点必须有超时自动提醒',
      '公文修改必须记录版本历史',
      '涉密文件禁止导出为明文',
      '签章验证必须调用第三方 CA'
    ],
    outputFormat: 'document'
  }
}

// ── 流水线模板 ────────────────────────────────────────────────

type PipelineTemplate = (agents: Map<string, BaseAgent>) => PipelineNode[]

const PIPELINE_TEMPLATES: Record<string, PipelineTemplate> = {
  // 标准流水线：Spec分析 → 代码生成 → 测试 → 重构
  'standard': (agents) => [
    { agent: agents.get('spec-analysis-agent')! },
    { agent: agents.get('codegen-agent')!, dependsOn: ['spec-analysis-agent'] },
    { agent: agents.get('test-agent')!, dependsOn: ['codegen-agent'] },
    { agent: agents.get('refactor-agent')!, dependsOn: ['test-agent'], optional: true }
  ],

  // 游戏全栈：标准 + Unity3D Agent 并发运行
  'game-full': (agents) => [
    { agent: agents.get('spec-analysis-agent')! },
    { agent: agents.get('codegen-agent')!, dependsOn: ['spec-analysis-agent'] },
    // Unity3D Agent 和服务端代码生成并发（都依赖 spec，Unity 额外参考服务端输出）
    {
      agent: agents.get('unity3d-agent')!,
      dependsOn: ['spec-analysis-agent', 'codegen-agent'],
      optional: true
    },
    { agent: agents.get('test-agent')!, dependsOn: ['codegen-agent'] },
    {
      agent: agents.get('refactor-agent')!,
      dependsOn: ['test-agent', 'unity3d-agent'],
      optional: true
    }
  ],

  // 快速验证：只做 Spec + 代码生成，不跑测试
  'quick': (agents) => [
    { agent: agents.get('spec-analysis-agent')! },
    { agent: agents.get('codegen-agent')!, dependsOn: ['spec-analysis-agent'] }
  ]
}

// ── Agent 注册表 ──────────────────────────────────────────────

export class AgentRegistry {
  private agents    = new Map<string, BaseAgent>()
  private bus:      TaskBus

  constructor(bus: TaskBus) {
    this.bus = bus
    this.registerBuiltins()
  }

  // ── 注册内置 Agent ────────────────────────────────────────
  private registerBuiltins() {
    this.register(new SpecAnalysisAgent())
    this.register(new CodeGenAgent())
    this.register(new TestAgent())
    this.register(new RefactorAgent())
    this.register(new Unity3DAgent())
  }

  // ── 插件机制：外部注册自定义 Agent ───────────────────────
  register(agent: BaseAgent): void {
    this.agents.set(agent.name, agent)
    console.log(`[Registry] 注册 Agent: ${agent.name} (domain: ${agent.domain})`)
  }

  unregister(name: string): void {
    this.agents.delete(name)
  }

  get(name: string): BaseAgent | undefined {
    return this.agents.get(name)
  }

  list(): Array<{ name: string; description: string; domain: string }> {
    return Array.from(this.agents.values()).map(a => ({
      name:        a.name,
      description: a.description,
      domain:      a.domain
    }))
  }

  // ── 根据领域和模式组装流水线 ──────────────────────────────
  buildPipeline(
    domainKey:     string,
    pipelineMode:  string = 'standard',
    customNodes?:  PipelineNode[]
  ): PipelineNode[] {
    if (customNodes) return customNodes

    const template = PIPELINE_TEMPLATES[pipelineMode] || PIPELINE_TEMPLATES['standard']
    return template(this.agents)
  }

  // ── 从 JSON 配置动态创建流水线（低代码扩展） ─────────────
  buildPipelineFromConfig(config: PipelineJSONConfig): PipelineNode[] {
    return config.nodes.map(nodeConfig => {
      const agent = this.agents.get(nodeConfig.agentName)
      if (!agent) throw new Error(`Agent ${nodeConfig.agentName} 未注册`)
      return {
        agent,
        dependsOn: nodeConfig.dependsOn,
        optional:  nodeConfig.optional,
        condition: nodeConfig.condition
          ? new Function('outputs', nodeConfig.condition) as any
          : undefined
      }
    })
  }
}

// ── JSON 配置驱动的流水线定义 ─────────────────────────────────
export interface PipelineJSONConfig {
  name:  string
  nodes: Array<{
    agentName:  string
    dependsOn?: string[]
    optional?:  boolean
    condition?: string   // JS 表达式字符串，(outputs) => boolean
  }>
}

// 内置流水线 JSON 配置示例（可存储在数据库，实现低代码配置）
export const BUILTIN_PIPELINE_CONFIGS: Record<string, PipelineJSONConfig> = {
  'game-full': {
    name: '游戏全栈（Go服务端 + Unity客户端）',
    nodes: [
      { agentName: 'spec-analysis-agent' },
      { agentName: 'codegen-agent',    dependsOn: ['spec-analysis-agent'] },
      { agentName: 'unity3d-agent',    dependsOn: ['spec-analysis-agent', 'codegen-agent'], optional: true },
      { agentName: 'test-agent',       dependsOn: ['codegen-agent'] },
      { agentName: 'refactor-agent',   dependsOn: ['test-agent'], optional: true }
    ]
  },
  'customer-service': {
    name: '智能客服（Python + 对话流）',
    nodes: [
      { agentName: 'spec-analysis-agent' },
      { agentName: 'codegen-agent',    dependsOn: ['spec-analysis-agent'] },
      { agentName: 'test-agent',       dependsOn: ['codegen-agent'] }
    ]
  },
  'quick-prototype': {
    name: '快速原型（跳过测试）',
    nodes: [
      { agentName: 'spec-analysis-agent' },
      { agentName: 'codegen-agent', dependsOn: ['spec-analysis-agent'] }
    ]
  }
}
