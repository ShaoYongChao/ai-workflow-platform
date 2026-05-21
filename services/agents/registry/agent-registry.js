"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUILTIN_PIPELINE_CONFIGS = exports.AgentRegistry = exports.DOMAIN_CONFIGS = void 0;
const spec_agent_1 = require("../agents/spec-agent");
const codegen_agent_1 = require("../agents/codegen-agent");
const test_refactor_agents_1 = require("../agents/test-refactor-agents");
const unity3d_agent_1 = require("../unity-agent/unity3d-agent");
const dynamic_loader_1 = require("../dynamic/dynamic-loader");
// ── 内置领域配置 ──────────────────────────────────────────────
exports.DOMAIN_CONFIGS = {
    // 游戏服务端（Go + TS）
    'game-server': {
        name: 'game',
        language: ['go', 'typescript'],
        framework: 'Go 1.21 + Gin',
        conventions: ['Clean Architecture', '禁止 Magic Number', '所有错误显式处理'],
        outputFormat: 'code'
    },
    // 游戏全栈（Go + TS + Unity C#）
    'game-full': {
        name: 'game',
        language: ['go', 'typescript', 'csharp'],
        framework: 'Go + Unity 2022.3',
        conventions: ['Clean Architecture', 'MVP 模式'],
        outputFormat: 'code'
    },
    // 智能客服（Python + 对话流）
    'customer-service': {
        name: 'customer-service',
        language: ['python', 'typescript'],
        framework: 'FastAPI + React',
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
        name: 'analytics',
        language: ['python', 'sql'],
        framework: 'Pandas + SQLAlchemy + ECharts',
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
        name: 'document',
        language: ['python', 'typescript'],
        framework: 'Django + React',
        conventions: [
            '审批节点必须有超时自动提醒',
            '公文修改必须记录版本历史',
            '涉密文件禁止导出为明文',
            '签章验证必须调用第三方 CA'
        ],
        outputFormat: 'document'
    }
};
const PIPELINE_TEMPLATES = {
    // 标准流水线：Spec分析 → 代码生成 → 测试 → 重构
    'standard': (agents) => [
        { agent: agents.get('spec-analysis-agent') },
        { agent: agents.get('codegen-agent'), dependsOn: ['spec-analysis-agent'] },
        { agent: agents.get('test-agent'), dependsOn: ['codegen-agent'] },
        { agent: agents.get('refactor-agent'), dependsOn: ['test-agent'], optional: true }
    ],
    // 游戏全栈：标准 + Unity3D Agent 并发运行
    'game-full': (agents) => [
        { agent: agents.get('spec-analysis-agent') },
        { agent: agents.get('codegen-agent'), dependsOn: ['spec-analysis-agent'] },
        // Unity3D Agent 和服务端代码生成并发（都依赖 spec，Unity 额外参考服务端输出）
        {
            agent: agents.get('unity3d-agent'),
            dependsOn: ['spec-analysis-agent', 'codegen-agent'],
            optional: true
        },
        { agent: agents.get('test-agent'), dependsOn: ['codegen-agent'] },
        {
            agent: agents.get('refactor-agent'),
            dependsOn: ['test-agent', 'unity3d-agent'],
            optional: true
        }
    ],
    // 快速验证：只做 Spec + 代码生成，不跑测试
    'quick': (agents) => [
        { agent: agents.get('spec-analysis-agent') },
        { agent: agents.get('codegen-agent'), dependsOn: ['spec-analysis-agent'] }
    ]
};
// ── Agent 注册表 ──────────────────────────────────────────────
class AgentRegistry {
    constructor(bus, dbPool, llmRouter) {
        this.agents = new Map();
        this.dynamicAgentCache = new Map();
        this.bus = bus;
        this.pool = dbPool;
        // 初始化动态工厂（可选，需要数据库连接）
        if (dbPool && llmRouter) {
            this.dynamicSkillFactory = new dynamic_loader_1.DynamicSkillFactory(dbPool, llmRouter);
            this.dynamicAgentFactory = new dynamic_loader_1.DynamicAgentFactory(dbPool, this.dynamicSkillFactory, llmRouter);
        }
        this.registerBuiltins();
    }
    // ── 注册内置 Agent ────────────────────────────────────────
    registerBuiltins() {
        this.register(new spec_agent_1.SpecAnalysisAgent());
        this.register(new codegen_agent_1.CodeGenAgent());
        this.register(new test_refactor_agents_1.TestAgent());
        this.register(new test_refactor_agents_1.RefactorAgent());
        this.register(new unity3d_agent_1.Unity3DAgent());
    }
    // ── 插件机制：外部注册自定义 Agent ───────────────────────
    register(agent) {
        this.agents.set(agent.name, agent);
        console.log(`[Registry] 注册 Agent: ${agent.name} (domain: ${agent.domain})`);
    }
    unregister(name) {
        this.agents.delete(name);
    }
    get(name) {
        // 优先从内存中获取（包括已加载的动态 Agent）
        if (this.agents.has(name)) {
            return this.agents.get(name);
        }
        if (this.dynamicAgentCache.has(name)) {
            return this.dynamicAgentCache.get(name);
        }
        // 返回 undefined，由调用者处理 async 加载（不在同步方法中阻塞）
        return undefined;
    }
    // ── 异步加载 Agent（支持动态 Agent）──────────────────────
    async getAsync(name) {
        // 先检查内存
        if (this.agents.has(name)) {
            return this.agents.get(name);
        }
        if (this.dynamicAgentCache.has(name)) {
            return this.dynamicAgentCache.get(name);
        }
        // 从数据库加载（如果工厂可用）
        if (this.dynamicAgentFactory) {
            try {
                const agent = await this.dynamicAgentFactory.buildAgent(name);
                this.dynamicAgentCache.set(name, agent);
                console.log(`[Registry] 动态加载 Agent: ${name}`);
                return agent;
            }
            catch (err) {
                console.warn(`[Registry] 加载动态 Agent "${name}" 失败:`, err.message);
            }
        }
        return undefined;
    }
    list() {
        return Array.from(this.agents.values()).map(a => ({
            name: a.name,
            description: a.description,
            domain: a.domain
        }));
    }
    // ── 列出所有可用 Agent（包括动态加载的）─────────────────
    async listAsync(projectId) {
        const hardcoded = this.list();
        // 如果没有动态工厂，只返回硬编码的 Agent
        if (!this.dynamicAgentFactory) {
            return hardcoded;
        }
        // 从数据库加载其他 Agent
        try {
            const dynamic = await this.dynamicAgentFactory.listAgents(projectId);
            // 合并，去重（同名 Agent 硬编码优先）
            const hardcodedNames = new Set(hardcoded.map(a => a.name));
            const others = dynamic.filter((a) => !hardcodedNames.has(a.name));
            return [...hardcoded, ...others];
        }
        catch (err) {
            console.warn('[Registry] 列出动态 Agent 失败:', err.message);
            return hardcoded;
        }
    }
    // ── 根据领域和模式组装流水线 ──────────────────────────────
    buildPipeline(domainKey, pipelineMode = 'standard', customNodes) {
        if (customNodes)
            return customNodes;
        const template = PIPELINE_TEMPLATES[pipelineMode] || PIPELINE_TEMPLATES['standard'];
        return template(this.agents);
    }
    // ── 异步构建流水线（支持动态 Agent）────────────────────
    async buildPipelineAsync(domainKey, pipelineMode = 'standard', customNodes) {
        if (customNodes)
            return customNodes;
        const template = PIPELINE_TEMPLATES[pipelineMode] || PIPELINE_TEMPLATES['standard'];
        // 需要先加载可能的动态 Agent
        // 由于 template 返回的是对应的 Node[]，这里我们保留同步版本的行为
        // 如果需要全异步，应该在外部调用 getAsync() 先预加载
        return template(this.agents);
    }
    // ── 从 JSON 配置动态创建流水线（低代码扩展） ─────────────
    buildPipelineFromConfig(config) {
        return config.nodes.map(nodeConfig => {
            const agent = this.agents.get(nodeConfig.agentName);
            if (!agent)
                throw new Error(`Agent ${nodeConfig.agentName} 未注册`);
            return {
                agent,
                dependsOn: nodeConfig.dependsOn,
                optional: nodeConfig.optional,
                condition: nodeConfig.condition
                    ? new Function('outputs', nodeConfig.condition)
                    : undefined
            };
        });
    }
    // ── 异步从 JSON 配置创建流水线（支持动态 Agent）────────
    async buildPipelineFromConfigAsync(config) {
        const nodes = [];
        for (const nodeConfig of config.nodes) {
            const agent = await this.getAsync(nodeConfig.agentName);
            if (!agent)
                throw new Error(`Agent ${nodeConfig.agentName} 未注册`);
            nodes.push({
                agent,
                dependsOn: nodeConfig.dependsOn,
                optional: nodeConfig.optional,
                condition: nodeConfig.condition
                    ? new Function('outputs', nodeConfig.condition)
                    : undefined
            });
        }
        return nodes;
    }
    // ── 清除动态 Agent 缓存（admin 更新后调用）────────────────
    clearDynamicCache() {
        this.dynamicAgentCache.clear();
        console.log('[Registry] 已清除动态 Agent 缓存');
    }
}
exports.AgentRegistry = AgentRegistry;
// 内置流水线 JSON 配置示例（可存储在数据库，实现低代码配置）
exports.BUILTIN_PIPELINE_CONFIGS = {
    'game-full': {
        name: '游戏全栈（Go服务端 + Unity客户端）',
        nodes: [
            { agentName: 'spec-analysis-agent' },
            { agentName: 'codegen-agent', dependsOn: ['spec-analysis-agent'] },
            { agentName: 'unity3d-agent', dependsOn: ['spec-analysis-agent', 'codegen-agent'], optional: true },
            { agentName: 'test-agent', dependsOn: ['codegen-agent'] },
            { agentName: 'refactor-agent', dependsOn: ['test-agent'], optional: true }
        ]
    },
    'customer-service': {
        name: '智能客服（Python + 对话流）',
        nodes: [
            { agentName: 'spec-analysis-agent' },
            { agentName: 'codegen-agent', dependsOn: ['spec-analysis-agent'] },
            { agentName: 'test-agent', dependsOn: ['codegen-agent'] }
        ]
    },
    'quick-prototype': {
        name: '快速原型（跳过测试）',
        nodes: [
            { agentName: 'spec-analysis-agent' },
            { agentName: 'codegen-agent', dependsOn: ['spec-analysis-agent'] }
        ]
    }
};
//# sourceMappingURL=agent-registry.js.map