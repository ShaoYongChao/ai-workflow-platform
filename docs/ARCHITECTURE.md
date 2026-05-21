# 系统架构详解

## 一、设计原则

| 原则 | 实现方式 |
|------|---------|
| **零代码扩展** | Skill/Agent/LLM/流水线全部数据库驱动，管理后台配置即生效 |
| **知识不外泄** | 只传接口契约，不传实现体；本地向量库，不上云 |
| **闭环进化** | 评分→失败样本→Prompt约束进化，越用越准 |
| **优雅降级** | 每个外部依赖（LLM/Neo4j/Chroma）都有 fallback；测试沙箱模块下载失败时降级为编译检查 |
| **租户隔离** | project_id 贯穿所有查询，Chroma/ES/Redis 命名空间隔离 |

---

## 二、数据流

### 完整请求链路

```
策划输入（WebSocket）
    │
    ▼
spec-normalizer
    ├── 多轮对话（最多5轮）
    ├── Zod Schema 校验
    ├── 完整度评分（>=90% 才可提交）
    └── 写 feature_specs 表 → Kafka: spec.submitted
                                      │
                                      ▼
                              code-generator（消费）
                                      ├── retrieveContext()
                                      │     ├── BM25 关键词检索（kb.json）
                                      │     ├── 文本相似度匹配
                                      │     └── Neo4j 图谱调用链（可选）
                                      ├── 并发生成 Go + TS + C#
                                      │     └── LLM Router → 对应 Provider
                                      ├── 文件解析 + 静态验证
                                      └── 写 generation_tasks → Kafka: code.generated
                                                                          │
                                                                          ▼
                                                               executor（消费）
                                                                  ├── 创建 Docker 沙箱
                                                                  ├── 写入文件
                                                                  ├── go test + jest
                                                                  ├── 失败 → Auto-Fix（x3）
                                                                  │     └── LLM 分析错误 → 重新生成
                                                                  ├── 评分计算
                                                                  ├── 写 score_records
                                                                  ├── Redis publish → WebSocket
                                                                  └── Kafka: code.tested
                                                                                │
                                                                                ▼
                                                                    VS Code 插件（WebSocket）
                                                                       ├── 任务列表更新
                                                                       ├── 只读预览 / 批量对比
                                                                       └── Accept/Reject → 评分 → 写 audit_logs
```

### Kafka Topics

| Topic | 生产者 | 消费者 | 说明 |
|-------|--------|--------|------|
| `spec.submitted` | spec-normalizer | code-generator | 新需求已完成 |
| `code.generated` | code-generator | executor | 代码已生成 |
| `code.tested` | executor | （外部系统/通知） | 测试通过 |
| `code.manual_review` | executor | （通知服务） | 需人工介入 |
| `code.generation.failed` | code-generator | （告警） | 生成失败 |

---

## 三、数据库设计

### 业务表（init.sql）

```
feature_specs         需求 Spec
generation_tasks      代码生成任务
score_records         评分记录
audit_logs            操作审计（合规）
failure_samples       失败样本（用于模型优化）
developer_preferences 开发者偏好（个性化）
```

### 记忆系统表（已合并到 init.sql）

```
session_memories      会话记忆（24h TTL）
project_memories      长期项目记忆
skill_memories        可复用技能模板
consolidation_logs    记忆巩固日志
```

### 动态配置表（dynamic-config-schema.sql）

```
llm_providers         LLM 模型配置（预置14个）
skill_definitions     Skill 定义（4种执行方式）
agent_definitions     Agent 定义（Skill组合）
pipeline_definitions  流水线 DAG 配置
kb_entries            知识库条目
system_settings       系统全局配置
```

---

## 四、Agent 系统

### Agent 生命周期

```
registry.register(agent)          # 注册
    │
taskBus.run(pipelineConfig)       # 启动流水线
    │
    ├── 拓扑排序，找就绪节点
    ├── Promise.all（并发执行就绪节点）
    │     └── agent.run(ctx)
    │           ├── execute(ctx)   # 子类实现
    │           ├── 超时控制
    │           ├── 指数退避重试
    │           └── EventEmitter 广播 done/failed
    └── 收集 outputs，传给下游
```

### 动态 Skill 执行流程

```
DB: skill_definitions
    │ (DynamicSkillFactory.buildSkill)
    ▼
Skill 实例（闭包）
    │ execute(ctx, input)
    ├── llm_prompt   → interpolate(template, vars) → LLMRouter.call()
    ├── builtin_fn   → require('./builtin-skills')[functionName].execute()
    ├── http_webhook → fetch(webhookUrl, { body: JSON.stringify({ ctx, input }) })
    └── js_script    → vm.runInNewContext(code, sandbox, { timeout: 5000 })
```

### LLM Router 调用链

```
LLMRouter.call({ providerName, system, user })
    │
    ├── refreshCache()（60s TTL，从 llm_providers 表读）
    ├── resolveProvider(name)
    ├── resolveApiKey(provider)（env 变量 or DB 存储的加密 key）
    └── switch(providerType)
          ├── anthropic  → Anthropic SDK
          ├── openai     → OpenAI SDK
          ├── deepseek   → OpenAI 兼容，baseURL=api.deepseek.com
          ├── gemini     → Google Generative Language API
          ├── qwen       → OpenAI 兼容，baseURL=dashscope.aliyuncs.com
          ├── zhipu      → OpenAI 兼容，baseURL=open.bigmodel.cn
          ├── ollama     → http://localhost:11434/api/chat
          ├── azure      → OpenAI 兼容，baseURL=azure-endpoint
          └── custom     → OpenAI 兼容，baseURL=provider.base_url
```

---

## 四-1、Phase 5: 动态管道选择系统（2026-05-21）

**目标**：无需改代码即可动态切换代码生成和自动修复策略，支持领域特化和多租户隔离。

### 管道选择流程

**在 code-generator 中的运行时选择**：
```typescript
// 1. 从 pipeline_definitions 表加载管道
const pipeline = await loadPipelineFromDb(domainKey, projectId)
// 按 domain 和 project_id 过滤：
// - domain 匹配当前 Spec（如 'game-server'、'customer-service'）
// - project_id 用于多租户隔离
// - 无匹配时自动降级到内置管道

// 2. 启动 TaskBus DAG 执行
const outputs = await taskBus.run(pipeline, ctx)
```

**在 executor 中的 auto-fix 管道选择**：
```typescript
// 1. 根据 projectId 加载自定义修复策略
const fixPipeline = await loadAutoFixPipelineFromDb(projectId)
// 支持自定义修复 Agent 和 Skill 组合

// 2. 3 次重试循环，每次使用相同管道
for (let attempt = 1; attempt <= maxRetries; attempt++) {
  const result = await taskBus.run(fixPipeline, ctx)
  if (result.status === 'success') break
}
```

### 前端管理 UI（admin-web）

**新增「流水线」Tab**，支持：
- ✅ CRUD 操作：创建、查看、编辑、测试、删除管道
- ✅ 循环依赖检测：DAG 拓扑排序校验，防止死循环
- ✅ 默认管道保护：`is_builtin=true` 的管道不可删除/修改
- ✅ 实时验证：添加/修改时即时反馈错误

**关键文件**：`frontend/admin-web/public/index.html` 的 Pipeline 页签（+100 行 HTML/JS）

### 数据库表结构扩展

```sql
-- Phase 5 已在 dynamic-config-schema.sql 中定义
CREATE TABLE pipeline_definitions (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  display_name VARCHAR(255),
  domain VARCHAR(100),
  project_id VARCHAR(100),
  description TEXT,
  agents_dag JSONB NOT NULL,  -- Agent DAG 配置
  skill_overrides JSONB,      -- 技能覆盖映射
  is_builtin BOOLEAN DEFAULT false,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

**agents_dag 格式示例**：
```json
{
  "nodes": [
    {"id": "codegen", "type": "agent", "name": "code-generator-agent"},
    {"id": "lint", "type": "skill", "name": "lint-skill"}
  ],
  "edges": [
    {"from": "codegen", "to": "lint"}
  ]
}
```

### E2E 测试验证

**文件**：`scripts/phase5-e2e-test.js` (+300 行，11 个测试用例)

覆盖内容：
- ✅ Pipeline CRUD 操作
- ✅ 循环依赖检测（正负例）
- ✅ 名称唯一性校验
- ✅ 默认管道保护
- ✅ runtime 选择（code-generator 按 domain + projectId）
- ✅ auto-fix 管道加载和重试循环

**运行方式**：
```bash
node scripts/phase5-e2e-test.js
# 输出：✓ 11/11 tests passed
```

### 优势和特点

| 特点 | 说明 |
|------|------|
| 零代码扩展 | 管道配置完全数据库驱动，无需改代码 |
| 领域特化 | 支持按 domain 加载不同的 Agent 组合 |
| 多租户隔离 | 同一 domain 下不同项目可使用不同管道 |
| 自动降级 | 无匹配时回落到内置管道，保证服务可用性 |
| 安全保护 | is_builtin=true 防止意外修改核心流水线 |

---

## 五、知识库架构（Hybrid RAG）

```
知识库来源
    ├── 种子代码（knowledge-base/seed-code/）手动维护
    ├── 管理后台手动添加（kb_entries 表）
    └── Git Hook 自动同步（生产环境配置）
            │
            ▼
    build-index.js（AST 解析）
    ├── Tree-sitter 提取 interface/struct/function 签名
    ├── 去掉实现体，只保留接口契约
    └── 生成 kb.json（BM25 用）和 chunks/（向量化用）
            │
    ┌───────┴───────┐
    ▼               ▼
BM25 检索         向量检索
(kb.json)        (Chroma)
    │               │
    └───────┬────────┘
            ▼
      dedupeAndRank()
      （接口类型优先）
            │
            ▼
   Neo4j 图谱增强
   （注入真实调用链）
            │
            ▼
    RetrievalContext
    → 注入 code-generator Prompt
```

**过滤规则（防止学习屎山代码）：**
- 圈复杂度 > 10 的片段不入库
- 包含 `TODO/FIXME` 的片段降权
- 测试文件不入库（防止 AI 复制 mock）
- 管理后台可设置 `quality_score` 阈值（默认 60）

---

## 六、多租户隔离

所有资源按 `project_id` 隔离：

| 资源 | 隔离方式 | 状态 |
|------|---------|------|
| PostgreSQL | WHERE project_id = $1（TenantDB 封装） | ✅ 已实现 |
| Chroma | Collection 命名：`awp_{project_id}_kb`（retrieval.ts 已实现） | ✅ 已实现 |
| Redis | Key 前缀：`awp:{project_id}:` | ✅ 已实现 |
| Elasticsearch | Index 命名：`awp-kb-{project_id}` | ✅ 已实现 |
| Neo4j CE | Label 前缀隔离（Enterprise 版用独立 database） | ✅ 已实现 |

**Chroma 多租户向量化：**
```bash
# 向默认共享 collection 写入（无 project_id 隔离）
node knowledge-base/scripts/vectorize.js

# 向项目专属 collection 写入
node knowledge-base/scripts/vectorize.js --project=my-game-project
# → 写入 awp_my_game_project_kb collection
```

**向量检索多租户查询流程：**
```
retrieveContext(spec, projectId)
    │
    ├── BM25 + TextMatch（kb.json，共享）
    ├── ENABLE_VECTOR_SEARCH=true 时：
    │     └── searchByVector(spec, projectId)
    │           ├── projectId 存在 → collection: awp_{projectId}_kb
    │           └── 无 projectId  → collection: awp_knowledge_base（回落）
    └── Neo4j 图谱增强（可选）
```

请求验证流程：
```
HTTP Request
    │
tenant-middleware.js
    ├── 提取 X-Project-ID Header
    ├── 格式校验（字母数字+短横线，3-64字符）
    ├── 可选白名单验证
    └── 挂载 req.tenant = { projectId, developerId, requestId }
```

---

## 七、安全设计

| 威胁 | 防护措施 |
|------|---------|
| 代码泄漏 | 本地部署，最小上下文原则，云端传输前脱敏 |
| 知识库污染 | 质量分过滤，测试文件排除，圈复杂度限制 |
| SQL 注入 | 参数化查询，TenantDB 强制 WHERE |
| JS 沙箱逃逸 | vm.runInNewContext + 5s超时 + require 白名单 |
| API 未授权 | Admin API Key 验证，所有写操作写入 audit_logs（resource_type/resource_id/ip_address 完整记录） |
| 内置 Skill 篡改 | is_builtin=true 的记录不可修改/删除 |
| 明文密钥泄漏 | logAudit() 自动脱敏 api_key_value/api_key_env 字段 |

---

## 八、监控指标

每个服务已实现 `GET /metrics` 端点（Prometheus text format），需安装 `prom-client` 后生效：

```bash
cd services/executor       && npm install
cd services/code-generator && npm install
cd services/spec-normalizer && npm install
```

**已实现指标（prom-client，lazy-require 模式）：**

| 指标 | 服务 | 说明 |
|------|------|------|
| `awp_test_pass_total` | executor | 测试通过次数（language 标签） |
| `awp_test_fail_total` | executor | 测试失败次数（language 标签） |
| `awp_autofix_total` | executor | Auto-Fix 触发次数（result: success\|exhausted） |
| `awp_manual_review_total` | executor | 降级人工审查次数（reason: not_fixable\|exhausted） |
| `awp_task_duration_seconds` | executor | 任务端到端耗时分布（Histogram） |
| `awp_generation_total` | code-generator | 代码生成次数（status: started\|success\|failed） |
| `awp_generation_duration_seconds` | code-generator | 生成耗时分布（Histogram） |
| `awp_llm_tokens_total` | code-generator | LLM Token 消耗（provider + type 标签） |
| `awp_specs_total` | spec-normalizer | 需求提交次数（status 标签） |
| `awp_ws_connections_active` | spec-normalizer | 当前活跃 WebSocket 连接数（Gauge） |
| `awp_dialogue_turns_total` | spec-normalizer | 多轮对话轮次累计 |
| `awp_node_*` | all | Node.js 默认指标（GC、内存、事件循环延迟等） |

**降级设计：** `prom-client` 未安装时，`metrics.ts` 中所有指标为 `null`，业务逻辑中通过可选链 `?.inc()` 调用，不影响主流程。

Grafana Dashboard 预置面板（通过 Prometheus 数据源）：
- 系统总览（任务量、通过率、Auto-Fix 分布）
- 代码生成分析（成功率、耗时 P95/P99）
- LLM 使用分析（各模型 Token 消耗趋势）

---

## 八-1、前端架构说明

### planner-web（端口 3000）
Next.js 14 App Router，WebSocket 流式对话，Spec 预览面板。

### admin-web（端口 3007）
**不是** Next.js —— 是 Node.js 静态服务器（`server.js`）直接 serve `public/index.html`。

- 服务器在 HTML 响应中注入运行时配置：
  ```html
  <script>
    window.__AWP_API__ = 'http://localhost:3006';
    window.__AWP_KEY__ = 'awp_admin_2024';
  </script>
  ```
- 页面从 `localStorage` 或 `window.__AWP_KEY__` 读取 Admin Key，无需登录页面
- 修改 UI：直接编辑 `public/index.html`，刷新浏览器即可生效（无需构建）

### VS Code 插件（Extension Host）

```
extension.ts（入口）
    ├── ExecutorClient       HTTP 客户端（Node http/https），调用 executor :3004
    ├── WSClient             WebSocket（ws 库），订阅实时任务推送 + 自动重连 + 心跳
    ├── TasksProvider        TreeDataProvider（含离线缓存 workspaceState）
    ├── KnowledgeProvider    知识库浏览 TreeView（按语言 > 文件 > chunk）
    ├── ConsoleViewProvider  执行控制台 WebView（连接状态 + 实时日志）
    └── registerCommands()   所有命令（只读预览 / 批量对比 / 局部接受 / 评分上报 / KB追溯）
```

离线缓存机制：
- `TasksProvider` 构造时从 `workspaceState` 恢复最多 50 个任务
- 网络连接失败时展示缓存任务，并显示 Warning 提示
- 任务接受/拒绝后通过 `updateTaskStatus()` 乐观更新本地缓存

### Executor 沙箱（智能依赖管理）

每次任务创建一个临时沙箱目录（`/tmp/awp-<taskId8>-xxx/`），包含：

```
<sandbox>/
├── go/         Go 模块目录（含 go.mod + go.sum）
└── ts/         TypeScript 项目目录（含 package.json + jest.config.json + tsconfig.json）
```

**依赖自动检测流程：**
```
生成代码文件
    ├── detectGoImports()   扫描 import "..." → 过滤标准库 → 取前3段模块路径
    │   └── 匹配 knownVersions → 写入 go.mod require 块
    └── detectTSPackages()  扫描 import ... from '...' / require('...')
        └── 匹配 versionMap（30+ 常用包）→ 写入 package.json dependencies
```

**测试降级策略：**
| 场景 | 策略 |
|------|------|
| Go 模块下载成功 | `go test -v -json -cover ./...` |
| Go 模块下载失败（网络/GOSUM）| `go build ./...`（GOPROXY=off，仅编译检查） |
| go 命令不可用 | 静态分析（检查 package 声明、panic 调用等） |
| npm install 成功 | `jest --json --coverage` |
| npm install 部分失败 | 重试 `--legacy-peer-deps` |
| node 命令不可用 | 静态分析（检查 any 类型、console.log 等） |

---

## 八-2、API 网关（Kong）

Kong 3.6 DB-less 模式，声明式配置文件 `infra/kong/kong.yml`。

```
外部请求 → Kong (:8000)
              ├── /api/spec-normalizer/*  → spec-normalizer:3001
              ├── /ws/spec               → spec-normalizer:3001 (WebSocket)
              ├── /api/code-generator/*  → code-generator:3003
              ├── /api/executor/*        → executor:3004
              ├── /ws/tasks              → executor:3004 (WebSocket)
              ├── /api/admin/*           → admin:3006 (key-auth 鉴权)
              ├── /admin/*               → admin-web:3007
              ├── /api/retrieval/*       → retrieval:3008
              └── /                      → planner-web:3000
```

**全局插件：** cors（跨域）、request-size-limiting（10MB）、rate-limiting（300 req/min）、correlation-id（X-Request-Id 追踪）

**Admin API 专用插件：** key-auth（X-Admin-Key 鉴权，60 req/min 限流）

---

## 八-3、CI/CD（GitHub Actions）

`.github/workflows/ci.yml` 包含 5 个并行 Job：

| Job | 内容 | 触发条件 |
|-----|------|---------|
| `ts-compile` | 4 个 TypeScript 服务的 `tsc --noEmit`（Matrix 并行） | push main/dev, PR main |
| `e2e-test` | `node scripts/e2e-test.js`（Mock LLM 逻辑验证） | 同上 |
| `knowledge-base` | `build-index.js --dry-run` + kb.json 验证 | 同上 |
| `docker-build` | 5 个服务 Docker 镜像构建（Matrix 并行） | 同上 |
| `integration` | Docker Compose 基础设施 + DB schema 验证 | 依赖 docker-build |

带 `concurrency` 组防重复运行。

---

## 八-4、第三方库详解

### 核心依赖

| 库名 | 版本 | 作用 | 使用场景 | 替代方案 |
|------|------|------|---------|---------|
| **@anthropic-ai/sdk** | ^0.20.0 | Claude LLM API 调用 | code-generator, executor, spec-normalizer | openai SDK (GPT), google-generativeai (Gemini) |
| **openai** | ^4.20.0 | OpenAI GPT 调用 + 流式输出支持 | LLMRouter 多模型支持 | 其他 LLM SDK |
| **express** | ^4.18.2 | HTTP 框架（路由、中间件） | 所有 Node.js 服务的基础框架 | fastify, hapi, koa |
| **kafkajs** | ^2.2.4 | Kafka 客户端（事件驱动） | 服务间异步通信（spec→code→test 流水线） | RabbitMQ, Redis Streams |
| **pg** | ^8.11.3 | PostgreSQL 驱动 | 所有服务的数据库连接 | mysql, sqlite3, mongodb |
| **ioredis** | ^5.3.2 | Redis 客户端（内存缓存、发布订阅） | LLM Router 60s 缓存、WebSocket 实时推送、Session 管理 | redis, node-redis |
| **ws** | ^8.18.0 | WebSocket 服务器（双向通信） | spec-normalizer/executor 的实时推送、VS Code 插件订阅 | socket.io, Engine.IO |
| **zod** | ^3.22.4 | 运行时 Schema 校验（类型安全） | Spec 完整度检查、Skill/Agent 配置验证 | joi, yup, io-ts |
| **uuid** | ^9.0.0 | 唯一标识生成 | 任务 ID、请求 ID、项目 ID | crypto.randomUUID() (Node 15+) |
| **pino** | ^8.16.0 | JSON 日志库（结构化日志） | 所有服务的日志输出（便于聚合分析） | winston, bunyan, pino-pretty |
| **prom-client** | ^15.1.0 | Prometheus 指标库（性能监控） | /metrics 端点，懒加载（可选） | micrometer (Java), prometheus_client (Python) |
| **dotenv** | ^16.3.1 | 环境变量加载 | 开发环境配置隔离 | 环境变量直接设置 |
| **cors** | ^2.8.5 | CORS 中间件 | 跨域资源共享（前端调用后端） | 手写 CORS headers |
| **helmet** | ^7.1.0 | HTTP 安全头中间件 | 防止 XSS/CSRF/点击劫持 | 无（手写较麻烦） |
| **express-validator** | ^7.0.1 | 请求验证中间件 | HTTP 参数校验（POST/PUT 数据合法性） | joi, yup with express |
| **xml2js** | ^0.6.2 | XML 解析和生成 | executor 解析 `go test -json` 的 XML/JSON 混合输出 | sax-js, xsd |

### 前端依赖（admin-web）

- **零依赖** —— 纯 HTML + 原生 JavaScript + Node.js 内置 `http` 模块
- **server.js** —— 静态文件服务器 + 运行时配置注入

### 前端依赖（planner-web）

Next.js 14 App Router（部分依赖，查看具体 `frontend/planner-web/package.json`）

### 开发依赖

| 库名 | 作用 |
|------|------|
| **typescript** | TypeScript 编译器（类型检查） |
| **ts-node-dev** | 开发时 TS 自动编译 + 热重载 |
| **jest** | 单元测试框架 |
| **ts-jest** | Jest + TypeScript 集成 |
| **@types/\*** | 类型定义文件（ts-node 编译依赖） |

---

## 九、环境变量完整清单

### 通用变量

| 变量名 | 默认值 | 服务 | 说明 |
|--------|--------|------|------|
| `NODE_ENV` | development | all | 环境标识（development/production） |
| `LOG_LEVEL` | info | all | 日志级别（debug/info/warn/error） |
| `ADMIN_API_KEY` | awp_admin_2024 | admin, Kong | 管理 API 密钥（限制 /api/admin 访问） |
| `OPENAI_API_KEY` | 无 | code-generator, executor | OpenAI API 密钥（可选，LLMRouter 用） |
| `ANTHROPIC_API_KEY` | 无 | code-generator, executor | Claude API 密钥（推荐，LLMRouter 用） |

### 服务特定变量

| 变量名 | 默认值 | 服务 | 说明 |
|--------|--------|------|------|
| `SPEC_NORMALIZER_PORT` | 3001 | spec-normalizer | 需求标准化服务端口 |
| `CODE_GENERATOR_PORT` | 3003 | code-generator | 代码生成服务端口 |
| `EXECUTOR_PORT` | 3004 | executor | 执行服务端口 |
| `ADMIN_PORT` | 3006 | admin | 管理 API 端口 |
| `ADMIN_WEB_PORT` | 3007 | admin-web | 管理后台前端端口 |
| `RETRIEVAL_PORT` | 3008 | retrieval | 检索服务端口（Phase 2，可选） |
| `RETRIEVAL_SERVICE_URL` | 无 | code-generator | 外部检索服务 URL（若设置则使用外部服务） |
| `ENABLE_VECTOR_SEARCH` | false | code-generator | 是否启用 Chroma 向量检索（需要 OPENAI_API_KEY） |
| `KNOWLEDGE_BASE_DIR` | ./knowledge-base | code-generator | 知识库路径 |
| `KB_QUALITY_THRESHOLD` | 60 | code-generator | 知识库索引的最低质量分数 |

### 数据库变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `POSTGRES_HOST` | postgres | PostgreSQL 主机 |
| `POSTGRES_PORT` | 5432 | PostgreSQL 端口 |
| `POSTGRES_USER` | awp | PostgreSQL 用户 |
| `POSTGRES_PASSWORD` | awp123 | PostgreSQL 密码 |
| `POSTGRES_DB` | ai_workflow | 数据库名 |
| `REDIS_URL` | redis://redis:6379 | Redis 连接字符串 |
| `KAFKA_BROKERS` | kafka:9092 | Kafka broker 地址（逗号分隔） |
| `NEO4J_URI` | bolt://neo4j:7687 | Neo4j Bolt 协议地址 |
| `NEO4J_USER` | neo4j | Neo4j 用户 |
| `NEO4J_PASSWORD` | password | Neo4j 密码 |
| `CHROMA_HOST` | chroma | Chroma 主机 |
| `CHROMA_PORT` | 8001 | Chroma 端口 |

### LLM 配置变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `DEFAULT_LLM_PROVIDER` | anthropic | 默认 LLM（anthropic/openai/deepseek/...） |
| `DEEPSEEK_API_KEY` | 无 | Deepseek API 密钥 |
| `GEMINI_API_KEY` | 无 | Google Gemini API 密钥 |
| `QWEN_API_KEY` | 无 | 阿里云通义千问 API 密钥 |
| `ZHIPU_API_KEY` | 无 | 智谱 ChatGLM API 密钥 |
| `AZURE_OPENAI_KEY` | 无 | Azure OpenAI API 密钥 |
| `AZURE_OPENAI_ENDPOINT` | 无 | Azure OpenAI endpoint URL |
| `OLLAMA_BASE_URL` | http://localhost:11434 | Ollama 本地模型地址 |

### 特性开关

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `ENABLE_GRAPH_SCHEMA_CHECK` | false | 是否启用 Neo4j 图谱验证（可选，性能敏感） |
| `ENABLE_KNOWLEDGE_BASE_CACHE` | true | 是否缓存知识库索引（推荐 true） |
| `ENABLE_AUDIT_LOG` | true | 是否记录审计日志 |
| `AUTO_FIX_MAX_RETRIES` | 3 | Auto-Fix 最大重试次数 |
| `TASK_TIMEOUT_SECONDS` | 300 | 任务执行超时（秒） |
| `LLM_ROUTER_CACHE_TTL` | 60 | LLM 路由器缓存时间（秒） |

---

## 九-1、网络拓扑和部署架构

### 部署拓扑图

```
┌─────────────────────────────────────────────────────────────────┐
│                      外部网络 / 内网                              │
└─────────────────────────────────────────────────────────────────┘
                    │
        ┌───────────┴────────────┐
        ▼                        ▼
   浏览器 (3000)        VS Code 插件
        │                        │
        ├────────────┬───────────┘
        │            │
        ▼            ▼
┌─────────────────────────────────┐
│     Kong API Gateway (:8000)     │  ← 统一入口（CORS、限流、鉴权）
├─────────────────────────────────┤
│ 路由规则：                        │
│ /api/spec-*      → :3001         │
│ /ws/spec         → :3001 (WS)   │
│ /api/code-*      → :3003         │
│ /api/executor/*  → :3004         │
│ /ws/tasks        → :3004 (WS)   │
│ /api/admin/*     → :3006 (KEY)  │
│ /admin/*         → :3007         │
│ /                → :3000         │
└─────────────────────────────────┘
        │
        ├─────────────────────────────┬──────────────┬───────────────┐
        ▼                             ▼              ▼               ▼
┌──────────────────┐  ┌─────────────────────┐ ┌───────────────┐ ┌──────────┐
│ spec-normalizer  │  │ code-generator      │ │   executor    │ │  admin   │
│   :3001 (WS)    │  │    :3003 (REST)     │ │ :3004 (WS)   │ │  :3006   │
├──────────────────┤  ├─────────────────────┤ ├───────────────┤ ├──────────┤
│ • Zod 校验       │  │ • Kafka 消费        │ │ • Docker 沙箱 │ │ • CRUD   │
│ • WebSocket 对话 │  │ • LLM 生成多语言    │ │ • 测试执行    │ │   Skill  │
│ • Kafka 生产     │  │ • 知识库检索        │ │ • Auto-Fix    │ │ • Agent  │
│ • Redis 缓存     │  │ • 流水线执行        │ │ • 评分计算    │ │ • LLM    │
└──────────────────┘  └─────────────────────┘ └───────────────┘ │ • 管道   │
        │                    │                      │              │ • 用户   │
        └────────┬───────────┴──────────┬──────────┘              └──────────┘
                 │                      │
        ┌────────▼──────┐      ┌────────▼──────┐
        │   Kafka :9092 │      │ Redis :6379   │
        │   (async msg) │      │  (cache/pub)  │
        └───────────────┘      └───────────────┘
                 │                      │
    ┌────────────┴──────────┬───────────┴─────────┐
    ▼                       ▼                     ▼
┌─────────────┐   ┌──────────────────┐   ┌──────────────┐
│ PostgreSQL  │   │    Chroma        │   │   Neo4j      │
│   :5432     │   │  (向量库) :8001  │   │   :7687      │
│             │   │                  │   │              │
│ (10 业务表) │   │ (K-NN 检索)      │   │ (图谱增强)   │
│ (4 记忆表)  │   │                  │   │              │
│ (6 配置表)  │   │ (可选)           │   │ (可选)       │
└─────────────┘   └──────────────────┘   └──────────────┘

数据流向：
spec.submitted (Kafka)
    │
    ├→ code-generator (消费)
    │       ├→ 知识库检索 (BM25 + 向量)
    │       ├→ LLM 生成代码
    │       └→ Kafka: code.generated
    │
    ├→ executor (消费)
    │       ├→ Docker 测试
    │       ├→ 失败时触发 Auto-Fix
    │       ├→ Redis Publish: task.completed
    │       └→ Kafka: code.tested / code.manual_review
    │
    └→ VS Code 插件 (WebSocket 监听)
           └→ 任务通知 + 代码预览
```

### 容器编排（docker-compose.yml）

```yaml
version: '3.9'
services:
  # 基础设施（5个）
  postgres:      环境变量 POSTGRES_* 控制，初始化脚本 init.sql + dynamic-config-schema.sql
  redis:         缓存 + 发布订阅 + Session 管理
  kafka:         消息队列（3 Topics）
  chroma:        向量数据库（可选，ENABLE_VECTOR_SEARCH=true）
  neo4j:         图数据库（可选，ENABLE_GRAPH_SCHEMA_CHECK=true）
  
  # 业务服务（4个）
  spec-normalizer:  需求标准化（WS）
  code-generator:   代码生成（消费 Kafka）
  executor:         执行和测试（消费 Kafka，WS）
  admin:            管理 API（REST）
  
  # 中间件/网关
  kong:          API 网关（入口）
  kong-admin:    Kong 管理接口（仅开发）
  
  # 监控/工具
  grafana:       仪表板可视化（:3005）
  prometheus:    指标采集（:9090）
  sonarqube:     代码质量（:9000，可选）
  kafka-ui:      消息队列 UI（:8080）
  elasticsearch: 日志/全文检索（:9200，可选）
```

---

## 十、关键配置文件说明

### docker-compose.yml

**核心设计**：20 个容器，通过环境变量驱动配置，无需修改代码。

```yaml
# 环境变量注入示例
spec-normalizer:
  environment:
    - PORT=3001
    - KAFKA_BROKERS=kafka:9092
    - POSTGRES_URL=postgresql://awp:awp123@postgres:5432/ai_workflow
    - REDIS_URL=redis://redis:6379
    - DEFAULT_LLM_PROVIDER=anthropic
    - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}  # 从 .env 读取
```

### infra/kong/kong.yml

Kong DB-less 声明式配置（修改后需 `docker-compose restart kong`）：

```yaml
_format_version: "3.0"
_transform: true

services:              # 定义上游服务
  - name: spec-normalizer
    host: spec-normalizer
    port: 3001

routes:               # 定义路由规则
  - name: spec-api
    service: spec-normalizer
    paths: ["/api/spec-normalizer"]
    strip_path: true

plugins:              # 全局插件
  - name: cors
  - name: rate-limiting
    config: { minute: 300 }
  - name: request-size-limiting
    config: { size_limit: 10485760 }   # 10MB
```

### .env.example / docker-compose.yml 中的 environment

所有环境变量的权威来源。部署时：

```bash
cp .env.example .env
# 编辑 .env，填入实际的 API 密钥
docker-compose up
```

---

## 十-1、服务间通信矩阵

```
                       ▼ Kafka      ▼ HTTP        ▼ WebSocket   ▼ 数据库
spec-normalizer        [生产]       [调用 LLM]    [推送对话]     [W: specs]
code-generator         [消费]       [调用 LLM]    —             [R: specs, W: tasks]
executor               [消费]       [调用 LLM]    [推送测试结果] [R: tasks, W: scores]
admin                  —            [REST API]    —             [CRUD config]
VS Code 插件           —            [REST]       [监听 executor] —
```

---

## 九、性能基准

> 基于 MacBook Pro M2 + Claude Sonnet 4 测试结果

| 场景 | 耗时 | 备注 |
|------|------|------|
| Spec 标准化（2轮对话） | 8-15s | 含 LLM 流式输出 |
| Go 代码生成（4文件） | 20-40s | 取决于功能复杂度 |
| TS 代码生成（4文件） | 15-30s |  |
| 知识库检索（BM25） | <10ms | 内存检索 |
| 测试执行（go test） | 5-30s | 含沙箱启动 |
| 测试执行（jest，首次） | 40-90s | npm install（prefer-offline）+ 运行 |
| 测试执行（jest，有缓存） | 5-15s | node_modules 已存在 |
| Auto-Fix 单次 | 15-30s | 含 LLM 分析 |
| 端到端（无 Auto-Fix）| 60-120s | Spec→代码→测试 |

---

## 十、Phase 路线图

| Phase | 状态 | 主要功能 |
|-------|------|---------|
| Phase 1 MVP | ✅ 完成 | Spec输入→代码生成→测试→VS Code Review |
| Phase 2 核心能力 | ✅ 完成 | Hybrid RAG + 双端生成 + Auto-Fix + 沙箱依赖自动检测 |
| Phase 3 质量进化 | ✅ 完成 | 评分✅，记忆系统✅，进化引擎完整闭环✅，SonarQube（可选） |
| Phase 4 生产部署 | ✅ 完成 | 多租户✅，Prometheus指标✅，审计日志✅，Kong API 网关✅，GitHub Actions CI/CD✅ |
| Phase 5 Agent化 | ✅ 完成 | 多Agent协作 + 动态配置（管理后台驱动） |
| Phase 6 领域扩展 | 🔄 持续 | 客服/分析/公文等垂直领域 |
| Phase 7 SaaS化 | 📋 规划 | 多组织 + 计费 + 插件市场 |
