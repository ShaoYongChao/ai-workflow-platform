# API 接口文档

## 通用约定

**Base URL：** 各服务独立端口（开发环境），或统一通过 Kong 网关 `http://localhost:8000` 访问。

**请求头：**
```
Content-Type: application/json
X-Project-ID: <project_id>        # 多租户标识，必填
X-Developer-ID: <developer_id>    # 开发者 ID，可选
X-Admin-Key: <admin_key>          # 管理 API 鉴权（仅 admin 服务需要）
```

**响应格式：**
```json
{ "code": 0, "data": {}, "msg": "ok" }       // 成功
{ "success": false, "error": "错误描述" }      // 失败（管理 API）
```

**Kong 网关路由（端口 8000）：**

| 路径前缀 | 上游服务 | 说明 |
|---------|---------|------|
| `/api/spec-normalizer/*` | spec-normalizer:3001 | 需求标准化 |
| `/ws/spec` | spec-normalizer:3001 | WebSocket 对话 |
| `/api/code-generator/*` | code-generator:3003 | 代码生成 |
| `/api/executor/*` | executor:3004 | 执行服务 |
| `/ws/tasks` | executor:3004 | WebSocket 任务通知 |
| `/api/admin/*` | admin:3006 | 管理后台（需 X-Admin-Key） |
| `/admin/*` | admin-web:3007 | 管理后台界面 |
| `/` | planner-web:3000 | 策划输入界面 |
| `/api/retrieval/*` | retrieval:3008 | 检索服务 |

**通用端点（所有服务）：**

| Method | Path | 说明 |
|--------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/metrics` | Prometheus 指标（需安装 prom-client） |

---

## spec-normalizer（端口 3001）

### WebSocket `/ws`

连接后通过 JSON 消息交互：

**客户端 → 服务端**

```json
// 发送用户输入
{ "type": "user_input", "payload": "我想做一个每日签到系统" }

// 确认并提交 Spec
{ "type": "confirm_spec", "payload": { "title": "...", ... } }

// 重置会话
{ "type": "reset" }
```

**服务端 → 客户端**

```json
// 流式输出开始
{ "type": "stream_start" }

// 流式文本块
{ "type": "stream_chunk", "text": "好的！请问..." }

// 流式输出结束，附带 Spec 和完整度
{ "type": "stream_end", "spec": {...}, "completeness": 95, "canSubmit": true }

// Spec 已提交
{ "type": "spec_submitted", "specId": "uuid" }

// 错误
{ "type": "error", "message": "错误描述" }
```

### GET `/api/v1/specs/:id`

获取 Spec 详情。

---

## code-generator（端口 3003）

### GET `/api/v1/tasks/:id`

查询任务状态。

**响应：**
```json
{
  "taskId": "uuid",
  "status": "running|success|failed",
  "fileCount": 4,
  "completedAt": "2024-01-01T00:00:00Z"
}
```

### POST `/api/v1/tasks/trigger`

手动触发代码生成（调试用）。

**请求体：** FeatureSpec JSON

**响应：**
```json
{ "taskId": "manual-xxx", "message": "生成任务已启动" }
```

---

## executor（端口 3004）

### GET `/api/v1/tasks`

获取任务列表。

**查询参数：**
- `status`: 过滤状态（test_pass / manual_review / running）
- `limit`: 每页数量（默认 50）
- `offset`: 偏移量

### GET `/api/v1/tasks/:id/result`

获取任务完整结果（含生成文件、测试结果、评分）。

### GET `/api/v1/tasks/:id/files`

获取任务生成的文件列表。

**响应：**
```json
{
  "files": [
    { "path": "server/signin/handler.go", "language": "go", "role": "handler", "content": "..." }
  ]
}
```

### POST `/api/v1/tasks/:id/decision`

提交 Review 决策（VS Code 插件调用）。

**请求体：**
```json
{
  "decision": "accept|reject|partial_accept",
  "developerId": "dev_001",
  "humanScore": 4,
  "feedback": "代码质量不错，但缺少错误日志",
  "acceptedFiles": ["server/signin/handler.go", "server/signin/service.go"]
}
```

> `humanScore`：1-5 星，由 VS Code 插件评分 QuickPick 上报。  
> `acceptedFiles`：仅 `partial_accept` 时有效，包含已接受的文件路径列表。  
> 决策提交后后端自动更新任务状态、写入 `score_records` 并触发记忆沉淀（≥4星）。

### GET `/api/v1/tasks/stats/summary`

获取任务统计（管理后台控制台用）。

**响应：**
```json
{
  "running": 2,
  "pending_review": 5,
  "accepted": 42,
  "rejected": 3,
  "manual_review": 1,
  "total": 53,
  "avg_duration_sec": 87.3
}
```

### GET `/api/v1/specs`

获取 Spec 列表（VS Code 插件手动触发生成时使用）。

**查询参数：**
- `status`: 过滤状态
- `project_id`: 过滤项目
- `limit`: 每页数量（默认 50，最大 200）
- `offset`: 偏移量

### POST `/api/v1/specs/:specId/generate`

手动触发代码生成（转发给 code-generator 启动完整流程）。

**响应：**
```json
{ "taskId": "uuid", "specId": "uuid", "message": "已触发代码生成完整流程" }
```

### WebSocket `/ws/tasks`

实时推送任务状态变更（VS Code 插件使用）。

**客户端 → 服务端**
```json
{ "type": "subscribe", "taskId": "uuid" }
{ "type": "unsubscribe", "taskId": "uuid" }
{ "type": "ping" }
```

**服务端 → 客户端**
```json
{ "type": "hello", "message": "connected" }
{ "type": "pong", "ts": 1234567890 }
{
  "type": "task_update",
  "taskId": "uuid",
  "status": "test_pass",
  "fixAttempts": 1,
  "score": 82,
  "timestamp": 1234567890
}
{
  "type": "task_log",
  "taskId": "uuid",
  "stage": "test_running",
  "detail": { "round": 0 },
  "timestamp": 1234567890
}
```

---

## retrieval（端口 3008）

### POST `/api/v1/retrieve`

根据 Spec 检索相关知识库内容。

**请求体：**
```json
{
  "spec": { "title": "...", "entities": ["Player", "SignIn"], ... },
  "projectId": "my-project"
}
```

**响应：**
```json
{
  "relatedInterfaces": ["// [server/signin/model.go]\ntype SignInRepository interface {...}"],
  "relatedModels": ["type SignInRecord struct {...}"],
  "callGraph": ["Handler → Service → Repository（严格分层）"],
  "conventions": ["错误处理：fmt.Errorf(\"op: %w\", err)"],
  "meta": { "totalChunks": 40, "matched": 12, "graphEnriched": true }
}
```

---

## admin（端口 3006）

> 所有请求需要 `X-Admin-Key` Header（值来自 `.env` 的 `ADMIN_API_KEY`）

### LLM 配置

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/admin/llm-providers` | 获取所有模型 |
| POST | `/api/admin/llm-providers` | 添加模型 |
| PUT | `/api/admin/llm-providers/:name` | 修改模型 |
| DELETE | `/api/admin/llm-providers/:name` | 禁用模型 |
| POST | `/api/admin/llm/test` | 测试连通性 |

**添加模型请求体：**
```json
{
  "name": "my-deepseek",
  "display_name": "DeepSeek V3 自定义",
  "provider_type": "deepseek",
  "api_key_env": "DEEPSEEK_API_KEY",
  "model_id": "deepseek-chat",
  "context_window": 65536,
  "max_output_tokens": 8192
}
```

### Skill 管理

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/admin/skills` | 获取所有 Skill |
| POST | `/api/admin/skills` | 创建 Skill |
| PUT | `/api/admin/skills/:id` | 修改 Skill |
| DELETE | `/api/admin/skills/:id` | 禁用 Skill |

**创建 Skill 请求体（LLM Prompt 模式）：**
```json
{
  "name": "go-handler-gen",
  "display_name": "Go Handler 生成器",
  "description": "生成符合 Clean Architecture 的 HTTP Handler",
  "category": "llm",
  "executor_type": "llm_prompt",
  "system_prompt": "你是 Go 工程师。生成格式：### FILE: <路径>\n```go\n<代码>\n```",
  "user_prompt_template": "## 需求\n{{spec.title}}\n## 验收\n{{spec.acceptance}}",
  "preferred_llm": "deepseek-v3",
  "max_tokens": 4096,
  "temperature": 0.2
}
```

### Agent 管理

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/admin/agents` | 获取所有 Agent |
| POST | `/api/admin/agents` | 创建 Agent |
| PUT | `/api/admin/agents/:id` | 修改 Agent |
| PATCH | `/api/admin/agents/:id/toggle` | 启用/禁用 |

**创建 Agent 请求体：**
```json
{
  "name": "java-spring-agent",
  "display_name": "Java Spring Boot Agent",
  "description": "生成 Spring Boot 三层架构代码",
  "domain": "*",
  "skill_names": ["memory-inject", "knowledge-retrieval", "java-gen-skill", "static-analysis"],
  "system_prompt": "你是 Java Spring Boot 工程师。使用 Result<T> 包装响应。",
  "preferred_llm": "deepseek-v3",
  "max_retries": 3,
  "temperature": 0.2
}
```

### 知识库

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/admin/kb?search=signin&language=go&page=1` | 搜索条目 |
| GET | `/api/admin/kb/:id` | 获取条目详情 |
| POST | `/api/admin/kb` | 添加条目 |
| PUT | `/api/admin/kb/:id` | 修改条目 |
| DELETE | `/api/admin/kb/:id` | 删除条目 |

### 系统设置

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/admin/settings` | 获取所有设置 |
| PUT | `/api/admin/settings/:key` | 修改设置 |

**常用 key：**
- `default_llm`: 全局默认模型名
- `enable_autofix`: 是否启用 Auto-Fix（true/false）
- `max_autofix_retries`: Auto-Fix 最大次数
- `enable_sonarqube`: 是否启用 SonarQube
- `kb_min_quality_score`: 知识库最低质量分

### 流水线（Phase 5）

**动态管道选择系统** — 支持运行时切换代码生成和 auto-fix 策略（需 X-Admin-Key）

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/admin/pipelines` | 获取所有管道 |
| GET | `/api/admin/pipelines/:id` | 获取管道详情 |
| POST | `/api/admin/pipelines` | 创建管道 |
| PUT | `/api/admin/pipelines/:id` | 修改管道 |
| DELETE | `/api/admin/pipelines/:id` | 删除管道（内置管道受保护） |
| POST | `/api/admin/pipelines/:id/test` | 测试管道 DAG 有效性 |

**创建/修改管道请求体：**
```json
{
  "name": "game-server-fast-fix",
  "display_name": "游戏服务器快速修复流水线",
  "domain": "game-server",
  "project_id": null,                    // null 表示全局，指定则仅限该项目
  "description": "优化游戏服务器生成和修复速度",
  "agents_dag": {
    "nodes": [
      {
        "id": "gen",
        "type": "agent",
        "name": "code-generator-agent",
        "config": { "maxTokens": 4096, "temperature": 0.2 }
      },
      {
        "id": "lint",
        "type": "skill",
        "name": "lint-check-skill",
        "config": {}
      }
    ],
    "edges": [
      { "from": "gen", "to": "lint" }
    ]
  },
  "skill_overrides": {
    "existing_skill_name": {
      "preferred_llm": "deepseek-v3",
      "temperature": 0.1
    }
  },
  "is_builtin": false
}
```

**响应（获取管道列表）：**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "default-codegen-pipeline",
      "display_name": "默认代码生成流水线",
      "domain": "*",
      "project_id": null,
      "is_builtin": true,
      "enabled": true,
      "created_at": "2026-05-21T10:00:00Z",
      "updated_at": "2026-05-21T10:00:00Z"
    }
  ]
}
```

**测试管道请求体：**
```json
{
  "taskType": "codegen|autofix",
  "spec": {                            // 仅 codegen 需要
    "title": "...",
    "goal": "...",
    ...
  }
}
```

**流水线选择逻辑（runtime）：**

1. **代码生成流程（code-generator）**
   ```
   getEffectivePipeline(spec, projectId)
     ├── 查询：domain=spec.domain AND project_id=projectId
     ├── 无结果 → 查询：domain=spec.domain AND project_id IS NULL
     ├── 无结果 → 使用内置默认管道
     └── 返回第一个匹配且 enabled=true 的管道
   ```

2. **自动修复流程（executor）**
   ```
   getFixPipeline(projectId)
     ├── 查询：domain="auto-fix" AND project_id=projectId
     ├── 无结果 → 查询：domain="auto-fix" AND project_id IS NULL
     ├── 无结果 → 使用内置 auto-fix 管道
     └── 返回第一个 enabled=true 的管道
   ```

**安全和约束：**
- ✅ 内置管道（`is_builtin=true`）不可删除/修改（返回 403）
- ✅ 创建时自动检测循环依赖（DAG 拓扑排序），发现则拒绝
- ✅ 修改时同样检测循环依赖
- ✅ 删除管道时如果有任务在使用则拒绝（返回 409）
- ✅ 所有操作记录在 audit_logs（resource_type="pipeline"）

### 统计

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/admin/stats` | 任务/知识库/Agent 统计 |
