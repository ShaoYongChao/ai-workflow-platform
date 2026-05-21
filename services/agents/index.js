"use strict";
/**
 * services/agents/index.ts
 *
 * Agent 系统导出和初始化接口
 * 其他服务通过此模块引入 Agent 系统
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Unity3DAgent = exports.RefactorAgent = exports.TestAgent = exports.CodeGenAgent = exports.SpecAnalysisAgent = exports.LLMRouter = exports.DynamicSkillFactory = exports.DynamicAgentFactory = exports.BaseAgent = exports.TaskBus = exports.AgentRegistry = void 0;
exports.initializeAgentSystem = initializeAgentSystem;
exports.getAgentRegistry = getAgentRegistry;
exports.getTaskBus = getTaskBus;
const agent_registry_1 = require("./registry/agent-registry");
const task_bus_1 = require("./bus/task-bus");
let globalRegistry = null;
let globalTaskBus = null;
// ── 初始化 Agent 系统（可选，需要数据库连接以支持动态 Agent）─
async function initializeAgentSystem(dbPool, llmRouter) {
    if (!globalTaskBus) {
        globalTaskBus = new task_bus_1.TaskBus();
    }
    if (!globalRegistry) {
        globalRegistry = new agent_registry_1.AgentRegistry(globalTaskBus, dbPool, llmRouter);
    }
    return {
        registry: globalRegistry,
        taskBus: globalTaskBus
    };
}
// ── 获取全局 Agent Registry（如果已初始化）──────────────────
function getAgentRegistry() {
    return globalRegistry;
}
// ── 获取全局 TaskBus（如果已初始化）────────────────────────
function getTaskBus() {
    return globalTaskBus;
}
// ── 导出核心类型 ──────────────────────────────────────────────
var agent_registry_2 = require("./registry/agent-registry");
Object.defineProperty(exports, "AgentRegistry", { enumerable: true, get: function () { return agent_registry_2.AgentRegistry; } });
var task_bus_2 = require("./bus/task-bus");
Object.defineProperty(exports, "TaskBus", { enumerable: true, get: function () { return task_bus_2.TaskBus; } });
var agent_1 = require("./base/agent");
Object.defineProperty(exports, "BaseAgent", { enumerable: true, get: function () { return agent_1.BaseAgent; } });
var dynamic_loader_1 = require("./dynamic/dynamic-loader");
Object.defineProperty(exports, "DynamicAgentFactory", { enumerable: true, get: function () { return dynamic_loader_1.DynamicAgentFactory; } });
Object.defineProperty(exports, "DynamicSkillFactory", { enumerable: true, get: function () { return dynamic_loader_1.DynamicSkillFactory; } });
var llm_router_1 = require("./dynamic/llm-router");
Object.defineProperty(exports, "LLMRouter", { enumerable: true, get: function () { return llm_router_1.LLMRouter; } });
// ── 导出内置 Agent ────────────────────────────────────────────
var spec_agent_1 = require("./agents/spec-agent");
Object.defineProperty(exports, "SpecAnalysisAgent", { enumerable: true, get: function () { return spec_agent_1.SpecAnalysisAgent; } });
var codegen_agent_1 = require("./agents/codegen-agent");
Object.defineProperty(exports, "CodeGenAgent", { enumerable: true, get: function () { return codegen_agent_1.CodeGenAgent; } });
var test_refactor_agents_1 = require("./agents/test-refactor-agents");
Object.defineProperty(exports, "TestAgent", { enumerable: true, get: function () { return test_refactor_agents_1.TestAgent; } });
Object.defineProperty(exports, "RefactorAgent", { enumerable: true, get: function () { return test_refactor_agents_1.RefactorAgent; } });
var unity3d_agent_1 = require("./unity-agent/unity3d-agent");
Object.defineProperty(exports, "Unity3DAgent", { enumerable: true, get: function () { return unity3d_agent_1.Unity3DAgent; } });
//# sourceMappingURL=index.js.map