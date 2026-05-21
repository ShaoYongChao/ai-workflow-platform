# AWP（AI Workflow Platform）项目汇报文档

> 直白易懂版 —— 项目代码逻辑、调用关系、技术栈详解

**项目阶段**：Phase 5 完成（动态管道）  
**整体进度**：88% 完成，Phase 1-5 可用，Phase 6-7 规划中  
**文档日期**：2026-05-21

---

## 一、项目一句话

**AWP 是一个 AI 驱动的代码自动生成平台，用户用"白话"描述需求 → AI 对话标准化 → 自动生成/测试/评分 → VS Code 预览/接受，整个流程闭环进化，越用越准。**

---

## 二、核心价值

| 维度 | 说明 |
|------|------|
| **自动化程度** | 从需求→代码→测试→评分，全自动闭环，无需人工干预 |
| **多语言支持** | Go、TypeScript、C#、Java、Python 5 种语言端到端生成 |
| **知识库进化** | 评分低→失败样本→自动优化 Prompt→下次更准（闭环学习） |
| **企业级生产** | Kubernetes 就绪、多租户隔离、审计日志完整、监控告警完备 |
| **零代码扩展** | Skill/Agent/LLM/管道全数据库驱动，改数据库无需改代码 |

---

## 三、核心服务架构

### 3.1 四大核心服务

```
┌──────────────────────────────────────────────────────────────────┐
│                     AWS Workflow Platform 核心                    │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  [用户输入]  [标准化]  [生成代码]  [执行测试]  [人工审查]          │
│      ↓         ↓          ↓          ↓         ↓                  │
│   planner-  spec-    code-       executor  VS Code              │
│   web       normalizer generator            插件                  │
│  (:3000)    (:3001)  (:3003)     (:3004)   (Extension)           │
│                                                                    │
│  • 输入界面  • 5轮对话 • Kafka消  • Docker   • 只读预览            │
│  • 多语言    • Zod校验  费      • Go test  • 批量对比            │
│  • WebSocket • Redis缓  • LLM生  • jest    • 批量决策            │
│             存           成        • Auto-Fix                    │
│                        • 流水线   • 评分    • 评分上报            │
│                        • 知识库   • 发送通  • 记忆沉淀            │
│                        • 检索     知                              │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
```

**四个服务职责速表**：

| 服务 | 端口 | 输入 | 输出 | 关键技术 |
|------|------|------|------|---------|
| **spec-normalizer** | 3001 | 用户白话（多轮对话） | 标准化的 Spec JSON | WebSocket、Zod、Redis、Kafka |
| **code-generator** | 3003 | Spec JSON + 知识库 | 多语言代码文件 | Kafka 消费、LLMRouter、知识库检索、流水线 DAG |
| **executor** | 3004 | 生成的代码 | 测试结果、评分、Auto-Fix | Docker 沙箱、语言特定测试、Auto-Fix 循环、Kafka、WebSocket |
| **admin** | 3006 | REST API 调用 | Skill/Agent/LLM/管道配置 | PostgreSQL CRUD、Audit Log、权限检查 |

### 3.2 辅助服务

| 服务 | 端口 | 职责 |
|------|------|------|
| **admin-web** | 3007 | 管理后台前端（纯 HTML，零依赖） |
| **planner-web** | 3000 | 用户策划输入前端（Next.js 14） |
| **kong** | 8000 | API 网关（统一入口、限流、CORS） |
| **retrieval** | 3008 | 检索服务（Phase 2，内置在 code-generator，也可独立） |

---

## 四、完整数据流

### 4.1 一个需求从输入到完成的全流程

```
1️⃣  用户输入
    ┌─────────────────────────────────────┐
    │ 用户在 planner-web 输入需求         │
    │ 例：「实现一个用户签到功能」        │
    └──────────────┬──────────────────────┘
                   │ HTTP POST (WebSocket)
                   ▼
    ┌──────────────────────────────────────┐
2️⃣  │ spec-normalizer (:3001)              │
    │ ✓ 多轮对话标准化（最多5轮）         │
    │ ✓ 每轮用 Claude 验证完整度          │
    │ ✓ Zod Schema 校验数据结构           │
    │ ✓ 完整度 ≥90% 才可提交              │
    └──────────────┬──────────────────────┘
                   │ 完整 Spec JSON
                   │ 写入 PostgreSQL.feature_specs
                   │ Kafka: spec.submitted
                   ▼
    ┌──────────────────────────────────────┐
3️⃣  │ code-generator (:3003)               │
    │ ✓ 消费 Kafka: spec.submitted         │
    │ ✓ 知识库检索                         │
    │   - BM25 关键词检索 (kb.json)        │
    │   - 向量相似度 (Chroma，可选)       │
    │   - Neo4j 图谱增强 (可选)           │
    │ ✓ 并发调用 LLM                       │
    │   - Go 代码 → Claude                 │
    │   - TypeScript → Claude              │
    │   - C# → Claude                      │
    │   - ... (5 种语言并行)               │
    │ ✓ 流水线执行 (TaskBus DAG)           │
    │   - 可配置多个 Agent 组合           │
    │   - 支持条件分支和重试              │
    │ ✓ 生成文件                           │
    │   - main.go, handler.go, ...        │
    │   - service.ts, controller.ts, ...  │
    │ ✓ 静态验证                           │
    │   - 语法检查、导入检查               │
    └──────────────┬──────────────────────┘
                   │ 代码文件 + 元数据
                   │ 写入 PostgreSQL.generation_tasks
                   │ Kafka: code.generated
                   ▼
    ┌──────────────────────────────────────┐
4️⃣  │ executor (:3004)                     │
    │ ✓ 消费 Kafka: code.generated         │
    │ ✓ 创建 Docker 沙箱                   │
    │   /tmp/awp-<taskId>/go/              │
    │   /tmp/awp-<taskId>/ts/              │
    │ ✓ 写入文件 + 自动依赖检测            │
    │   - 扫描 Go imports → 写 go.mod      │
    │   - 扫描 TS imports → 写 package.json│
    │ ✓ 执行语言特定的测试                 │
    │   - Go: go test -v -json -cover      │
    │   - TS: jest --json --coverage       │
    │   - 其他语言：placeholder            │
    │ ✓ 测试失败时 Auto-Fix（最多3次）    │
    │   - 解析错误日志                     │
    │   - 调用 LLM 生成修复代码           │
    │   - 再次运行测试（循环）            │
    │ ✓ 计算评分                           │
    │   - 代码质量分 (圈复杂度/覆盖率等)   │
    │   - 测试通过分                       │
    │   - 最终综合分 (0-100)               │
    │ ✓ 写入数据库 + 通知                  │
    │   - PostgreSQL.score_records         │
    │   - Redis Publish: task.completed    │
    │   - Kafka: code.tested / manual_review
    └──────────────┬──────────────────────┘
                   │ 测试结果 + 代码 + 评分
                   │ WebSocket 推送通知
                   ▼
    ┌──────────────────────────────────────┐
5️⃣  │ VS Code 插件                         │
    │ ✓ WebSocket 监听 executor 推送       │
    │ ✓ 任务列表展示                       │
    │ ✓ 代码只读预览                       │
    │ ✓ 用户决策                           │
    │   - Accept → 写入 audit_logs         │
    │   - Reject + 评论 → 写入 feedback    │
    │ ✓ 本地缓存 (workspaceState)          │
    │   - 离线模式支持                     │
    └──────────────┬──────────────────────┘
                   │ 决策 + 评分 + 反馈
                   │ HTTP → admin API
                   │ 
6️⃣  进化循环        │
    ┌──────────────▼──────────────────────┐
    │ 低分/拒绝 → 失败样本库              │
    │ ↓                                     │
    │ 动态约束进化引擎                    │
    │ ↓                                     │
    │ 修改 Prompt constraints.json         │
    │ ↓                                     │
    │ 下一个相似需求会用更好的 Prompt     │
    └──────────────────────────────────────┘
```

### 4.2 Kafka 消息流

```
Topic: spec.submitted
  生产者：spec-normalizer
  消费者：code-generator
  内容：{ spec_id, feature_spec, project_id, language_preference }
  
Topic: code.generated
  生产者：code-generator
  消费者：executor
  内容：{ generation_task_id, files[], dependencies, project_id }
  
Topic: code.tested
  生产者：executor
  消费者：（外部通知系统）
  内容：{ task_id, status, test_results, score, project_id }
  
Topic: code.manual_review
  生产者：executor（Auto-Fix 耗尽时）
  消费者：（通知服务，通知开发者人工介入）
  内容：{ task_id, reason, error_log }
```

---

## 五、代码逻辑关系图

### 5.1 服务间调用关系

```
┌─────────────────────────────────────────────────────────────┐
│                    用户界面层                                 │
├─────────────────────────────────────────────────────────────┤
│
│ planner-web (:3000)              admin-web (:3007)
│   └─ Next.js 14 App Router          └─ Pure HTML + Node.js
│      • Spec 输入表单
│      • WebSocket 实时对话                VS Code 插件
│      • Spec 预览                        └─ Extension Host
│                                           • 任务管理
└─────────────────────────────────────────────────────────────┘
         │                                    │
         │ HTTP (Kong :8000)                  │ HTTP
         ▼                                    ▼
┌────────────────────────────────────────────────────────────────┐
│                      API 网关层（Kong）                          │
│ • CORS / 限流 / 鉴权 / 日志 / 请求 ID 追踪                      │
└────────────────────────────────────────────────────────────────┘
         │
         ├──────────────────────────────────────────────────────┐
         │                                                       │
         ▼                                                       ▼
┌─────────────────────────────┐                    ┌────────────────────────┐
│   业务逻辑层（4核心服务）     │                    │   管理层 (admin:3006)   │
├─────────────────────────────┤                    ├────────────────────────┤
│                             │                    │                        │
│ spec-normalizer :3001       │                    │ ✓ Skill CRUD           │
│ ├─ src/routes/              │                    │ ✓ Agent CRUD           │
│ │  ├─ ws.ts (WebSocket)     │                    │ ✓ LLM Provider 配置     │
│ │  └─ api.ts                │                    │ ✓ Pipeline CRUD        │
│ ├─ src/services/            │ (REST API)          │ ✓ 用户/项目管理         │
│ │  ├─ normalizer.ts         ├──────────┐         │ ✓ 审计日志查询          │
│ │  │  (5轮对话逻辑)         │          │         │                        │
│ │  ├─ validation.ts         │          │         │ 调用 PostgreSQL         │
│ │  │  (Zod 校验)            │          │         │ 返回 JSON              │
│ │  └─ llm.ts                │          │         │                        │
│ │     (调用 LLMRouter)       │          │         └────────────────────────┘
│ └─ src/kafka/               │          │
│    ├─ producer.ts           │          │
│    │  (发送 spec.submitted) │          │
│    └─ listener.ts           │          │
│                             │          │
│ code-generator :3003        │          │
│ ├─ src/routes/              │          │
│ │  └─ api.ts (REST)         │          │
│ ├─ src/services/            │          │
│ │  ├─ retrieval.ts          │          │
│ │  │  (BM25 + 向量 + Neo4j)  │          │
│ │  ├─ code-engine.ts        │          │
│ │  │  (并发生成多语言)        │          │
│ │  ├─ llm-router.ts         │          │
│ │  │  (9种 LLM Provider)    │          │
│ │  └─ pipeline.ts           │          │
│ │     (DAG 执行)            │          │
│ └─ src/agents/              │          │
│    └─ codegen-agent.ts      │          │
│       (继承 BaseAgent)       │          │
│                             │          │
│ executor :3004              │          │
│ ├─ src/routes/              │          │
│ │  ├─ ws.ts (WebSocket)     │          │
│ │  └─ task-api.ts (REST)    │          │
│ ├─ src/services/            │          │
│ │  ├─ executor.ts           │          │
│ │  │  (Docker 沙箱管理)      │          │
│ │  ├─ tester.ts             │          │
│ │  │  (go test / jest)       │          │
│ │  ├─ auto-fix.ts           │          │
│ │  │  (3次重试循环)         │          │
│ │  ├─ scorer.ts             │          │
│ │  │  (评分逻辑)            │          │
│ │  └─ evolution.ts          │          │
│ │     (进化引擎)            │          │
│ └─ src/agents/              │          │
│    └─ executor-agent.ts     │          │
│       (继承 BaseAgent)       │          │
│                             │          │
└─────────────────────────────┘          │
         │                               │
         └───────────────────────────────┘
                   │
                   │ REST API 调用
                   │
                   ▼
         PostgreSQL :5432
         ├─ feature_specs (用户需求)
         ├─ generation_tasks (生成任务)
         ├─ score_records (评分记录)
         ├─ audit_logs (操作审计)
         ├─ failure_samples (失败样本)
         │
         ├─ llm_providers (LLM 配置 × 14)
         ├─ skill_definitions (Skill 定义)
         ├─ agent_definitions (Agent 定义)
         ├─ pipeline_definitions (流水线配置)
         │
         ├─ session_memories (会话记忆)
         ├─ project_memories (项目记忆)
         ├─ skill_memories (Skill 记忆)
         └─ consolidation_logs (记忆日志)
```

### 5.2 Agent 系统调用栈

```
BaseAgent (抽象基类)
├─ CodegenAgent (code-generator 内)
│  ├─ Task 1: Skill 1 (知识库检索)
│  │   └─ retrieveContext()
│  │      ├─ BM25 搜索 (kb.json)
│  │      ├─ 向量搜索 (Chroma)
│  │      └─ 图谱增强 (Neo4j)
│  ├─ Task 2: Skill 2 (并发代码生成)
│  │   └─ generateCode()
│  │      ├─ LLMRouter.call() → Anthropic
│  │      ├─ LLMRouter.call() → OpenAI
│  │      └─ LLMRouter.call() → Deepseek
│  └─ Task 3: Skill 3 (静态验证)
│      └─ validateCode()
│
├─ ExecutorAgent (executor 内)
│  ├─ Task 1: Skill 1 (Docker 初始化)
│  ├─ Task 2: Skill 2 (测试执行)
│  │   └─ runTest()
│  │      ├─ go test
│  │      ├─ jest
│  │      └─ Fallback: 静态分析
│  └─ Task 3: Skill 3 (Auto-Fix)
│      └─ autoFix()
│         ├─ 解析错误 (xml2js)
│         ├─ LLMRouter 修复
│         ├─ 再次测试 (x3 次循环)
│         └─ 若失败 → manual_review
│
└─ CustomAgent (数据库驱动，无需修改代码)
   └─ 通过 agent_definitions 表定义
      ├─ skill_names: ['skill-1', 'skill-2']
      ├─ agent_type: 'llm_prompt' / 'builtin_fn' / ...
      └─ 运行时动态加载执行
```

### 5.3 LLM Router 调用栈

```
LLMRouter (所有 LLM 调用的统一入口)
└─ resolveProvider(providerName) → 60s 缓存（从 DB 读）
   │
   ├─ 'anthropic'
   │  └─ new Anthropic({ apiKey: ANTHROPIC_API_KEY })
   │     └─ messages.create() / stream()
   │
   ├─ 'openai'
   │  └─ new OpenAI({ apiKey: OPENAI_API_KEY })
   │     └─ chat.completions.create()
   │
   ├─ 'deepseek'
   │  └─ new OpenAI({ baseURL: 'https://api.deepseek.com/v1', ... })
   │     └─ chat.completions.create()
   │
   ├─ 'qwen' (阿里云)
   │  └─ new OpenAI({ baseURL: 'https://dashscope.aliyuncs.com/v1', ... })
   │
   ├─ 'zhipu' (智谱)
   │  └─ new OpenAI({ baseURL: 'https://open.bigmodel.cn/api', ... })
   │
   ├─ 'gemini' (Google)
   │  └─ vertex AI / generativeLanguage API
   │
   ├─ 'azure'
   │  └─ new OpenAI({ apiVersion: '2024-02-15-preview', ... })
   │
   ├─ 'ollama' (本地模型)
   │  └─ fetch('http://localhost:11434/api/chat')
   │
   └─ 'custom'
      └─ new OpenAI({ baseURL: provider.base_url, ... })
```

---

## 六、第三方库详解

### 6.1 核心依赖总表

| 库 | 版本 | 体积 | 用处 | 替代 | 关键原因 |
|-----|------|------|------|------|---------|
| **@anthropic-ai/sdk** | ^0.20.0 | ~1.2MB | Claude API 调用 + 流式输出 | openai SDK | **官方 SDK，最新 API，支持 prompt caching** |
| **openai** | ^4.20.0 | ~500KB | GPT + 兼容 OpenAI 协议的模型 | @anthropic-ai | OpenAI 兼容的 9 种模型都能用 |
| **express** | ^4.18.2 | ~50KB | HTTP 框架（所有服务基础） | fastify/hapi | 成熟、社区大、中间件生态丰富 |
| **kafkajs** | ^2.2.4 | ~800KB | Kafka 客户端（异步消息） | node-rdkafka | 纯 JS，无需 C++ 编译，性能足够 |
| **pg** | ^8.11.3 | ~600KB | PostgreSQL 驱动 | mysql2/sqlite3 | 特定于 Postgres，功能完整 |
| **ioredis** | ^5.3.2 | ~400KB | Redis 客户端（缓存+发布订阅） | redis | 功能更全面（订阅、重试、连接池） |
| **ws** | ^8.18.0 | ~100KB | WebSocket 服务器（双向通信） | socket.io | **原生 WebSocket，无额外开销，自动重连** |
| **zod** | ^3.22.4 | ~200KB | 运行时数据校验 | joi/yup | TypeScript 友好，性能快 |
| **uuid** | ^9.0.0 | ~10KB | 生成唯一 ID | crypto.randomUUID() | 兼容性好（Node 14+），API 简单 |
| **pino** | ^8.16.0 | ~200KB | JSON 结构化日志 | winston/bunyan | 性能最快（<1μs/msg），子进程日志转发 |
| **prom-client** | ^15.1.0 | ~300KB | Prometheus 指标库 | StatsD/OpenCensus | **业界标准，与 Grafana 无缝集成** |
| **dotenv** | ^16.3.1 | ~30KB | 环境变量加载（.env → process.env） | 直接设置 | 本地开发方便，生产可关闭 |
| **cors** | ^2.8.5 | ~10KB | CORS 中间件 | 手写 headers | 简化跨域配置 |
| **helmet** | ^7.1.0 | ~50KB | HTTP 安全头 | 手写 | XSS/CSRF/点击劫持防护 |
| **express-validator** | ^7.0.1 | ~100KB | HTTP 请求校验 | joi/yup middleware | 与 Express 深度集成，链式 API |
| **xml2js** | ^0.6.2 | ~100KB | XML ↔ JSON 互转 | 其他 XML 库 | Go test 输出是 XML，需要解析 |

### 6.2 库在项目中的具体角色

#### 🔴 Tier 1（必不可少）

```
┌─ @anthropic-ai/sdk ────┐
│ 职责：LLM API 调用      │
│ 关键方法：              │
│ • messages.create()    │
│ • messages.stream()    │
│ 使用点：               │
│ • code-generator LLM   │
│ • executor Auto-Fix    │
│ • spec-normalizer 对话 │
└────────────────────────┘

┌─ pg ──────────────────┐
│ 职责：PostgreSQL 连接  │
│ 关键方法：              │
│ • Pool.query(sql, ...) │
│ • Client.connect()     │
│ 使用点：               │
│ • 所有服务读写业务表   │
│ • 多租户隔离 (WHERE)   │
│ • 事务 (ACID)          │
└────────────────────────┘

┌─ kafkajs ────────────┐
│ 职责：消息队列         │
│ 关键方法：              │
│ • producer.send()     │
│ • consumer.run()      │
│ 关键 Topics：          │
│ • spec.submitted      │
│ • code.generated      │
│ • code.tested         │
│ 使用点：               │
│ • spec-normalizer     │
│   → code-generator    │
│ • code-generator      │
│   → executor          │
└────────────────────────┘

┌─ express ────────────┐
│ 职责：HTTP 框架        │
│ 关键方法：              │
│ • app.post/get/put()  │
│ • app.use(middleware) │
│ 中间件组合：           │
│ • bodyParser          │
│ • cors                │
│ • helmet              │
│ • tenantMiddleware    │
│ 使用点：               │
│ • 4 个核心服务基础    │
│ • Kong 路由上游       │
└────────────────────────┘
```

#### 🟡 Tier 2（核心辅助）

```
┌─ ioredis ─────────────────┐
│ 职责：缓存 + 发布订阅     │
│ 关键数据：                  │
│ • llm_providers (60s 缓存)  │
│ • task:* (WebSocket 推送)   │
│ • sess:* (会话数据)        │
│ 使用场景：                  │
│ • code-generator 冗余缓存   │
│   → 避免每次查 DB          │
│ • executor 任务完成通知     │
│   → Redis Publish → WS      │
│ • spec-normalizer 用户会话 │
│   → 5 轮对话中间状态      │
└────────────────────────────┘

┌─ ws (WebSocket) ──────────┐
│ 职责：双向实时通信         │
│ 连接类型：                  │
│ • /ws/spec (spec-normalizer)│
│   ├─ 客户端 → 对话请求     │
│   └─ 服务器 ← 流式回复    │
│ • /ws/tasks (executor)     │
│   ├─ 客户端 → 决策反馈     │
│   └─ 服务器 ← 测试实时通知 │
│ 架构：                      │
│ • 连接 → 认证 (X-Project-ID)│
│ • 消息 → 队列处理          │
│ • 断开 → 清理资源          │
└────────────────────────────┘

┌─ zod ────────────────┐
│ 职责：运行时数据校验   │
│ 校验对象：              │
│ • FeatureSpec JSON  │
│ • Skill 配置 JSON   │
│ • Agent 定义 JSON   │
│ • Pipeline DAG JSON │
│ 校验时机：              │
│ • Spec 完整度检查   │
│ • 管理 API 输入验证 │
│ • Kafka 消息格式    │
│ 好处：                  │
│ • 类型安全 (TS)     │
│ • 清晰错误消息      │
│ • 防止 SQL 注入      │
└────────────────────────┘
```

#### 🟢 Tier 3（通用辅助）

```
┌─ pino (日志) ──────────┐
│ 职责：结构化日志        │
│ 输出格式：JSON          │
│ 日志级别：              │
│ • error (业务错误)      │
│ • warn (降级处理)       │
│ • info (关键事件)       │
│ • debug (调试信息)      │
│ 聚合方案：              │
│ • ELK Stack (可选)      │
│ • Datadog / Splunk     │
│ • CloudWatch           │
└────────────────────────┘

┌─ prom-client (指标) ──┐
│ 职责：Prometheus 指标 │
│ 指标类型：             │
│ • Counter (递增)      │
│ • Gauge (仪表盘)      │
│ • Histogram (分布)    │
│ • Summary (百分位数)  │
│ 关键指标：             │
│ • awp_generation_*   │
│ • awp_test_pass/fail │
│ • awp_autofix_total  │
│ • awp_llm_tokens     │
│ • awp_task_duration  │
│ 可视化：               │
│ • Grafana 仪表板      │
│ • Prometheus UI       │
└────────────────────────┘

┌─ cors / helmet ───────┐
│ 职责：HTTP 安全      │
│ CORS 解决：            │
│ • 跨域资源访问        │
│ • 预检请求处理        │
│ Helmet 防护：          │
│ • XSS 防护            │
│ • CSRF 令牌           │
│ • CSP 内容策略        │
│ • Clickjacking        │
│ 其他：                  │
│ • express-validator   │
│   → 请求数据校验      │
│ • uuid                │
│   → 全局唯一 ID       │
└────────────────────────┘
```

### 6.3 库的版本策略

```
当前策略：^x.y.z （Caret Range）
例：^0.20.0 表示 ≥0.20.0 但 <0.21.0

为什么选择 Caret？
✓ 自动吸收补丁版本更新 (bugfix)
✓ 避免大版本破坏性变更
✓ 年度一次大版本升级（人工测试）

升级计划：
2026 Q2: @anthropic-ai/sdk 0.20.x → 0.21.x（新 API）
2026 Q3: openai 4.20.x → 4.21.x（自动可选）
```

---

## 七、多租户隔离设计

### 7.1 隔离层次

```
用户请求
    │
    ▼
┌──────────────────────────────┐
│ Kong API 网关                  │
│ • 提取 X-Project-ID Header    │
│ • 格式校验 (alphanumeric-dash) │
│ • 转发给上游服务               │
└──────────────────────────────┘
    │
    │ 注入 req.tenant = { projectId, developerId, requestId }
    │
    ▼
┌──────────────────────────────┐
│ tenantMiddleware (gateway/)   │
│ 作用：所有服务都要用          │
│ app.use('/api', tenantMiddleware)|
│                               │
│ req.tenant.projectId → 后续请求都带上
└──────────────────────────────┘
    │
    ▼ 四层隔离
┌──────────────────────────────┐
│ 1️⃣ PostgreSQL                 │
│   WHERE project_id = $1       │
│   (所有查询必须有此过滤)      │
│   TenantDB 类强制实现          │
│                               │
│ 2️⃣ Redis                      │
│   Key 前缀：awp:${projectId}: │
│   例：awp:proj-1:task:123     │
│                               │
│ 3️⃣ Chroma 向量库              │
│   Collection 命名：            │
│   awp_${projectId}_kb         │
│   分离不同项目的向量          │
│                               │
│ 4️⃣ Elasticsearch (可选)       │
│   Index 命名：awp-kb-${projectId}
│                               │
│ 5️⃣ Neo4j (Label 前缀)         │
│   Neo4j Enterprise: 独立数据库 │
│   Neo4j CE: Label 前缀隔离     │
└──────────────────────────────┘
```

### 7.2 隔离验证

**问**：如何防止用户 A 看到用户 B 的数据？

**答**：
1. 请求进来，Kong 提取 `X-Project-ID`
2. tenantMiddleware 验证格式，挂载 `req.tenant`
3. 所有 DB 查询都走 `TenantDB` 类，自动加 `WHERE project_id = $1`
4. Redis/Chroma/ES 都用 projectId 前缀/索引名区分
5. 最后，VS Code 插件 / planner-web 的 SessionStorage 存本地 projectId，本地只刷新自己的任务

**风险**：若开发者手写 SQL 忘记 `WHERE project_id`，可能泄漏其他项目数据。

**防御**：
- 代码审查检查 `TenantDB` 使用
- 审计日志记录所有 SQL 执行
- SonarQube 规则告警 (hardcoded WHERE 缺失)

---

## 八、知识库（Hybrid RAG）工作原理

### 8.1 知识库三层检索

```
用户的 Spec JSON
    │ 提取关键词："签到"、"每日"、"redis"
    │
    ▼
┌────────────────────────────────────┐
│ BM25 关键词检索 (kb.json)          │
│ • 倒排索引，O(log n) 查询         │
│ • <10ms 返回结果                   │
│ • 结果：包含这些词的代码文件       │
│ • 例：daily_signin.go              │
│       redis_handler.go             │
└────────────────────────────────────┘
    │
    │ (可选：ENABLE_VECTOR_SEARCH=true)
    ▼
┌────────────────────────────────────┐
│ 向量相似度检索 (Chroma)            │
│ • spec JSON → embedding             │
│ • 种子代码 → embedding              │
│ • 计算余弦相似度                   │
│ • 返回最近 K 个结果 (k=5)          │
│ • 例：虽然词不同，但功能相似      │
│   • BM25 漏掉的会被抓住           │
└────────────────────────────────────┘
    │
    │ (可选：ENABLE_GRAPH_SCHEMA_CHECK=true)
    ▼
┌────────────────────────────────────┐
│ 图谱增强 (Neo4j)                   │
│ • 种子代码：function A 调用 B      │
│ • 查询：哪些类/函数会被频繁调用    │
│ • 返回：更完整的调用链上下文       │
│ • 例：daily_signin() 会用到        │
│   • redis.hget() ← Redis 模式库     │
│   • database.getUser() ← DB 层      │
└────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────┐
│ 结果去重 + 排序                    │
│ • 优先级 1：精确匹配 (BM25 top 1)  │
│ • 优先级 2：相似度高 (Chroma top 3)│
│ • 优先级 3：调用链完整 (Neo4j)      │
│ • 最终：≤10 个代码片段作为上下文   │
└────────────────────────────────────┘
    │
    ▼
  注入到 code-generator Prompt 中
  "以下是类似功能的参考代码：
   [接口定义 + 关键实现]"
```

### 8.2 知识库质量保护

```
种子代码添加流程：
node knowledge-base/scripts/add-seed.js \
  <路径> --feature=daily_signin

    │
    ▼
┌────────────────────────────────────┐
│ 自动质量检查 (build-index.js)      │
│ • 圈复杂度 > 10 ✗ 跳过             │
│ • 包含 TODO/FIXME ✗ 降权            │
│ • 测试文件 ✗ 跳过                  │
│ • 代码长度 > 500 行 ✗ 跳过         │
│ • 质量分 < 60 ✗ 拒收               │
└────────────────────────────────────┘
    │ ✓ 通过
    ▼
┌────────────────────────────────────┐
│ 写入 kb.json (BM25 索引)           │
│ • 格式：{id, type, path, code,     │
│         tokens, quality_score}     │
└────────────────────────────────────┘
    │
    ▼ (若启用向量检索)
┌────────────────────────────────────┐
│ Chroma 向量化                       │
│ • 分块：函数 → 向量片段            │
│ • Embedding：OPENAI_API_KEY 调用   │
│ • 写入 Collection：awp_*_kb        │
└────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────┐
│ Neo4j 图谱构建 (graph/build.js)    │
│ • 扫描函数定义和调用               │
│ • 创建节点：FunctionDef, ClassDef  │
│ • 创建边：CALLS, USES, DEFINED_IN  │
│ • 查询时：从 A 节点沿边找到 B      │
└────────────────────────────────────┘
```

---

## 九、流水线（Pipeline）系统

### 9.1 什么是流水线

**流水线 = Agent 的有向无环图 (DAG)**

```
Spec JSON
    │
    ▼ Codegen Agent
   [ Task 1: 知识库检索 ]
    │
    ▼ (并发执行)
   [ Task 2a: Go 代码生成 ]
   [ Task 2b: TS 代码生成 ]
    │
    └─→ (等待都完成)
    │
    ▼ Validation Agent
   [ Task 3: 代码静态检查 ]
    │
    ▼
   生成的代码文件

这就是一个流水线。
```

### 9.2 流水线配置（数据库驱动）

```sql
INSERT INTO pipeline_definitions
  (name, domain, agents_dag, is_builtin)
VALUES
  ('default-codegen', 'game-server',
   '{
     "nodes": [
       {"id": "1", "name": "codegen-agent"},
       {"id": "2", "name": "validator-agent"}
     ],
     "edges": [
       {"from": "1", "to": "2"}
     ]
   }',
   true);  -- 内置流水线，不可删除
```

### 9.3 在代码中如何使用

```typescript
// code-generator 启动时

// 1. 从 DB 加载流水线配置
const pipeline = await loadPipelineFromDb(
  domain: spec.domain,
  projectId: req.tenant.projectId
);

// 2. 创建 TaskBus
const taskBus = new TaskBus(pipeline);

// 3. 运行
const outputs = await taskBus.run(ctx);
//   ├─ 拓扑排序，确保无环
//   ├─ 找就绪的 Task（入度为 0）
//   ├─ 并发执行 Promise.all([tasks])
//   ├─ 等待完成，传给下游
//   └─ 返回 { agentName, status, data, ... }

// 4. 结果写入 Kafka
await kafkaProducer.send({
  topic: 'code.generated',
  messages: [{ value: JSON.stringify(outputs) }]
});
```

---

## 十、部署拓扑

### 10.1 开发环境（Docker Compose）

```
MacBook / Linux
    │
    ├─ docker-compose up  (启动 20 个容器)
    │
    ├─ PostgreSQL (:5432)
    │  └─ init.sql + dynamic-config-schema.sql 自动初始化
    │
    ├─ Redis (:6379)
    │  └─ 无初始化脚本（单纯 KV 存储）
    │
    ├─ Kafka (:9092)
    │  └─ zookeeper 自动注册
    │
    ├─ Kong (:8000) + Kong Admin (:8002)
    │  └─ kong.yml 声明式配置加载
    │
    ├─ 5 个应用容器
    │  ├─ spec-normalizer (:3001)
    │  ├─ code-generator (:3003)
    │  ├─ executor (:3004)
    │  ├─ admin (:3006)
    │  └─ admin-web (:3007)
    │
    ├─ 2 个前端容器
    │  ├─ planner-web (:3000)
    │  └─ admin-web 已在上面
    │
    └─ 监控 / 可选组件
       ├─ Prometheus (:9090)
       ├─ Grafana (:3005)
       ├─ Chroma (:8001，可选)
       ├─ Neo4j (:7687, :7474，可选)
       └─ SonarQube (:9000，可选)

启动顺序：
./scripts/start.sh infra        # PostgreSQL + Redis + Kafka
./scripts/start.sh app          # 4 个核心服务
./scripts/start.sh gateway      # Kong
./scripts/start.sh admin        # Admin 服务 + 前端
./scripts/start.sh monitoring   # Prometheus + Grafana
./scripts/start.sh all          # 一键启动全部
```

### 10.2 生产环境（Kubernetes）

```
# 假设部署到 K8s 集群

kubectl apply -f k8s/
├─ namespace: awp
│
├─ Deployment: spec-normalizer (3 replicas)
├─ Deployment: code-generator (2 replicas, CPU 密集)
├─ Deployment: executor (1 replica, 磁盘+内存密集)
├─ Deployment: admin (1 replica)
├─ Deployment: admin-web (2 replicas)
├─ Deployment: planner-web (2 replicas)
│
├─ StatefulSet: postgres (1 pod, persistent volume)
├─ StatefulSet: redis (1 pod)
├─ StatefulSet: kafka (3 pods, 高可用)
│
├─ Service: kong (LoadBalancer)
│  └─ 对外暴露单一入口
│
├─ ConfigMap: .env 配置
├─ Secret: API 密钥 (ANTHROPIC_API_KEY 等)
│
└─ Monitoring:
   ├─ prometheus-operator (Prometheus + Alertmanager)
   ├─ kube-state-metrics (K8s 资源监控)
   ├─ fluent-bit (日志收集)
   └─ Grafana (可视化)

扩展策略：
• spec-normalizer: I/O 密集，可扩容到 5+
• code-generator: CPU 密集，根据 LLM API 限额调整
• executor: 受限于单机 Docker，可用 Kubernetes Job 改造
• 数据库 + Redis：Redis Sentinel 高可用，Postgres 主从复制
```

---

## 十一、核心指标

### 11.1 性能基准（MacBook M2 + Claude Sonnet 4）

| 阶段 | 耗时 | 影响因素 |
|------|------|---------|
| **Spec 标准化** | 8-15s | 5 轮对话 × Claude 流式输出 |
| **知识库检索** | <10ms | 内存 BM25 索引 |
| **Go 代码生成** | 20-40s | 4 文件并发，取决于代码量 |
| **TS 代码生成** | 15-30s | 同上 |
| **go test** | 5-30s | 模块下载 + 测试执行 |
| **jest（首次）** | 40-90s | npm install (优先离线缓存) + 运行 |
| **jest（缓存）** | 5-15s | node_modules 命中缓存 |
| **Auto-Fix 单次** | 15-30s | 错误分析 + LLM 生成 + 测试 |
| **端到端（无 Fix）** | 60-120s | Spec → 代码 → 测试 |
| **端到端（3 次 Fix）** | 120-240s | 包含最多 3 次自动修复循环 |

### 11.2 可用性指标

```
99.9% 可用性目标 (年 8.76 小时宕机时间可接受)

单点故障转移：
┌─────────────────────────────────────┐
│ Kong 网关 × 2 (负载均衡)            │
│ + Keepalived VIP (虚拟 IP)          │
└─────────────────────────────────────┘
    │
    ├─ spec-normalizer × 3 (无状态，易扩)
    ├─ code-generator × 2 (无状态)
    ├─ executor × 1 (有状态，需 sticky session)
    ├─ admin × 1 (无状态)
    │
    ├─ PostgreSQL 主从 + 自动故障转移
    ├─ Redis Sentinel 3 节点 (自动选主)
    ├─ Kafka × 3 broker (高可用)
    │
    └─ 监控告警
       • Prometheus + AlertManager
       • 实时通知到 Slack / 钉钉
```

### 11.3 成本模型

```
月度费用估算 (AWS, 100 个并发用户)

基础设施：
├─ EC2 × 5 (t3.xlarge, 4vCPU 8GB): $400/月
├─ RDS PostgreSQL (db.t3.small): $40/月
├─ ElastiCache Redis (cache.t3.small): $30/月
├─ EBS 卷 (100GB): $10/月
└─ 小计：$480/月

API 成本：
├─ Claude Sonnet 4: 300 个任务 × $5 ≈ $1500/月
├─ OpenAI GPT-4: 100 个任务 × $3 ≈ $300/月
│  (假设 20% 的任务用 GPT-4 多模型)
└─ 小计：$1800/月

监控 / 日志：
├─ Datadog: $300/月
├─ CloudWatch: $50/月
└─ 小计：$350/月

总计：≈ $2630/月
      ≈ $32/年

成本优化杠杆：
✓ 用 Deepseek API ($0.0014/1K tokens) 替代 Claude
✓ Redis 改 ElastiCache 自管或本地部署
✓ Postgres 用 Aurora MySQL 按量计费
✓ 监控用开源 Prometheus 而非商业产品
```

---

## 十二、风险和改进

### 12.1 当前已知风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| **单 executor 容器** | Auto-Fix 时无并发 | Phase 6 用 K8s Job 架构 |
| **Go/TS 模块下载失败** | 无法测试 | 降级到静态分析，手动缓存 |
| **LLM API 配额耗尽** | 服务暂停 | 切换 Provider，队列限流 |
| **知识库污染** | 生成代码质量下降 | 质量分阈值 + 人工审核 |
| **Kafka 消息堆积** | 处理延迟 | 消费者扩容 + 死信队列 |
| **Neo4j 图谱过大** | 查询变慢 | TTL 清理 + 定期压缩 |

### 12.2 下一步优化方向

```
Phase 6 (2026 Q3-Q4):
├─ Executor 容器化 + Kubernetes Job
│  └─ Auto-Fix 循环可并发
├─ 本地 LLM 集成 (Ollama / LLaMA)
│  └─ 敏感项目离线运行
├─ 性能优化
│  ├─ Spec 缓存 (Redis)
│  ├─ 知识库预加载 (内存索引)
│  └─ 流式代码预览 (WebSocket)
└─ 可观测性增强
   ├─ Jaeger 分布式追踪
   ├─ 错误抽样上报
   └─ SLO 监控

Phase 7 (2026 Q4+, SaaS 化):
├─ 多组织 (Multi-Org)
├─ 行业定制化 (垂直领域)
├─ 插件市场 (第三方 Skill)
├─ 计费系统 (按 Token 计费)
└─ 企业特性 (SSO / RBAC / 数据驻留)
```

---

## 十三、快速查找表

### 代码在哪？

```
Spec 标准化的逻辑 → services/spec-normalizer/src/services/normalizer.ts
代码生成入口 → services/code-generator/src/consumers/spec-consumer.ts
多语言生成逻辑 → services/code-generator/src/services/code-engine.ts
知识库检索 → services/code-generator/src/services/retrieval.ts
Auto-Fix 逻辑 → services/executor/src/services/auto-fix.ts
评分计算 → services/executor/src/services/scorer.ts
进化引擎 → services/scorer/src/evolution-engine.ts
LLM 路由 → services/agents/dynamic/llm-router.ts
Agent 基类 → services/agents/base/agent.ts
TaskBus DAG 执行 → services/agents/bus/task-bus.ts
WebSocket 实时推送 → services/executor/src/routes/ws.ts
管理 API 端点 → services/admin/src/routes/
VS Code 插件 → frontend/vscode-plugin/src/
管理后台前端 → frontend/admin-web/public/index.html
```

### 常见问题排查

```
Q: Spec 提交失败 (完整度不足)
A: 查看 spec-normalizer 日志
   • pino 会打印 validation error
   • 检查 Zod schema: services/spec-normalizer/src/schema/

Q: 代码生成失败
A: 检查几个地方
   • Kafka 消息是否被消费（Kafka UI :8080）
   • code-generator 日志有无错误
   • LLM Router 是否连接失败（检查 API key）
   • 知识库是否为空（检查 kb.json）

Q: 测试一直失败
A: 排查步骤
   • Docker 沙箱是否创建成功 (/tmp/awp-* 目录)
   • 依赖是否正确检测 (go.mod / package.json)
   • Auto-Fix 是否触发了 (executor 日志)
   • 最后一次错误日志是什么

Q: WebSocket 连接断开
A: 检查
   • VS Code 插件的 X-Project-ID header
   • executor 的 /ws/tasks 端点是否监听
   • 网络延迟 / Kong 超时配置

Q: 数据库查询变慢
A: 诊断
   • SELECT * FROM audit_logs WHERE project_id = $1 LIMIT 1000;
   • 是否有 project_id 索引
   • 表行数是否过多 (可能需要分表)

Q: 内存泄漏 / 内存不断增长
A: 检查
   • Redis 缓存是否设置 TTL
   • WebSocket 连接是否正常关闭
   • Kafka consumer group 是否堆积
   • Node.js --inspect=0.0.0.0:9229 进行 Heap Snapshot
```

---

**文档更新日期**：2026-05-21  
**更新人**：Claude AI  
**涉及范围**：Phase 1-5 (88% 完成)
