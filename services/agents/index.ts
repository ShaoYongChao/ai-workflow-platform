/**
 * services/agents/index.ts
 *
 * Agent 系统导出和初始化接口
 * 其他服务通过此模块引入 Agent 系统
 */

import { Pool } from 'pg'
import { AgentRegistry } from './registry/agent-registry'
import { TaskBus } from './bus/task-bus'
import { LLMRouter } from './dynamic/llm-router'

let globalRegistry: AgentRegistry | null = null
let globalTaskBus: TaskBus | null = null

// ── 初始化 Agent 系统（可选，需要数据库连接以支持动态 Agent）─
export async function initializeAgentSystem(
  dbPool: Pool,
  llmRouter: LLMRouter
): Promise<{ registry: AgentRegistry; taskBus: TaskBus }> {
  if (!globalTaskBus) {
    globalTaskBus = new TaskBus()
  }

  if (!globalRegistry) {
    globalRegistry = new AgentRegistry(globalTaskBus, dbPool, llmRouter)
  }

  return {
    registry: globalRegistry,
    taskBus: globalTaskBus
  }
}

// ── 获取全局 Agent Registry（如果已初始化）──────────────────
export function getAgentRegistry(): AgentRegistry | null {
  return globalRegistry
}

// ── 获取全局 TaskBus（如果已初始化）────────────────────────
export function getTaskBus(): TaskBus | null {
  return globalTaskBus
}

// ── 导出核心类型 ──────────────────────────────────────────────
export { AgentRegistry } from './registry/agent-registry'
export { TaskBus, PipelineConfig, PipelineNode, PipelineResult } from './bus/task-bus'
export { BaseAgent, AgentContext, AgentOutput, Skill } from './base/agent'
export { DynamicAgentFactory, DynamicSkillFactory } from './dynamic/dynamic-loader'
export { LLMRouter } from './dynamic/llm-router'

// ── 导出内置 Agent ────────────────────────────────────────────
export { SpecAnalysisAgent } from './agents/spec-agent'
export { CodeGenAgent } from './agents/codegen-agent'
export { TestAgent, RefactorAgent } from './agents/test-refactor-agents'
export { Unity3DAgent } from './unity-agent/unity3d-agent'
