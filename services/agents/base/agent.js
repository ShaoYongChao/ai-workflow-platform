"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseAgent = void 0;
const events_1 = require("events");
// ── Agent 基类 ────────────────────────────────────────────────
class BaseAgent extends events_1.EventEmitter {
    constructor() {
        super(...arguments);
        this.status = 'idle';
        this.retryCount = 0;
    }
    // ── 带重试和超时的执行入口 ────────────────────────────────
    async run(ctx) {
        const start = Date.now();
        const maxRetries = ctx.config.maxRetries ?? 3;
        const timeout = ctx.config.timeoutMs ?? 120000;
        this.status = 'running';
        this.emit('start', { agentName: this.name, taskId: ctx.taskId });
        for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            try {
                const result = await Promise.race([
                    this.execute(ctx),
                    this.timeoutPromise(timeout)
                ]);
                this.status = 'done';
                const output = {
                    ...result,
                    agentName: this.name,
                    status: 'done',
                    metadata: {
                        ...result.metadata,
                        durationMs: Date.now() - start,
                        retries: attempt - 1,
                        skillsUsed: result.metadata?.skillsUsed ?? this.skills.map(s => s.name)
                    }
                };
                this.emit('done', output);
                return output;
            }
            catch (err) {
                const isLast = attempt > maxRetries;
                this.emit('retry', { attempt, error: err.message });
                if (isLast) {
                    this.status = 'failed';
                    const failOutput = {
                        agentName: this.name,
                        status: 'failed',
                        data: {},
                        error: err.message,
                        metadata: { durationMs: Date.now() - start, retries: attempt - 1, skillsUsed: [] }
                    };
                    this.emit('failed', failOutput);
                    return failOutput;
                }
                // 指数退避
                await sleep(Math.min(1000 * Math.pow(2, attempt - 1), 8000));
            }
        }
        // 不会到这里，满足 TS 类型检查
        throw new Error('unreachable');
    }
    // ── 取消 ──────────────────────────────────────────────────
    cancel() {
        this.status = 'cancelled';
        this.emit('cancelled', { agentName: this.name });
    }
    getStatus() { return this.status; }
    timeoutPromise(ms) {
        return new Promise((_, reject) => setTimeout(() => reject(new Error(`Agent ${this.name} 超时 (${ms}ms)`)), ms));
    }
}
exports.BaseAgent = BaseAgent;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
//# sourceMappingURL=agent.js.map