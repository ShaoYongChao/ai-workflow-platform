/**
 * services/agents/bus/task-bus.ts
 *
 * 任务总线：Agent 协作的中枢神经
 *
 * 功能：
 *   - DAG 依赖解析：按依赖关系并发/串行执行 Agent
 *   - 输出共享：一个 Agent 的输出自动成为下游的 prevOutputs
 *   - 进度广播：通过 Redis pub/sub → WebSocket 实时推送
 *   - 错误隔离：单个 Agent 失败不崩溃整个流水线（可配置）
 */

import { EventEmitter } from 'events'
import { BaseAgent, AgentContext, AgentOutput } from '../base/agent'

// ── 流水线节点定义 ────────────────────────────────────────────

export interface PipelineNode {
  agent:        BaseAgent
  dependsOn?:   string[]            // 依赖的 agent name 列表
  optional?:    boolean             // true = 失败不阻断流水线
  condition?:   (outputs: Record<string, AgentOutput>) => boolean  // 条件执行
}

export interface PipelineConfig {
  id:           string              // pipeline ID，对应 taskId
  nodes:        PipelineNode[]
  context:      Omit<AgentContext, 'prevOutputs'>
  onProgress?:  (event: PipelineEvent) => void
}

export interface PipelineEvent {
  pipelineId:   string
  agentName:    string
  status:       'started' | 'done' | 'failed' | 'skipped'
  output?:      AgentOutput
  timestamp:    number
}

export interface PipelineResult {
  pipelineId:   string
  status:       'success' | 'partial' | 'failed'
  outputs:      Record<string, AgentOutput>
  totalDurationMs: number
}

// ── 任务总线 ──────────────────────────────────────────────────

export class TaskBus extends EventEmitter {
  private runningPipelines = new Map<string, { cancel: () => void }>()

  // ── 运行流水线（支持 DAG 并发） ───────────────────────────
  async run(config: PipelineConfig): Promise<PipelineResult> {
    const { id, nodes, context, onProgress } = config
    const start   = Date.now()
    const outputs: Record<string, AgentOutput> = {}
    const done    = new Set<string>()
    const failed  = new Set<string>()

    let cancelled = false
    this.runningPipelines.set(id, {
      cancel: () => {
        cancelled = true
        nodes.forEach(n => n.agent.cancel())
      }
    })

    const notify = (event: Omit<PipelineEvent, 'timestamp'>) => {
      const e = { ...event, timestamp: Date.now() }
      this.emit('pipeline:event', e)
      onProgress?.(e)
    }

    // 拓扑排序 + 并发执行
    const pending = new Set(nodes.map(n => n.agent.name))

    while (pending.size > 0 && !cancelled) {
      // 找所有依赖已满足的节点
      const ready = nodes.filter(n => {
        if (!pending.has(n.agent.name))   return false
        if (failed.size > 0 && !n.optional) {
          const blockedByFailed = (n.dependsOn || []).some(dep => failed.has(dep))
          if (blockedByFailed) return false
        }
        return (n.dependsOn || []).every(dep => done.has(dep) || failed.has(dep))
      })

      if (ready.length === 0) {
        // 有节点因为前置失败而无法执行，跳过
        for (const n of nodes) {
          if (pending.has(n.agent.name)) {
            pending.delete(n.agent.name)
            failed.add(n.agent.name)
            notify({ pipelineId: id, agentName: n.agent.name, status: 'skipped' })
          }
        }
        break
      }

      // 并发运行所有就绪节点
      await Promise.all(ready.map(async (node) => {
        const agentName = node.agent.name
        pending.delete(agentName)

        // 检查条件
        if (node.condition && !node.condition(outputs)) {
          done.add(agentName)
          notify({ pipelineId: id, agentName, status: 'skipped' })
          return
        }

        notify({ pipelineId: id, agentName, status: 'started' })

        const ctx: AgentContext = { ...context, prevOutputs: { ...outputs } }
        const output = await node.agent.run(ctx)
        outputs[agentName] = output

        if (output.status === 'done') {
          done.add(agentName)
          notify({ pipelineId: id, agentName, status: 'done', output })
        } else {
          if (!node.optional) failed.add(agentName)
          else done.add(agentName)
          notify({ pipelineId: id, agentName, status: 'failed', output })
        }
      }))
    }

    this.runningPipelines.delete(id)

    const allDone     = nodes.every(n => done.has(n.agent.name) || n.optional)
    const anyFailed   = failed.size > 0
    const status: PipelineResult['status'] =
      allDone && !anyFailed ? 'success' :
      anyFailed && done.size > 0 ? 'partial' : 'failed'

    return {
      pipelineId: id,
      status,
      outputs,
      totalDurationMs: Date.now() - start
    }
  }

  // ── 取消流水线 ────────────────────────────────────────────
  cancel(pipelineId: string): void {
    this.runningPipelines.get(pipelineId)?.cancel()
  }
}

// 全局单例
export const taskBus = new TaskBus()
