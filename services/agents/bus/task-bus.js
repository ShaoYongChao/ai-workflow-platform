"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.taskBus = exports.TaskBus = void 0;
const events_1 = require("events");
// ── 任务总线 ──────────────────────────────────────────────────
class TaskBus extends events_1.EventEmitter {
    constructor() {
        super(...arguments);
        this.runningPipelines = new Map();
    }
    // ── 运行流水线（支持 DAG 并发） ───────────────────────────
    async run(config) {
        const { id, nodes, context, onProgress } = config;
        const start = Date.now();
        const outputs = {};
        const done = new Set();
        const failed = new Set();
        let cancelled = false;
        this.runningPipelines.set(id, {
            cancel: () => {
                cancelled = true;
                nodes.forEach(n => n.agent.cancel());
            }
        });
        const notify = (event) => {
            const e = { ...event, timestamp: Date.now() };
            this.emit('pipeline:event', e);
            onProgress?.(e);
        };
        // 拓扑排序 + 并发执行
        const pending = new Set(nodes.map(n => n.agent.name));
        while (pending.size > 0 && !cancelled) {
            // 找所有依赖已满足的节点
            const ready = nodes.filter(n => {
                if (!pending.has(n.agent.name))
                    return false;
                if (failed.size > 0 && !n.optional) {
                    const blockedByFailed = (n.dependsOn || []).some(dep => failed.has(dep));
                    if (blockedByFailed)
                        return false;
                }
                return (n.dependsOn || []).every(dep => done.has(dep) || failed.has(dep));
            });
            if (ready.length === 0) {
                // 有节点因为前置失败而无法执行，跳过
                for (const n of nodes) {
                    if (pending.has(n.agent.name)) {
                        pending.delete(n.agent.name);
                        failed.add(n.agent.name);
                        notify({ pipelineId: id, agentName: n.agent.name, status: 'skipped' });
                    }
                }
                break;
            }
            // 并发运行所有就绪节点
            await Promise.all(ready.map(async (node) => {
                const agentName = node.agent.name;
                pending.delete(agentName);
                // 检查条件
                if (node.condition && !node.condition(outputs)) {
                    done.add(agentName);
                    notify({ pipelineId: id, agentName, status: 'skipped' });
                    return;
                }
                notify({ pipelineId: id, agentName, status: 'started' });
                const ctx = { ...context, prevOutputs: { ...outputs } };
                const output = await node.agent.run(ctx);
                outputs[agentName] = output;
                if (output.status === 'done') {
                    done.add(agentName);
                    notify({ pipelineId: id, agentName, status: 'done', output });
                }
                else {
                    if (!node.optional)
                        failed.add(agentName);
                    else
                        done.add(agentName);
                    notify({ pipelineId: id, agentName, status: 'failed', output });
                }
            }));
        }
        this.runningPipelines.delete(id);
        const allDone = nodes.every(n => done.has(n.agent.name) || n.optional);
        const anyFailed = failed.size > 0;
        const status = allDone && !anyFailed ? 'success' :
            anyFailed && done.size > 0 ? 'partial' : 'failed';
        return {
            pipelineId: id,
            status,
            outputs,
            totalDurationMs: Date.now() - start
        };
    }
    // ── 取消流水线 ────────────────────────────────────────────
    cancel(pipelineId) {
        this.runningPipelines.get(pipelineId)?.cancel();
    }
}
exports.TaskBus = TaskBus;
// 全局单例
exports.taskBus = new TaskBus();
//# sourceMappingURL=task-bus.js.map