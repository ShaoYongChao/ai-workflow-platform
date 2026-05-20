# Skill 与 Agent 配置规范

> 按照本规范填写，系统会自动将配置解析成 AI 可理解的执行指令。
> **无需修改任何代码**，只需在管理后台填表即可扩展能力。

---

## 一、Skill 配置规范

Skill 是最小执行单元，一个 Skill 只做一件事。

### 1.1 通用字段

| 字段 | 必填 | 说明 | 示例 |
|------|------|------|------|
| `name` | ✅ | 唯一标识，kebab-case | `go-handler-generator` |
| `display_name` | ✅ | 界面显示名称 | `Go Handler 生成器` |
| `description` | ✅ | 一句话说明，供 Agent 选择时理解 | `生成符合 Clean Architecture 的 Go HTTP Handler` |
| `category` | ✅ | `builtin`/`llm`/`tool`/`custom` | `llm` |
| `executor_type` | ✅ | 见下表 | `llm_prompt` |
| `preferred_llm` | 否 | 覆盖全局默认模型 | `deepseek-v3` |

### 1.2 执行方式（executor_type）

#### `llm_prompt` — 调用 LLM 生成内容（最常用）

```yaml
executor_type: llm_prompt
system_prompt: |
  你是资深 Go 工程师，专注于 Clean Architecture。
  生成的代码必须：
  1. 有 package 声明
  2. 错误显式处理（不得忽略 error）
  3. 禁止 Magic Number
  
  输出格式（严格遵守）：
  ### FILE: <路径>
  ```go
  <代码>
  ```

user_prompt_template: |
  ## 需求
  {{spec.title}}: {{spec.goal}}
  
  ## API 契约
  {{spec.api_contract}}
  
  ## 验收标准
  {{spec.acceptance}}
  
  请生成 handler.go 文件。

max_tokens: 4096
temperature: 0.2
preferred_llm: claude-sonnet-4   # 可选，覆盖全局默认
```

**可用模板变量：**

| 变量 | 内容 |
|------|------|
| `{{spec}}` | 完整 Spec JSON |
| `{{spec.title}}` | 功能名称 |
| `{{spec.goal}}` | 功能目标 |
| `{{spec.entities}}` | 实体列表 |
| `{{spec.api_contract}}` | API 契约 |
| `{{spec.rules}}` | 业务规则 |
| `{{spec.acceptance}}` | 验收标准 |
| `{{context.projectId}}` | 项目 ID |
| `{{input}}` | 上游传入的 input 对象 |
| `{{input.files}}` | 上游生成的文件列表 |

#### `builtin_fn` — 调用内置函数

```yaml
executor_type: builtin_fn
function_name: fileParser        # 可选值见下表
```

**可用内置函数：**

| function_name | 功能 |
|---|---|
| `llmCallSkill` | 通用 LLM 调用（系统/用户提示词） |
| `fileParserSkill` | 解析 ### FILE: 格式的代码块 |
| `staticAnalysisSkill` | 静态代码质量检查 |
| `knowledgeRetrievalSkill` | 知识库 BM25+向量检索 |
| `memoryInjectSkill` | 从记忆系统检索历史经验 |

#### `http_webhook` — 调用外部 HTTP 服务

```yaml
executor_type: http_webhook
webhook_url: https://your-service.com/api/process
webhook_headers:
  Authorization: Bearer ${YOUR_TOKEN}   # 支持读环境变量
webhook_timeout_ms: 10000
```

请求体格式（POST JSON）：
```json
{ "ctx": { "taskId": "...", "projectId": "..." }, "input": { "spec": {...} } }
```
响应格式（JSON）：任意结构，作为 Skill 输出传递给下游。

#### `js_script` — 沙箱 JS 脚本

```yaml
executor_type: js_script
script_code: |
  // 可用变量：ctx（AgentContext）、input（上游传入）
  // 结果赋值给 result
  const files = input.files || []
  const issues = []
  for (const file of files) {
    if (file.language === 'go' && !file.content.includes('package ')) {
      issues.push(`${file.path}: 缺少 package 声明`)
    }
  }
  result = { issues, quality: issues.length === 0 ? 100 : 60 }
```

安全限制：只允许 `require('path')` `require('crypto')` `require('util')`，超时 5s。

---

## 二、Agent 配置规范

Agent 是多个 Skill 的有序组合，代表一个专职角色。

### 2.1 字段说明

| 字段 | 必填 | 说明 | 示例 |
|------|------|------|------|
| `name` | ✅ | 唯一标识 | `java-spring-agent` |
| `display_name` | ✅ | 界面显示名 | `Java Spring Boot 代码生成` |
| `description` | ✅ | 角色说明（影响流水线自动选 Agent） | `生成 Spring Boot 三层架构代码` |
| `domain` | ✅ | 适用领域，`*` 表示通用 | `game` |
| `skill_names` | ✅ | Skill 列表（按执行顺序） | `["memory-inject","kb-retrieval","java-generator","static-analysis"]` |
| `system_prompt` | 否 | Agent 级别角色设定（注入到所有 LLM Skill 的前缀） | 见示例 |
| `preferred_llm` | 否 | 覆盖全局默认 | `deepseek-v3` |

### 2.2 完整 Agent 配置示例

```json
{
  "name": "java-spring-agent",
  "display_name": "Java Spring Boot 代码生成 Agent",
  "description": "生成符合 Spring Boot 三层架构（Controller/Service/Mapper）的 Java 代码",
  "domain": "*",
  "skill_names": [
    "memory-inject",
    "knowledge-retrieval",
    "java-controller-generator",
    "java-service-generator",
    "java-mapper-generator",
    "java-test-generator",
    "static-analysis"
  ],
  "system_prompt": "你是资深 Java Spring Boot 工程师。领域规范：\n- 使用 @RestController + @Service + @Mapper 注解\n- 统一用 Result<T> 包装响应\n- 所有接口加 @Validated 参数校验\n- 禁止在 Controller 写业务逻辑",
  "preferred_llm": "deepseek-v3",
  "max_retries": 3,
  "timeout_ms": 120000,
  "temperature": 0.2,
  "tags": ["java", "spring-boot", "backend"]
}
```

### 2.3 Skill 执行顺序说明

`skill_names` 中的 Skill **按顺序串行执行**，每个 Skill 可以访问前一个的输出（通过 `input.prev.<skill_name>`）：

```
memory-inject         # 第1步：注入记忆
  ↓ prev["memory-inject"].memories
knowledge-retrieval   # 第2步：知识库检索
  ↓ prev["knowledge-retrieval"].relatedInterfaces
java-generator        # 第3步：调 LLM 生成代码（可在 user_prompt_template 里用 {{input.prev}} 引用前两步结果）
  ↓ prev["java-generator"].files
static-analysis       # 第4步：质量检查（input.files 是上游生成的文件）
```

---

## 三、流水线（Pipeline）配置规范

流水线定义 Agent 之间的依赖关系。

```json
{
  "name": "java-full-stack",
  "display_name": "Java 全栈流水线",
  "domain": "*",
  "nodes": [
    { "agentName": "spec-analysis-agent", "dependsOn": [] },
    { "agentName": "java-spring-agent",   "dependsOn": ["spec-analysis-agent"] },
    { "agentName": "test-agent",          "dependsOn": ["java-spring-agent"] },
    { "agentName": "refactor-agent",      "dependsOn": ["test-agent"], "optional": true }
  ]
}
```

`optional: true` = 该节点失败不影响整体流水线。

---

## 四、LLM 模型添加规范

在后台「LLM 配置」页填写，系统自动路由：

| provider_type | 说明 | base_url（可选） |
|---|---|---|
| `anthropic` | Anthropic Claude | 留空用官方，或填代理地址 |
| `openai` | OpenAI GPT | 留空用官方 |
| `deepseek` | DeepSeek | 自动用 `api.deepseek.com` |
| `gemini` | Google Gemini | 自动用 Google API |
| `qwen` | 阿里云通义千问 | 自动用 DashScope |
| `zhipu` | 智谱 GLM | 自动用智谱 API |
| `ollama` | 本地 Ollama | 填 `http://localhost:11434` |
| `azure` | Azure OpenAI | 必须填 Azure endpoint |
| `custom` | 任何 OpenAI 兼容接口 | 必须填 base_url |

**添加私有模型示例（兼容 OpenAI 格式的自部署服务）：**
```json
{
  "name": "my-private-llm",
  "display_name": "私有部署 LLaMA",
  "provider_type": "custom",
  "base_url": "http://192.168.1.100:8080/v1",
  "model_id": "llama3-70b-instruct",
  "api_key_value": "not-needed",
  "context_window": 8192,
  "max_output_tokens": 4096
}
```
