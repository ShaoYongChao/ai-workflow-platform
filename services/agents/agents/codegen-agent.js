"use strict";
/**
 * services/agents/agents/codegen-agent.ts
 *
 * 代码生成 Agent
 *   职责：根据 Spec + 检索上下文生成代码
 *   支持领域：通过 DomainConfig.language 决定输出语言
 *   输出：GeneratedFile[]
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodeGenAgent = void 0;
const agent_1 = require("../base/agent");
const builtin_skills_1 = require("../skills/builtin-skills");
class CodeGenAgent extends agent_1.BaseAgent {
    constructor() {
        super(...arguments);
        this.name = 'codegen-agent';
        this.description = '代码生成：根据 Spec 生成多语言代码';
        this.domain = '*';
        this.skills = [builtin_skills_1.llmCallSkill, builtin_skills_1.fileParserSkill, builtin_skills_1.knowledgeRetrievalSkill, builtin_skills_1.memoryInjectSkill];
    }
    async execute(ctx) {
        const spec = ctx.spec;
        // 1. 获取检索上下文（知识库 + 记忆）
        const [retrieval, memory] = await Promise.all([
            builtin_skills_1.knowledgeRetrievalSkill.execute(ctx, { spec }),
            builtin_skills_1.memoryInjectSkill.execute(ctx, { keywords: [spec.title, ...(spec.entities || [])] })
        ]);
        // 2. 确定目标语言和文件模板
        const langs = ctx.config.domain.language;
        const outputs = [];
        let totalTokens = 0;
        // 并发生成各语言代码
        await Promise.all(langs.map(async (lang) => {
            const prompt = buildCodePrompt(spec, retrieval, memory, lang, ctx.config.domain);
            const result = await builtin_skills_1.llmCallSkill.execute(ctx, {
                system: prompt.system,
                user: prompt.user,
                maxTokens: 8192
            });
            totalTokens += result.tokens;
            const parsed = await builtin_skills_1.fileParserSkill.execute(ctx, { raw: result.content });
            outputs.push(...parsed.files);
        }));
        // 3. 写入技能记忆（成功时）
        if (outputs.length > 0) {
            try {
                const { MemoryService } = require('../../memory/src/memory-service');
                const mem = new MemoryService({ postgresUrl: process.env.POSTGRES_URL });
                await mem.saveSkillMemory(ctx.projectId, {
                    skillName: `generate_${spec.title.replace(/\s+/g, '_').toLowerCase()}`,
                    description: spec.goal,
                    template: outputs.map((f) => f.path).join(', '),
                    inputSchema: { spec: spec.title },
                    success: true
                });
            }
            catch { /* 不阻塞主流程 */ }
        }
        return {
            agentName: this.name,
            status: outputs.length > 0 ? 'done' : 'failed',
            data: { fileCount: outputs.length },
            files: outputs,
            error: outputs.length === 0 ? '未解析到任何代码文件' : undefined,
            metadata: {
                durationMs: 0, tokensUsed: totalTokens, retries: 0,
                skillsUsed: ['llm-call', 'file-parser', 'knowledge-retrieval', 'memory-inject']
            }
        };
    }
}
exports.CodeGenAgent = CodeGenAgent;
// ── 领域感知的代码生成 Prompt ─────────────────────────────────
function buildCodePrompt(spec, retrieval, memory, language, domain) {
    const fileRequirements = getFileRequirements(language, domain);
    const conventions = [
        ...(retrieval.conventions || []),
        ...(domain.conventions || []),
        ...(memory.memories?.slice(0, 2).map((m) => m.content.slice(0, 100)) || [])
    ].join('\n');
    const skillTemplates = memory.skills?.map((s) => `// 参考技能: ${s.skill_name} - ${s.description}`).join('\n') || '';
    const system = `你是资深${language}工程师，专注于${domain.name}领域开发。
根据 Spec 和只读知识库，生成高质量代码。

## 输出文件（必须生成）
${fileRequirements}

## 输出格式（严格遵守）
### FILE: <路径>
\`\`\`${language}
<完整代码>
\`\`\`

## 知识库接口（只调用，不复制实现）
${(retrieval.relatedInterfaces || []).slice(0, 5).join('\n')}

## 调用链约束
${(retrieval.callGraph || []).join('\n')}

## 代码规范
${conventions || '遵循 Clean Code 原则'}

${skillTemplates}

## 禁止
- 禁止 Magic Number / 硬编码配置
- 禁止忽略错误返回值
- 禁止跨层直接调用`;
    const user = `## 需求 Spec
${JSON.stringify(spec, null, 2)}

请生成完整的 ${language} 代码，确保覆盖所有验收标准：
${(spec.acceptance || []).map((a, i) => `${i + 1}. ${a}`).join('\n')}`;
    return { system, user };
}
function getFileRequirements(language, domain) {
    const templates = {
        go: {
            game: '1. server/<feature>/model.go\n2. server/<feature>/service.go\n3. server/<feature>/handler.go\n4. server/<feature>/handler_test.go',
            default: '1. <feature>/model.go\n2. <feature>/service.go\n3. <feature>/handler.go\n4. <feature>/handler_test.go'
        },
        typescript: {
            game: '1. client/<feature>/types.ts\n2. client/<feature>/api.ts\n3. client/<feature>/<Feature>Manager.ts\n4. client/<feature>/<Feature>Manager.test.ts',
            default: '1. src/<feature>/types.ts\n2. src/<feature>/service.ts\n3. src/<feature>/<Feature>Service.test.ts'
        },
        csharp: {
            game: '1. Scripts/<Feature>/<Feature>Manager.cs\n2. Scripts/<Feature>/<Feature>Data.cs\n3. Scripts/<Feature>/I<Feature>Service.cs',
            default: '1. <Feature>/<Feature>Service.cs\n2. <Feature>/<Feature>Model.cs\n3. <Feature>/Tests/<Feature>Tests.cs'
        },
        python: {
            default: '1. <feature>/models.py\n2. <feature>/service.py\n3. <feature>/api.py\n4. tests/test_<feature>.py'
        }
    };
    return templates[language]?.[domain.name] || templates[language]?.['default'] || `1. <feature>/main.${language}\n2. <feature>/test.${language}`;
}
//# sourceMappingURL=codegen-agent.js.map