# AWP 扩展性架构文档

> AI Workflow Platform — 从游戏研发到任意知识工作领域的通用 AI 工程化平台

---

## 一、核心扩展机制

平台通过 **三层可插拔设计** 实现任意领域扩展，无需修改核心代码：

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 3：领域配置（DomainConfig）                           │
│    定义语言/框架/规范/输出格式 → 改配置即换领域              │
├─────────────────────────────────────────────────────────────┤
│  Layer 2：Agent + Skill（可插拔）                            │
│    注册新 Agent = 扩展新能力；Skill 跨 Agent 复用            │
├─────────────────────────────────────────────────────────────┤
│  Layer 1：任务总线 + 流水线 DAG（不变）                      │
│    Agent 通信基础设施，JSON 配置驱动流水线                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、现有领域覆盖

| 领域 | 配置 Key | 语言 | 框架 | 流水线 |
|------|---------|------|------|--------|
| 游戏服务端 | `game-server` | Go + TypeScript | Gin + 原生 | standard |
| 游戏全栈 | `game-full` | Go + TS + C# | Gin + Unity 2022 | game-full |
| 智能客服 | `customer-service` | Python + TS | FastAPI + React | standard |
| 智能分析师 | `analytics` | Python + SQL | Pandas + ECharts | standard |
| 公文处理 | `document` | Python + TS | Django + React | standard |

---

## 三、扩展新领域（Step-by-Step）

### 3.1 最小扩展：只改配置

适合目标语言/框架与现有 Agent 兼容的场景。

**示例：扩展到 Java Spring Boot 微服务**

```typescript
// 1. 在 agent-registry.ts 的 DOMAIN_CONFIGS 添加：
'java-microservice': {
  name:         'java-microservice',
  language:     ['java'],
  framework:    'Spring Boot 3 + MyBatis Plus',
  conventions: [
    '使用 @Service/@Repository 注解',
    '统一异常处理 @ControllerAdvice',
    '接口用 Result<T> 包装返回值',
    '禁止在 Controller 写业务逻辑'
  ],
  outputFormat: 'code'
}

// 2. 在 codegen-agent.ts 的 getFileRequirements 添加：
java: {
  'java-microservice': `
    1. src/main/java/.../controller/<Feature>Controller.java
    2. src/main/java/.../service/<Feature>Service.java
    3. src/main/java/.../service/impl/<Feature>ServiceImpl.java
    4. src/main/java/.../mapper/<Feature>Mapper.java
    5. src/test/java/.../<Feature>ControllerTest.java`
}

// 3. 完成！调用时传入 domainKey: 'java-microservice'
```

---

### 3.2 中等扩展：添加专用 Agent

适合目标领域有特殊生成逻辑（如 Unity C# 的 MonoBehaviour 规范）。

**示例：扩展到 Vue 3 前端 Agent**

```typescript
// services/agents/agents/vue3-agent.ts
export class Vue3Agent extends BaseAgent {
  readonly name        = 'vue3-agent'
  readonly description = 'Vue 3 前端代码生成：Composable/Store/View/Test'
  readonly domain      = '*'
  readonly skills      = [llmCallSkill, fileParserSkill]

  async execute(ctx: AgentContext): Promise<AgentOutput> {
    const system = `你是资深 Vue 3 工程师。
    必须生成：
    ### FILE: src/composables/use<Feature>.ts     # 业务逻辑 Composable
    ### FILE: src/stores/<feature>Store.ts         # Pinia Store
    ### FILE: src/views/<Feature>View.vue          # 页面组件
    ### FILE: src/components/<Feature>/<Feature>Card.vue  # 子组件
    ### FILE: src/__tests__/use<Feature>.test.ts   # Vitest 测试
    技术规范：Vue 3 + TypeScript + Pinia + Vitest`

    const result = await llmCallSkill.execute(ctx, { system, user: buildUser(ctx.spec) })
    const parsed = await fileParserSkill.execute(ctx, { raw: result.content })
    return { agentName: this.name, status: 'done', data: {}, files: parsed.files, metadata: ... }
  }
}

// 注册到 Registry
registry.register(new Vue3Agent())
```

---

### 3.3 深度扩展：自定义 Skill

适合需要集成外部工具（如 Office SDK / 特定 API）的场景。

**示例：Word 文档生成 Skill（公文领域）**

```typescript
// services/agents/skills/docx-skill.ts
export const docxGeneratorSkill: Skill = {
  name: 'docx-generator',
  description: '生成 .docx 格式公文（标准公文格式，含页眉页脚红头）',
  async execute(ctx: AgentContext, input: { content: string; template: string }) {
    const { Document, Paragraph, HeadingLevel } = require('docx')
    const doc = new Document({ ... })
    // 生成标准公文格式（红头、正文、落款）
    return { buffer: await Packer.toBuffer(doc), filename: `${ctx.spec.title}.docx` }
  }
}

// 在公文 Agent 中组合使用
export class DocumentAgent extends BaseAgent {
  readonly skills = [llmCallSkill, docxGeneratorSkill]
  async execute(ctx) {
    const draft = await llmCallSkill.execute(ctx, { ... })    // 生成公文内容
    const docx  = await docxGeneratorSkill.execute(ctx, { content: draft.content }) // 转 Word
    return { ..., data: { docxBuffer: docx.buffer } }
  }
}
```

---

## 四、三个典型扩展领域详解

### 4.1 智能客服平台

**核心需求：** 意图识别 → 知识库检索 → 回复生成 → 人工转接

```
用户输入
  → 意图分析 Agent（置信度 < 0.7 → 人工）
  → 知识库检索 Agent（向量检索 FAQ + 产品文档）
  → 回复生成 Agent（个性化 + 情绪感知）
  → 质检 Agent（合规检查 + 敏感词过滤）
  → 满意度评分 Agent
```

**扩展要点：**
- `SpecAnalysisAgent` → `IntentAgent`（替换系统 Prompt，面向对话意图而非代码需求）
- `CodeGenAgent` → `ReplyGenAgent`（生成回复文本，而非代码文件）
- 新增 `KnowledgeBaseAgent`（接向量数据库检索 FAQ）
- 新增 `ComplianceAgent`（金融/医疗领域合规检查）
- `DomainConfig.outputFormat` = `'dialogue'`

**最小配置变更（YAML）：**
```yaml
domain: customer-service
pipeline: standard
agents:
  spec-analysis-agent:
    system_prompt: "你是客服意图分析师，分析用户问题的意图类别和关键实体"
  codegen-agent:
    system_prompt: "你是客服回复专家，生成准确、友好、简洁的回复"
    output_format: dialogue
```

---

### 4.2 智能数据分析师

**核心需求：** 自然语言 → SQL/Python 分析代码 → 图表 → 洞察报告

```
分析需求（自然语言）
  → 需求澄清 Agent（明确指标/维度/时间范围）
  → Schema 理解 Agent（分析数据库表结构）
  → SQL 生成 Agent（生成可执行 SQL + 安全检查）
  → Python 可视化 Agent（ECharts/Matplotlib 图表代码）
  → 洞察摘要 Agent（用自然语言解读数据结论）
```

**扩展要点：**
- 新增 `SchemaAgent`：读取数据库 DDL，构建表/字段语义图谱（替代代码知识库）
- 新增 `SQLAgent`：生成带安全限制的 SQL（禁止 DROP/UPDATE）
- 新增 `InsightAgent`：读取 SQL 结果，生成自然语言洞察
- `DomainConfig.outputFormat` = `'analysis'`
- 知识库存储：数据字典 + 历史优质 SQL 模板 + 业务指标定义

**领域 Spec 示例：**
```json
{
  "title": "近30天用户留存分析",
  "goal": "分析各渠道7日留存率和付费转化率",
  "domain": "analytics",
  "data_sources": ["user_events", "payments"],
  "metrics": ["7day_retention", "conversion_rate"],
  "dimensions": ["channel", "device"],
  "time_range": "last_30_days",
  "output": "line_chart + summary_table"
}
```

---

### 4.3 智能公文处理审批

**核心需求：** 公文起草 → 格式校验 → 审批流路由 → 签章 → 归档

```
公文需求（发文目的/类型）
  → 公文起草 Agent（生成符合国标 GB/T 9704 的正文）
  → 格式校验 Agent（红头/正文/落款/页码/字体）
  → 审批流设计 Agent（根据文件类型和级别推荐审批路径）
  → 签章验证 Agent（集成 CA 机构接口）
  → 归档编号 Agent（生成档案号，写入 OA 系统）
```

**扩展要点：**
- 新增 `DocumentDraftAgent`：系统 Prompt 嵌入 GB/T 9704-2012 标准全文摘要
- 新增 `WorkflowDesignAgent`：根据文件类型/密级/金额映射审批节点
- Skill 扩展：`docxGeneratorSkill`（Word 输出）、`pdfSignSkill`（PDF 签章）
- 知识库存储：历史公文模板 + 审批流规则库 + 红头模板

---

## 五、扩展清单（新增领域 Checklist）

```
[ ] 1. 在 DOMAIN_CONFIGS 添加领域配置（语言/框架/规范）
[ ] 2. 在 getFileRequirements 添加该语言的文件模板
[ ] 3. （可选）继承 BaseAgent 实现领域专用 Agent
[ ] 4. （可选）实现领域专用 Skill（如特殊格式输出）
[ ] 5. 在 PIPELINE_TEMPLATES 定义该领域流水线 DAG
[ ] 6. 在 knowledge-base/seed-code 添加该领域的高质量种子代码
[ ] 7. 运行 node knowledge-base/scripts/build-index.js 重建索引
[ ] 8. 在 BUILTIN_PIPELINE_CONFIGS 添加 JSON 配置定义
[ ] 9. 写端到端测试（scripts/e2e-test.js）验证完整流程
[ ] 10. 更新 .env.example 添加领域特定的环境变量
```

---

## 六、架构演进路径

```
当前（Phase 1-5 已完成）      近期演进               长期演进
─────────────────────       ──────────────         ──────────────
5 领域配置                  更多垂直领域             SaaS 化
动态 Skill/Agent（DB驱动）  插件市场                自定义 Agent 上传
本地知识库 + Chroma 向量库  企业私有化部署           联邦知识库
Prompt 进化 + 记忆沉淀      模型微调                私有模型训练
Kong 网关 + CI/CD          K8s 部署                多组织 + 计费
─────────────────────       ──────────────         ──────────────
```

### 关键扩展接口（保持向后兼容）

```typescript
// 注册新 Agent（One-liner）
registry.register(new MyCustomAgent())

// JSON 低代码配置流水线（无需改代码）
const pipeline = registry.buildPipelineFromConfig({
  name: '我的自定义流水线',
  nodes: [
    { agentName: 'spec-analysis-agent' },
    { agentName: 'my-custom-agent', dependsOn: ['spec-analysis-agent'] }
  ]
})

// 运行任意流水线
const result = await taskBus.run({
  id:      taskId,
  nodes:   pipeline,
  context: { taskId, spec, projectId, config: DOMAIN_CONFIGS['my-domain'] }
})
```

---

## 七、各领域对比表

| 维度 | 游戏研发 | 智能客服 | 数据分析师 | 公文处理 |
|------|---------|---------|-----------|---------|
| **输入形式** | 策划白话需求 | 用户对话/工单 | 分析问题描述 | 发文申请表单 |
| **核心 Agent** | CodeGen + Unity | IntentRec + Reply | SQL + Insight | Draft + Workflow |
| **知识库内容** | 接口契约+规范 | FAQ+产品手册 | 数据字典+SQL模板 | 公文模板+法规 |
| **输出物** | Go/TS/C# 代码 | 对话回复 | SQL+图表+报告 | Word/PDF公文 |
| **质量门禁** | 单元测试通过率 | 意图置信度 | SQL执行结果 | 格式规范符合度 |
| **人工介入** | 代码 Review | 置信度低时转接 | 结论确认 | 领导审签 |
| **进化方式** | 测试通过率→Prompt | 用户反馈→模型 | 好SQL模板→库 | 优质公文→模板 |
