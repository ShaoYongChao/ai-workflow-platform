# CLAUDE.md — AWP 项目上下文

> 本文件供 Claude（AI 编程助手）读取，帮助在后续对话中准确理解项目结构、约定和扩展方式。
> 修改代码前请先阅读相关章节，避免重复造轮子或破坏已有约定。

---

## 一、项目是什么

**AWP（AI Workflow Platform）** — AI 驱动的全链路自动化研发工作流平台。

**核心流程**（已完整实现）：
```
策划白话输入 → AI 对话标准化为 Spec → 知识库检索 →
LLM 生成代码（Go + TS + Unity C#）→ Docker 沙箱自动测试 →
失败时 Auto-Fix（最多3次）→ VS Code 插件 Review/Accept →
评分 + 记忆沉淀 → AI 越用越准
```

**不是什么**：不是通用 AI 助手，不是 IDE 插件，不是 Copilot 竞品。
是一套面向团队的**工程化研发流水线**，强调可追溯、可评分、可进化。

---

## 二、目录结构（必读）

```
ai-workflow-platform/
├── .github/
│   └── workflows/ci.yml       ← GitHub Actions CI（TS 编译 + E2E + Docker 构建 + 集成测试）
├── CLAUDE.md                   ← 你在这里
├── README.md                   ← GitHub 主页
├── docker-compose.yml          ← 20 个服务，所有端口定义在这里
├── .env.example                ← 所有环境变量的权威来源
│
├── shared/
│   ├── types/index.ts          ← 跨服务共享类型（FeatureSpec、GeneratedFile、KAFKA_TOPICS）
│   └── prompts/
│       └── dynamic-constraints.json  ← 进化引擎自动维护，不要手动删除
│
├── services/
│   ├── spec-normalizer/        ← 端口 3001，WebSocket 流式对话，Zod 校验
│   ├── code-generator/         ← 端口 3003，消费 spec.submitted，生成代码
│   ├── executor/               ← 端口 3004，消费 code.generated，测试+Auto-Fix+Review API
│   ├── retrieval/              ← 端口 3008，独立检索服务（Phase 2，可选）
│   ├── admin/                  ← 端口 3006，管理后台 REST API
│   ├── agents/                 ← 多 Agent 系统（不独立部署，被其他服务引用）
│   │   ├── base/agent.ts       ← BaseAgent 抽象基类，所有 Agent 继承它
│   │   ├── bus/task-bus.ts     ← TaskBus DAG 调度器
│   │   ├── skills/builtin-skills.ts  ← 5 个内置 Skill
│   │   ├── dynamic/llm-router.ts     ← LLM 路由器（9种Provider，DB驱动）
│   │   ├── dynamic/dynamic-loader.ts ← 动态 Skill/Agent 加载器
│   │   ├── registry/agent-registry.ts ← 注册表 + 5个领域配置 + 3条流水线
│   │   └── unity-agent/unity3d-agent.ts ← Unity3D C# 专用 Agent
│   ├── graph/                  ← Neo4j 图谱构建脚本（非常驻服务）
│   ├── memory/                 ← 记忆系统（每日 Consolidation 定时任务）
│   └── scorer/                 ← 评分和 Prompt 进化引擎（被 executor 调用）
│
├── frontend/
│   ├── planner-web/            ← 端口 3000，策划输入界面（Next.js 14）
│   ├── admin-web/              ← 端口 3007，管理后台（Next.js 14）
│   └── vscode-plugin/          ← VS Code 插件（TypeScript Extension API）
│
├── gateway/
│   ├── tenant-middleware.js    ← 多租户中间件，所有服务都应引入
│   └── tenant-db.js            ← 租户感知 DB 查询封装
│
├── knowledge-base/
│   ├── seed-code/              ← 高质量参考代码（手工维护）
│   │   ├── server/daily_signin/ ← Go 签到功能（4文件示范）
│   │   ├── server/battle/       ← Go 战斗配置示范
│   │   └── client/daily_signin/ ← TypeScript 客户端示范
│   ├── index/kb.json           ← BM25 索引（由 build-index.js 自动生成，勿手动编辑）
│   └── scripts/
│       ├── build-index.js      ← 重建索引：node knowledge-base/scripts/build-index.js
│       ├── vectorize.js        ← 写入 Chroma：需要 OPENAI_API_KEY，支持 --project=<id>
│       └── add-seed.js         ← 添加新代码：node ... add-seed.js <路径> --feature=<名>
│
├── infra/
│   ├── postgres/
│   │   ├── init.sql            ← 业务表（10张）+ 记忆系统（4张）
│   │   └── dynamic-config-schema.sql ← 动态配置表（6张）+ 预置14个LLM
│   ├── kong/kong.yml           ← Kong 声明式路由配置（DB-less 模式）
│   └── prometheus/prometheus.yml
│
├── docs/
│   ├── ARCHITECTURE.md         ← 详细架构：数据流、Kafka Topics、DB 设计
│   ├── API.md                  ← 所有 REST + WebSocket 接口文档
│   ├── SKILL_AGENT_SPEC.md     ← Skill/Agent 填写规范（重要！）
│   ├── EXTENSIBILITY.md        ← 扩展到其他领域的方案
│   └── skills-examples.sql     ← Skill 配置 SQL 示例
│
└── scripts/
    ├── start.sh                ← 分阶段启动（infra/app/gateway/admin/monitoring/quality/graph/all）
    └── e2e-test.js             ← 端到端验证（不需要 Docker）
```

---

## 三、服务端口速查

| 端口 | 服务 | 说明 |
|------|------|------|
| 3000 | planner-web | 策划输入界面 |
| 3001 | spec-normalizer | 需求标准化（含 /ws WebSocket） |
| 3003 | code-generator | 代码生成服务 |
| 3004 | executor | 执行服务（含 /ws/tasks WebSocket） |
| 3005 | grafana | 监控面板（admin/\${GRAFANA_PASSWORD}） |
| 3006 | admin | 管理后台 API（需 X-Admin-Key Header） |
| 3007 | admin-web | 管理后台界面 |
| 3008 | retrieval | 检索服务（Phase 2，可选） |
| 5432 | postgres | PostgreSQL |
| 6379 | redis | Redis |
| 7474 | neo4j | Neo4j Browser |
| 7687 | neo4j | Neo4j Bolt 协议 |
| 8000 | kong | API 网关统一入口（HTTP Proxy） |
| 8001 | chroma | 向量数据库 |
| 8002 | kong-admin | Kong Admin API（仅开发环境） |
| 8443 | kong | API 网关 HTTPS Proxy |
| 8080 | kafka-ui | Kafka 消息队列 UI |
| 9000 | sonarqube | 代码质量扫描 |
| 9090 | prometheus | 指标采集 |
| 9092 | kafka | Kafka Broker |
| 9200 | elasticsearch | BM25 检索 |

---

## 四、Kafka Topics（数据流骨架）

```
spec-normalizer ──[spec.submitted]──▶ code-generator ──[code.generated]──▶ executor
                                                        ──[code.generation.failed]──▶ 告警
executor ──[code.tested]──▶ 外部通知
         ──[code.manual_review]──▶ 通知服务
```

定义位置：`shared/types/index.ts` 中的 `KAFKA_TOPICS` 常量。
**新增 Topic 时必须同步更新此常量。**

---

## 五、数据库约定

### 表分组

| 分组 | 文件 | 表 |
|------|------|----|
| 业务核心 | init.sql | feature_specs, generation_tasks, score_records, audit_logs, failure_samples, developer_preferences |
| 记忆系统 | init.sql（已合并） | session_memories, project_memories, skill_memories, consolidation_logs |
| 动态配置 | dynamic-config-schema.sql | llm_providers, skill_definitions, agent_definitions, pipeline_definitions, kb_entries, system_settings |

### 重要约定
- **多租户**：所有查询必须带 `project_id` 过滤，使用 `gateway/tenant-db.js` 的 `TenantDB` 类
- **审计**：所有写操作（创建/修改/删除）都写 `audit_logs` 表
- **软删除**：重要数据不物理删除，用 `enabled = false` 标记
- **内置保护**：`is_builtin = true` 的 Skill/Agent 不可修改删除（API 层已检查）

---

## 六、Skill 系统（最常需要扩展的部分）

### 四种执行方式

| 类型 | 场景 | 关键字段 |
|------|------|---------|
| `llm_prompt` | 最常用，调 LLM 生成内容 | system_prompt, user_prompt_template, preferred_llm |
| `builtin_fn` | 调现有内置函数 | function_name（llmCallSkill / fileParserSkill / staticAnalysisSkill / knowledgeRetrievalSkill / memoryInjectSkill） |
| `http_webhook` | 集成外部工具/API | webhook_url, webhook_headers |
| `js_script` | 沙箱 JS 逻辑 | script_code（vm.runInNewContext，5s超时，只能 require path/crypto/util） |

### 模板变量（llm_prompt 模式）

```
{{spec}}                  完整 Spec JSON
{{spec.title}}            功能名称
{{spec.goal}}             功能目标
{{spec.entities}}         实体列表 JSON
{{spec.api_contract}}     API 契约 JSON
{{spec.rules}}            业务规则 JSON
{{spec.acceptance}}       验收标准 JSON
{{spec.priority}}         优先级
{{context.projectId}}     项目 ID
{{context.taskId}}        任务 ID
{{input}}                 本次调用的 input 对象
{{input.prev.<skill>}}    上一个 Skill 的输出（按 skill_names 顺序）
{{input.files}}           上游生成的文件列表
```

### 添加新 Skill（3种方式，优先用方式1）

**方式1：管理后台（无需改代码）**
```
http://localhost:3007 → Skills → 添加
填写字段参考 docs/SKILL_AGENT_SPEC.md
```

**方式2：直接插入数据库**
```sql
INSERT INTO skill_definitions (name, display_name, description, category, executor_type, 
  system_prompt, user_prompt_template, preferred_llm, max_tokens, temperature)
VALUES ('my-skill', '我的技能', '描述', 'custom', 'llm_prompt', 
  '系统提示词...', '用户提示词模板...', 'claude-sonnet-4', 4096, 0.2);
```

**方式3：代码硬编码（不推荐，只用于内置/不可删的 Skill）**
在 `services/agents/skills/builtin-skills.ts` 添加，并在 `executor_type = 'builtin_fn'` 的 Skill 中通过 `function_name` 引用。

---

## 七、Agent 系统

### 继承 BaseAgent（代码扩展）

```typescript
// services/agents/agents/my-agent.ts
import { BaseAgent, AgentContext, AgentOutput, Skill } from '../base/agent'

export class MyAgent extends BaseAgent {
  readonly name        = 'my-agent'
  readonly description = '一句话描述这个 Agent 做什么'
  readonly domain      = '*'           // 或 'game' / 'customer-service' 等
  readonly skills: Skill[] = [llmCallSkill, fileParserSkill]

  async execute(ctx: AgentContext): Promise<AgentOutput> {
    // ctx.spec          — 当前需求 Spec
    // ctx.prevOutputs   — 上游 Agent 的输出
    // ctx.projectId     — 项目 ID（租户隔离用）
    // ctx.config.model  — 当前使用的 LLM 模型
    const result = await this.skills[0].execute(ctx, { system: '...', user: '...' })
    return {
      agentName: this.name,
      status: 'done',
      data: { content: result.content },
      metadata: { durationMs: 0, retries: 0, skillsUsed: ['llm-call'] }
    }
  }
}

// 在 registry 中注册
import { registry } from '../registry/agent-registry'
registry.register(new MyAgent())
```

### 通过数据库添加 Agent（无需改代码，推荐）

在 `agent_definitions` 表插入，或用管理后台。`skill_names` 字段按顺序列出 Skill 名，运行时自动加载。

---

## 八、LLM 路由

**底层调用统一走 `LLMRouter`，不要直接 `new Anthropic()`。**

```typescript
import { getLLMRouter } from '../agents/dynamic/llm-router'
const router = getLLMRouter(pool)

// 普通调用
const result = await router.call({
  system: '...', user: '...',
  providerName: 'deepseek-v3',   // 不传则用 system_settings.default_llm
  maxTokens: 4096,
  temperature: 0.2,
})

// 流式调用
for await (const chunk of router.stream({ system, user })) {
  process.stdout.write(chunk)
}
```

**支持的 provider_type**：anthropic / openai / deepseek / gemini / qwen / zhipu / ollama / azure / custom

**添加新模型**：管理后台 → LLM 配置 → 添加，或直接插入 `llm_providers` 表。
LLM Router 有 60s 缓存，改完 DB 后最多等 60s 自动生效，**无需重启服务**。

---

## 九、知识库操作

```bash
# 添加种子代码（自动重建索引）
node knowledge-base/scripts/add-seed.js src/your-feature/ --feature=your_feature

# 只重建索引（修改了 seed-code 后）
node knowledge-base/scripts/build-index.js

# 写入向量库（需要 embedding API）
OPENAI_API_KEY=xxx node knowledge-base/scripts/vectorize.js

# 写入项目专属 collection（多租户隔离）
node knowledge-base/scripts/vectorize.js --project=my-game

# 通过管理后台直接添加条目
http://localhost:3007 → 知识库 → 添加条目
```

**向量检索**：设置 `ENABLE_VECTOR_SEARCH=true` 环境变量启用 Chroma 向量检索，与 BM25 结果合并去重。无此变量则仅用 BM25。

**质量基线**：知识库索引只收录 `quality_score >= 60` 的代码片段。
测试文件自动跳过（`*_test.go` / `*.test.ts`）。

---

## 十、多租户使用

```javascript
// Express 中间件（在各服务 app.use 中添加）
const { tenantMiddleware } = require('../../gateway/tenant-middleware')
app.use('/api', tenantMiddleware({ required: true }))

// 之后所有路由可以用 req.tenant.projectId
const db = new TenantDB(req.tenant.projectId)
const specs = await db.listSpecs({ status: 'submitted' })
```

**隔离范围**：PostgreSQL（WHERE project_id）、Chroma（Collection 命名）、ES（Index 命名）、Redis（Key 前缀）

---

## 十一、进化引擎

评分 + 人工反馈 → 自动修改 Prompt 约束（存在 `shared/prompts/dynamic-constraints.json`）

```javascript
const { EvolutionEngine } = require('./services/scorer/src/evolution-engine')
const engine = new EvolutionEngine()

// 低分时惩罚（executor 在 decision 端点调用）
await engine.applyLowScorePenalty(taskId, score, ['error ignored', 'magic number'])

// 高分时学习
await engine.learnFromHighScore(taskId, projectId, 92)

// 人工反馈时进化
await engine.evolveFromFeedback(taskId, '代码缺少并发安全处理', 2)
```

---

## 十二、扩展新领域（Checklist）

```
[ ] 1. 在 DOMAIN_CONFIGS（agent-registry.ts）添加领域配置（语言/框架/规范）
[ ] 2. 在 getFileRequirements（codegen-agent.ts）添加该语言的文件模板
[ ] 3. 在 knowledge-base/seed-code/ 添加该领域的参考代码
[ ] 4. 运行 node knowledge-base/scripts/build-index.js 重建索引
[ ] 5. （可选）在管理后台添加领域专用 Skill 和 Agent
[ ] 6. （可选）在 PIPELINE_TEMPLATES 添加流水线模板
[ ] 7. 在 BUILTIN_PIPELINE_CONFIGS 添加 JSON 配置
[ ] 8. 用 e2e-test.js 验证端到端流程
[ ] 9. 更新 docs/EXTENSIBILITY.md
```

---

## 十三、常见任务速查

### 添加新 API 端点
1. 在对应服务的 `src/routes/` 下创建路由文件
2. 在 `src/index.ts` 注册：`app.use('/api/v1/xxx', xxxRouter)`
3. 更新 `docs/API.md`

### 修改数据库表结构
1. 在对应的 `.sql` 文件添加 `ALTER TABLE` 或新建表
2. 重建 Docker Volume：`docker-compose down -v && ./scripts/start.sh infra`
3. 重新初始化知识库

### 新增环境变量
1. 在 `.env.example` 添加（含注释说明）
2. 在 `docker-compose.yml` 对应服务的 `environment` 添加
3. 更新 `docs/ARCHITECTURE.md` 中的配置说明

### 调试 Kafka 消息
```bash
# 打开 Kafka UI
http://localhost:8080
# 查看 Topic 消息、消费者组延迟
```

### 调试数据库
```bash
docker exec -it awp-postgres psql -U awp -d ai_workflow
# 或用 DBeaver / TablePlus 连接 localhost:5432
```

---

## 十四、已知问题和注意事项

1. **agents 服务不独立运行**：`services/agents/` 是被 code-generator 和 executor 引用的模块，不是独立的 HTTP 服务，docker-compose 中没有对应容器。

2. **scorer 服务不独立运行**：`services/scorer/` 被 executor 的 task-api.ts 通过相对路径 `require` 引用，不独立部署。

3. **dynamic-constraints.json 是进化数据**：这个文件由系统自动维护，每次 Reject + 低分会更新。本地开发时如果想重置，把 `version` 置 0、`enforced` 置 `[]` 即可。

4. **Chroma 向量检索是可选的**：Phase 1 只用 BM25（kb.json），不需要 Chroma 服务也能跑完整流程。向量检索提升质量但不是必须的。

5. **retrieval 服务是可选的**：code-generator 内置了内联检索（`services/code-generator/src/services/retrieval.ts`），retrieval 服务是 Phase 2 的独立部署版。设置 `RETRIEVAL_SERVICE_URL=http://retrieval:3008` 环境变量才会切换到独立服务。

6. **Kong API 网关是 DB-less 模式**：声明式配置文件 `infra/kong/kong.yml`，修改后 `docker-compose restart kong` 生效。Admin API 鉴权通过 `key-auth` 插件实现，消费者密钥同 `ADMIN_API_KEY` 环境变量。Kong Admin API 映射到 8002 端口（避免与 Chroma 8001 冲突）。

7. **CI/CD 使用 GitHub Actions**：`.github/workflows/ci.yml` 在 push/PR 时自动运行。包含 TypeScript 编译、E2E 逻辑测试、知识库验证、Docker 构建和集成测试 5 个 job。

8. **Prometheus 监控指标**：executor、code-generator、spec-normalizer 三个服务各有 `src/metrics.ts`，暴露 `/metrics` 端点（prom-client）。`prom-client` 未安装时指标为 `null`，可选链调用不影响业务。

---

## 十五、文件修改影响范围速查

| 修改文件 | 影响范围 | 需要做什么 |
|---------|---------|-----------|
| `infra/postgres/init.sql` | 数据库结构 | 重建 volume 或写 migration |
| `infra/postgres/dynamic-config-schema.sql` | 配置表结构 | 同上 |
| `knowledge-base/seed-code/**` | 知识库内容 | 重运行 build-index.js |
| `shared/types/index.ts` | 所有服务的类型 | 重新构建受影响的服务 |
| `shared/prompts/dynamic-constraints.json` | Prompt 约束 | 无需操作，自动生效 |
| `services/agents/dynamic/llm-router.ts` | LLM 调用路径 | 重启 code-generator/executor |
| `services/agents/dynamic/dynamic-loader.ts` | Skill/Agent 加载 | 重启相关服务 |
| `infra/kong/kong.yml` | API 网关路由 | `docker-compose restart kong` |
| `.github/workflows/ci.yml` | CI/CD 流程 | 推送后自动触发 |
| `docker-compose.yml` | 容器配置 | docker-compose up -d <服务名> |
| `.env` / `.env.example` | 环境变量 | 重启相关服务 |
