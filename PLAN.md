# 实现多领域完整入口 - 最小改动方案

## Context

当前 AWP 平台只有游戏开发领域有完整的输入→生成→测试→Review 流程。其他三个配置好的领域（智能客服、数据分析、公文处理）虽然有 DOMAIN_CONFIGS，但缺少：
1. **前端领域选择器** - 用户无法显式选择非游戏领域
2. **知识库内容** - 无 seed-code，导致生成质量低
3. **领域特定提示** - 虽然 buildDomainHints() 已支持，但需要完善
4. **E2E 验证** - 无测试验证这些领域的完整流程

**核心问题**：系统后端已支持多领域（Python/SQL 代码生成、pytest 测试运行器都已实现），但前端和知识库没有跟上。

**改动原则**：复用现有基础设施，最小化新增代码。

---

## 现状分析

### 已完成部分（复用）
- ✅ Python 代码生成完整实现（code-engine.ts）
- ✅ Python 测试运行器（pytest）完整实现（python-runner.ts）
- ✅ C#/Java/SQL 生成能力已有
- ✅ 多语言并发生成框架
- ✅ 自动修复管道支持所有语言
- ✅ VS Code 插件支持任意语言分组显示
- ✅ 数据库驱动的 Skill/Agent/Pipeline 配置

### 缺失部分（需要补充）
1. **前端**：缺少显式的领域选择器UI（current: 通过语言隐式确定）
2. **知识库**：仅有游戏领域 seed-code，其他域为空
3. **Prompts**：现有 buildDomainHints 需扩展补充
4. **测试**：无 E2E 验证非游戏领域完整流程

---

## 实现方案（分 4 步）

### Step 1: 前端添加领域选择器 （最小改动）

**文件：** `frontend/planner-web/src/app/page.tsx`

**改动内容：**

1. 在现有的"语言选择"上方添加"领域选择"（单选按钮组）
   - 选项：游戏服务端 / 游戏全栈 / 智能客服 / 数据分析 / 公文处理
   - 当用户选择领域时，自动更新可选语言列表

2. 领域→语言的映射关系（新增常量）：
   ```typescript
   const DOMAIN_LANGUAGE_MAP = {
     'game-server': ['go', 'typescript'],
     'game-full': ['go', 'typescript', 'csharp'],
     'customer-service': ['python', 'typescript'],
     'analytics': ['python', 'sql'],  // SQL 是伪语言，用于提示
     'document': ['python', 'typescript']
   }
   ```

3. 修改 submitSpec 时，显式传递 `domain` 字段到后端：
   ```typescript
   const spec = {
     title, goal, entities, api_contract, rules, acceptance, priority,
     languages: selectedLanguages,
     domain: selectedDomain,  // 新增，覆盖自动推导
     domain_specific: {...}   // 新增：领域特定字段
   }
   ```

4. **添加领域特定的 Spec 字段**（根据选择的 domain 动态显示）：

   **智能客服领域：**
   - intent_taxonomy: 意图分类体系（如 ["greeting", "product_query", "billing", "technical_support"]）
   - common_responses: 常见 Q&A 对（至少 5 个）
   - escalation_rules: 何时转人工的规则（如"置信度 < 0.6"）
   
   **数据分析领域：**
   - data_sources: 数据源列表（表名或 API）
   - key_metrics: 关键指标定义（如 "DAU = 去重日登陆用户"）
   - analysis_dimensions: 分析维度（如 ["日期", "国家", "用户等级"]）
   - chart_preference: 图表类型建议（如 "时间序列用折线图"）
   
   **公文处理领域：**
   - approval_chain: 审批节点及顺序（如 "起草 → 部门主管 → CEO → 发布"）
   - role_permissions: 角色权限映射（如 "CEO 可单人批准，其他需要 2 人"）
   - retention_period: 保留期限规定（如 "机密文件永久保存"）
   - document_template: 公文格式要求

**工作量调整：** ~200-250 行代码（含动态表单逻辑）

**工作量：** ~250-300 行代码
   - 领域选择器: ~50 行
   - 动态表单字段（3 个新领域 × 4-5 字段）: ~150 行
   - 状态管理和验证: ~50 行

---

### Step 2: 知识库补充种子代码

**位置：** `knowledge-base/seed-code/`

**新增文件结构：**

```
knowledge-base/seed-code/

├── server/
│   ├── daily_signin/          [已有 - 游戏]
│   ├── battle/                [已有 - 游戏]
│   ├── nlp/                   [新增 - 客服]
│   │   ├── intent_classifier.py
│   │   ├── test_intent_classifier.py
│   │   └── conversation_context.py
│   ├── analytics/             [新增 - 分析]
│   │   ├── data_pipeline.py
│   │   ├── metrics_calculator.py
│   │   └── test_metrics_calculator.py
│   └── document/              [新增 - 公文]
│       ├── workflow_engine.py
│       ├── approval_chain.py
│       └── test_workflow_engine.py
│
└── client/
    ├── daily_signin/          [已有 - 游戏]
    ├── chat_interface/        [新增 - 客服]
    │   ├── ChatWindow.tsx
    │   └── MessageHistory.tsx
    ├── analytics_dashboard/   [新增 - 分析]
    │   ├── Dashboard.tsx
    │   └── Chart.tsx
    └── document_viewer/       [新增 - 公文]
        ├── DocumentPreview.tsx
        └── ApprovalUI.tsx
```

**关键文件内容（最小示例）：**

**客服领域** - `nlp/intent_classifier.py`
```python
# 包含：
# - IntentClassifier 类
# - 80-90% 置信度判断
# - 5-10 个常见意图枚举
# - 单元测试演示
# 行数：50-100 行
```

**分析领域** - `analytics/metrics_calculator.py`
```python
# 包含：
# - DataPipeline 类
# - 聚合函数（sum, avg, distinct）
# - SQL 生成帮助函数
# - 单元测试演示
# 行数：50-100 行
```

**公文领域** - `document/workflow_engine.py`
```python
# 包含：
# - ApprovalWorkflow 类
# - 节点状态机（待审批→已批准→已发布）
# - 权限检查函数
# - 单元测试演示
# 行数：50-100 行
```

**工作量：** 编写 6-8 个小型示例文件，总计 300-500 行代码

**执行方式：**
```bash
# 添加后自动触发索引重建
node knowledge-base/scripts/add-seed.js knowledge-base/seed-code/server/nlp/ --feature=intent_classifier
node knowledge-base/scripts/add-seed.js knowledge-base/seed-code/server/analytics/ --feature=metrics
node knowledge-base/scripts/add-seed.js knowledge-base/seed-code/server/document/ --feature=workflow
# 然后手动重建索引
node knowledge-base/scripts/build-index.js
```

---

### Step 3: 增强领域提示和代码生成

**文件 1：** `services/agents/agents/spec-agent.ts`

**改动：** 
1. 扩展 `buildDomainHints()` 函数，为各个新领域补充上下文提示
2. 添加 `validateDomainSpecificFields()` 验证函数，确保必填的领域特定字段存在

```typescript
function buildDomainHints(domain: string): string {
  const hints = {
    'game-server': '...' [已有],
    'customer-service': `
      - 用户意图识别：准确识别用户的真实需求，处理 typo 和口语表达
      - 多轮对话：支持澄清问题和信息补充，记录对话上下文
      - 情感敏感性：检测负面情绪，升级到人工客服
      - 知识库集成：参考 FAQ 数据库，给出有根据的回复
      - 回复质量：简洁（<100字）、礼貌、有帮助
    `,
    'analytics': `
      - 数据准确性：SQL 查询必须正确处理 NULL、重复值、时间范围
      - 聚合逻辑：Group By 维度要明确，避免隐藏 NULL 行
      - 可视化：选择合适的图表类型（时间序列→线图，分布→直方图）
      - 性能：避免 JOIN 过多表，使用物化视图减少重复计算
      - 文档：标注指标定义、计算逻辑、数据新鲜度
    `,
    'document': `
      - 审批流：设计清晰的节点转移，避免循环
      - 权限控制：明确各角色（起草、审批、发布、存档）的权限
      - 版本管理：支持修订历史，允许回滚到旧版本
      - 加密：敏感公文应加密存储，防止泄漏
      - 符合性：检查格式规范、法律术语准确度、保留期符合要求
    `
  }
  return hints[domain] || hints['game-server']
}
```

**文件 2：** `services/code-generator/src/generators/code-engine.ts`

**改动：** 补充 Python 代码生成时的提示词针对性

在 `buildPythonGeneratorPrompt()` 中，根据 domain 调整提示：
- 若 domain='customer-service'，强调错误处理、日志记录
- 若 domain='analytics'，强调 SQL 安全、NaN 处理
- 若 domain='document'，强调数据验证、审计日志

**工作量：** ~200-300 行文本增强，无新算法

---

### Step 4: E2E 测试验证各领域

**文件：** 新增 `scripts/e2e-multipart-test.js`

**结构：** 为每个领域设计最小化的 spec，验证完整流程

```javascript
// scripts/e2e-multipart-test.js

const TEST_SPECS = {
  'game-server': {
    title: "每日签到系统",
    domain: "game-server",
    languages: ["go", "typescript"],
    // ... [已在 e2e-test.js 中验证过]
  },
  'customer-service': {
    title: "智能客服机器人 v1",
    domain: "customer-service",
    languages: ["python", "typescript"],
    goal: "识别用户意图并自动回复常见问题",
    entities: [
      { name: "Intent", values: ["greeting", "product_query", "complaint"] },
      { name: "Confidence", type: "number", range: [0, 1] }
    ],
    api_contract: {
      input: { user_message: "string" },
      output: { intent: "string", confidence: "number", reply: "string" }
    },
    rules: [
      "置信度 < 0.5 时转人工客服",
      "检测辱骂词汇并升级",
      "同一用户 5 分钟内最多回复 3 条"
    ],
    acceptance: [
      "通过单元测试（intent_classifier 准确率 >= 80%）",
      "集成测试验证 API 响应时间 < 100ms"
    ],
    // 领域特定字段
    intent_taxonomy: ["greeting", "product_query", "billing", "complaint", "other"],
    common_responses: [
      { intent: "greeting", q: "你好", a: "您好，欢迎咨询" },
      { intent: "product_query", q: "产品价格是多少", a: "我们的产品价格..." }
    ],
    escalation_rules: "置信度 < 0.6 或 intent=complaint 时转人工"
  },
  'analytics': {
    title: "用户行为分析仪表板",
    domain: "analytics",
    languages: ["python"],  // 用户不输入 SQL，AI 生成
    goal: "统计日活、留存、付费用户数据",
    entities: [
      { name: "TimeRange", type: "date_range", default: "last_7_days" },
      { name: "Segment", values: ["new_users", "active_users", "paying_users"] }
    ],
    rules: [
      "日活 = 去重后的日登陆用户数",
      "留存 = N 天后还登陆的用户百分比",
      "支持按国家维度下钻"
    ],
    acceptance: [
      "SQL 查询在 < 2s 内返回结果",
      "图表显示正确（趋势线不应有异常波动）"
    ],
    // 领域特定字段
    data_sources: ["users", "login_events", "payment_records"],
    key_metrics: [
      "DAU = COUNT(DISTINCT user_id) WHERE DATE = TODAY",
      "Retention = COUNT(DISTINCT u2) / COUNT(DISTINCT u1) WHERE u2 login after 7 days"
    ],
    analysis_dimensions: ["date", "country", "user_segment"],
    chart_preference: "时间序列用折线图，分布用直方图"
  },
  'document': {
    title: "公文自动审批系统",
    domain: "document",
    languages: ["python", "typescript"],
    goal: "根据规则自动批准低风险公文，复杂公文转人工",
    entities: [
      { name: "DocumentType", values: ["通知", "公告", "指令", "报告"] },
      { name: "RiskLevel", values: ["low", "medium", "high"] }
    ],
    rules: [
      "低风险公文（金额 < 10w）自动批准",
      "高风险公文需要至少 2 人审核",
      "发布前检查是否遗漏必需签名字段"
    ],
    acceptance: [
      "审批流能正确转移状态",
      "权限控制验证通过（未授权用户无法批准）"
    ],
    // 领域特定字段
    approval_chain: "起草 → 部门主管审核 → 财务审批(仅金额>5w) → CEO → 发布",
    role_permissions: {
      "department_head": "可单人批准部分内容",
      "finance": "金额相关必须审批",
      "ceo": "最高权限，可单人批准任何内容"
    },
    retention_period: "机密文件永久保存，普通文件 7 年",
    document_template: "包含标题、发文号、密级、签名栏等"
  }
}

// 测试流程：遍历每个 spec，验证 spec.submitted → code.generated → code.tested
```

**验证项：**
- ✓ Spec 标准化成功（completeness >= 90%）
- ✓ 代码生成成功（所有语言文件都产生）
- ✓ 测试运行成功（Python 用 pytest，TypeScript 用 jest）
- ✓ 测试通过率 >= 80%

**工作量：** ~400-500 行测试代码

---

## 实现顺序和时间估算

| Step | 任务                      | 文件数 | 代码行数 | 时间   |
| ---- | ------------------------- | ------ | -------- | ------ |
| 1    | 前端领域选择器 + 动态表单 | 1      | 250-300  | 1.5-2h |
| 2    | 知识库 seed-code          | 8      | 400      | 2-2.5h |
| 2b   | 重建知识库索引            | -      | -        | 0.2h   |
| 3    | 增强领域提示词 + 后端验证 | 2      | 350      | 1.5-2h |
| 4    | E2E 多领域测试            | 1      | 500      | 1.5-2h |

**总计：** 5 个文件修改/新增，~1450 行代码，**预计 7-9 小时**

---

## 关键设计决策

### 1. 何时确定 domain
**选项 A**（当前）：从 languages 推导（Python→客服，C#→游戏全栈）
**选项 B**（建议）：用户显式选择，languages 作为验证
**决策**：采用 B，但保留后向兼容（无显式 domain 时仍从 language 推导）

### 2. 知识库冷启动
**选项 A**：不补充 KB，让系统使用通用提示词生成
**选项 B**（建议）：补充最小 seed-code，提升生成质量
**决策**：采用 B，但只需最小示例（50-100 行/文件），降低维护成本

### 3. 后端改动最小化
- ✓ 无需修改 code-generator（已支持 Python）
- ✓ 无需修改 executor（pytest runner 已完整）
- ✓ 无需修改 VS Code 插件（已支持任意语言）
- ✓ 只需在前端和 Agents 层补充提示词

---

## 验收标准

### 1. 功能性
- [ ] 前端能显示领域选择器，选择任意领域不报错
- [ ] 选择"智能客服"→生成 Python intent_classifier + TS 调用方
- [ ] 选择"数据分析"→生成 Python 数据处理 + SQL 查询
- [ ] 选择"公文处理"→生成 Python 审批引擎 + TS UI
- [ ] 所有生成的代码都能通过各自语言的测试

### 2. 知识库
- [ ] `kb.json` 包含非游戏领域的至少 20 个 chunks
- [ ] 检索时能正确返回领域相关的代码片段
- [ ] 生成质量相比"无 KB"时有明显提升

### 3. 性能
- [ ] E2E 完整流程（spec → 代码生成 → 测试）不超过 2 分钟/领域
- [ ] 前端响应时间 < 500ms

### 4. 测试覆盖
- [ ] 4 个领域都有 E2E 测试通过记录
- [ ] 测试代码通过率 >= 80%

---

## 潜在风险和缓解措施

| 风险                                                       | 影响         | 缓解                                                   |
| ---------------------------------------------------------- | ------------ | ------------------------------------------------------ |
| Python/SQL 知识库不够优质，导致生成代码质量低              | 用户体验     | 初期使用手工精选的 seed-code，后续通过评分进化自动优化 |
| 不同领域的提示词相互干扰（e.g., 游戏优化建议混入客服代码） | 生成结果混乱 | 在 buildDomainHints 中用 domain 严格分支，单元测试验证 |
| E2E 测试文件难以维护（需要跟踪 4 个领域的变化）            | 后续维护     | 提取公共 test runner 函数，每个域只写最小 spec         |

---

## 后续优化（不在本轮范围内）

1. **多语言 SQL 支持**（analytics 当前只支持 Python）
   - 增加 Java/Scala SQL 生成（需要新 agent）
   
2. **知识库自动扩展**
   - 集成用户评高分的代码自动入库
   
3. **领域专家模式**
   - 为每个领域设计专用 Agent 组合和流水线配置（Phase 5）

4. **A/B 测试框架**
   - 对比不同提示词对各领域的影响

---

## 文件修改清单

### 新增文件
1. `frontend/planner-web/src/app/page.tsx` - 添加领域选择器（在现有基础上修改）
2. `knowledge-base/seed-code/server/nlp/intent_classifier.py` - 客服示例
3. `knowledge-base/seed-code/server/nlp/test_intent_classifier.py`
4. `knowledge-base/seed-code/server/analytics/data_pipeline.py` - 分析示例
5. `knowledge-base/seed-code/server/analytics/test_metrics_calculator.py`
6. `knowledge-base/seed-code/server/document/workflow_engine.py` - 公文示例
7. `knowledge-base/seed-code/server/document/test_workflow_engine.py`
8. `knowledge-base/seed-code/client/` - 各领域前端示例（共 6 个）
9. `scripts/e2e-multipart-test.js` - 多领域 E2E 测试

### 修改文件
1. `services/agents/agents/spec-agent.ts` - 增强 buildDomainHints()
2. `services/code-generator/src/generators/code-engine.ts` - Python 提示词优化
3. `frontend/planner-web/src/app/page.tsx` - 领域选择器 UI

### 不修改（充分利用现有）
- code-generator 主逻辑
- executor / test runners
- VS Code plugin
- Admin API
- 数据库表结构

---

## 执行步骤总结

1. **设计阶段**（30 min）
   - 确认领域特定字段需求（与产品确认）
   
2. **前端实现**（1-1.5h）
   - 添加领域选择器 UI
   - 修改 submitSpec 传递 domain 字段
   
3. **知识库补充**（2-2.5h）
   - 编写 8 个 seed-code 文件
   - 运行 build-index.js 重建索引
   
4. **后端增强**（1-1.5h）
   - 扩展 buildDomainHints
   - 优化 Python 代码生成提示词
   
5. **E2E 验证**（1.5-2h）
   - 编写多领域测试 spec
   - 运行完整 E2E 测试流程
   
6. **文档更新**（30 min）
   - 更新 EXTENSIBILITY.md
   - 补充各领域的使用说明

**总计：6-8 小时内完成完整实现**