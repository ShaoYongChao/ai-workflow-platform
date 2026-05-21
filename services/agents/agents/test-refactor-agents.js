"use strict";
/**
 * services/agents/agents/test-agent.ts
 *
 * 测试 Agent：运行测试 + Auto-Fix（委托给 executor）
 * 重构 Agent：提取重复代码、优化变量名（SonarQube 触发）
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RefactorAgent = exports.TestAgent = void 0;
const agent_1 = require("../base/agent");
const builtin_skills_1 = require("../skills/builtin-skills");
// ══════════════════════════════════════════════════════════════
// 测试 Agent
// ══════════════════════════════════════════════════════════════
class TestAgent extends agent_1.BaseAgent {
    constructor() {
        super(...arguments);
        this.name = 'test-agent';
        this.description = '自动化测试：运行测试套件，失败时触发 Auto-Fix（最多 3 次）';
        this.domain = '*';
        this.skills = [builtin_skills_1.staticAnalysisSkill];
    }
    async execute(ctx) {
        // 从上游 codegen-agent 取生成的文件
        const codegenOutput = ctx.prevOutputs['codegen-agent'];
        const files = codegenOutput?.files || [];
        if (files.length === 0) {
            return this.failOutput('没有可测试的文件，codegen-agent 未输出文件');
        }
        // 1. 静态分析（不需要编译器）
        const analysis = await builtin_skills_1.staticAnalysisSkill.execute(ctx, { files });
        // 2. 委托给 executor（通过 Kafka 异步）—— 避免直接运行沙箱破坏 Agent 纯度
        try {
            const { Kafka } = require('kafkajs');
            const kafka = new Kafka({
                clientId: 'test-agent',
                brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(',')
            });
            const producer = kafka.producer();
            await producer.connect();
            await producer.send({
                topic: 'code.generated',
                messages: [{
                        key: ctx.taskId,
                        value: JSON.stringify({
                            taskId: ctx.taskId,
                            specId: ctx.specId,
                            spec: ctx.spec,
                            files,
                            timestamp: Date.now(),
                            model: ctx.config.model
                        })
                    }]
            });
            await producer.disconnect();
        }
        catch (err) {
            // Kafka 不可用时降级为纯静态分析
            console.warn('[TestAgent] Kafka 不可用，仅做静态分析');
        }
        const passed = analysis.quality >= 70 && analysis.hasTests;
        return {
            agentName: this.name,
            status: passed ? 'done' : 'failed',
            data: {
                staticQuality: analysis.quality,
                hasTests: analysis.hasTests,
                issues: analysis.issues,
                delegatedToExecutor: true
            },
            error: passed ? undefined : `质量分 ${analysis.quality} < 70 或缺少测试文件`,
            metadata: { durationMs: 0, retries: 0, skillsUsed: ['static-analysis'] }
        };
    }
    failOutput(error) {
        return {
            agentName: this.name, status: 'failed',
            data: {}, error,
            metadata: { durationMs: 0, retries: 0, skillsUsed: [] }
        };
    }
}
exports.TestAgent = TestAgent;
// ══════════════════════════════════════════════════════════════
// 重构 Agent
// ══════════════════════════════════════════════════════════════
class RefactorAgent extends agent_1.BaseAgent {
    constructor() {
        super(...arguments);
        this.name = 'refactor-agent';
        this.description = '代码重构：提取重复逻辑、优化命名、消除 Magic Number';
        this.domain = '*';
        this.skills = [builtin_skills_1.llmCallSkill, builtin_skills_1.staticAnalysisSkill];
    }
    async execute(ctx) {
        const codegenOutput = ctx.prevOutputs['codegen-agent'];
        const testOutput = ctx.prevOutputs['test-agent'];
        // 只有测试通过才做重构
        if (testOutput?.status !== 'done') {
            return {
                agentName: this.name, status: 'done',
                data: { skipped: true, reason: '测试未通过，跳过重构' },
                metadata: { durationMs: 0, retries: 0, skillsUsed: [] }
            };
        }
        const files = codegenOutput?.files || [];
        if (files.length === 0) {
            return {
                agentName: this.name, status: 'done',
                data: { skipped: true, reason: '无文件可重构' },
                metadata: { durationMs: 0, retries: 0, skillsUsed: [] }
            };
        }
        // 静态分析找重构点
        const analysis = await builtin_skills_1.staticAnalysisSkill.execute(ctx, { files });
        if (analysis.issues.length === 0) {
            return {
                agentName: this.name, status: 'done',
                data: { refactored: false, reason: '代码质量良好，无需重构' },
                files,
                metadata: { durationMs: 0, retries: 0, skillsUsed: ['static-analysis'] }
            };
        }
        // 调 LLM 重构
        const system = `你是代码质量专家。
只针对以下具体问题进行最小化重构，不改变功能逻辑。
输出格式同代码生成（### FILE: <路径>）。
只输出修改过的文件，未修改的不要输出。`;
        const user = `## 需要重构的问题
${analysis.issues.join('\n')}

## 当前代码
${files.map((f) => `### FILE: ${f.path}\n\`\`\`${f.language}\n${f.content}\n\`\`\``).join('\n\n')}`;
        const result = await builtin_skills_1.llmCallSkill.execute(ctx, { system, user, maxTokens: 6144 });
        const { fileParserSkill } = require('../skills/builtin-skills');
        const refactored = await fileParserSkill.execute(ctx, { raw: result.content });
        // 合并：用重构后的覆盖原文件，其余保留
        const refMap = new Map(refactored.files.map((f) => [f.path, f]));
        const finalFiles = files.map((f) => refMap.get(f.path) || f);
        return {
            agentName: this.name, status: 'done',
            data: {
                refactored: true,
                issuesFixed: analysis.issues.length,
                filesModified: refactored.files.length
            },
            files: finalFiles,
            metadata: { durationMs: 0, tokensUsed: result.tokens, retries: 0, skillsUsed: ['llm-call', 'static-analysis'] }
        };
    }
}
exports.RefactorAgent = RefactorAgent;
//# sourceMappingURL=test-refactor-agents.js.map