# AWP 本地知识库

AI 代码生成的「参考图书馆」。核心原则：**只读接口契约，不存实现逻辑**。

## 目录结构

```
knowledge-base/
├── seed-code/               ← 种子代码（人工维护的高质量参考实现）
│   ├── server/              ← Go 服务端
│   │   ├── daily_signin/    ← 每日签到功能
│   │   └── battle/          ← 战斗数值配置（示例）
│   └── client/              ← TypeScript 客户端
│       └── daily_signin/
├── index/                   ← 自动生成，不要手动编辑
│   ├── kb.json              ← 全量 JSON 索引（BM25 检索用）
│   └── chunks/              ← 每个 chunk 的独立 JSON（向量化用）
└── scripts/
    ├── build-index.js       ← 解析种子代码 → 生成索引
    ├── vectorize.js         ← 索引 → 写入 Chroma 向量库
    └── add-seed.js          ← 便捷：添加新代码并重建索引
```

## 快速开始

### 1. 查看当前知识库状态
```bash
node -e "const kb=require('./index/kb.json'); console.log('chunks:', kb.totalChunks, '| 更新:', kb.builtAt)"
```

### 2. 添加新功能代码
```bash
# 添加单个文件
node knowledge-base/scripts/add-seed.js src/shop/model.go --feature=shop

# 添加整个功能目录
node knowledge-base/scripts/add-seed.js src/guild/ --feature=guild

# 添加并立刻向量化（需 Chroma 已启动）
node knowledge-base/scripts/add-seed.js src/pvp/ --feature=pvp --vectorize
```

### 3. 重建全量索引
```bash
node knowledge-base/scripts/build-index.js
```

### 4. 写入 Chroma 向量库
```bash
# 确保 Chroma 已启动
docker-compose up -d chroma

# 向量化（需设置 OPENAI_API_KEY，否则使用确定性哈希向量）
OPENAI_API_KEY=xxx node knowledge-base/scripts/vectorize.js

# Dry run 查看将写入什么
node knowledge-base/scripts/vectorize.js --dry-run
```

## 种子代码规范

### 什么应该放进来
- ✅ `model.go` / `types.ts` — 数据结构和接口定义
- ✅ `service.go` — 业务逻辑（含正确的错误处理、日志规范）
- ✅ `handler.go` — HTTP 处理层（含响应格式规范）
- ✅ `api.ts` / `Manager.ts` — 客户端 API 封装和状态管理

### 什么不应该放进来
- ❌ `*_test.go` / `*.test.ts` — 测试文件（自动跳过）
- ❌ 包含硬编码配置（IP、密钥等）的文件
- ❌ 圈复杂度 > 10 的"屎山代码"
- ❌ 过时/废弃的实现

### 质量基线
| 指标           | 要求                          |
| -------------- | ----------------------------- |
| 圈复杂度       | ≤ 10                          |
| 单元测试覆盖率 | ≥ 70%（配套测试文件存在即可） |
| Public 函数    | 必须有注释                    |
| 错误处理       | 不得忽略 error 返回值         |

## 检索机制

当前使用**双路召回**策略：

1. **BM25 关键词匹配**（`retrieval.ts`）
   - 精确匹配符号名（接口名、函数名、实体名）
   - 来自 Spec 的 `entities` + `api_contract.name` + `rules` 键名

2. **文本相似度匹配**（关键词覆盖率）
   - 基于 `title` + `goal` + `entities` + `rules` 内容的分词匹配

3. **向量语义检索**（需 Chroma，Phase 2 完整启用）
   - 通过 `vectorize.js` 写入 Chroma 后自动启用

## 知识库治理

| 责任                     | 负责人     | 周期     |
| ------------------------ | ---------- | -------- |
| 新功能上线后添加种子代码 | 功能开发者 | 每次上线 |
| 审查种子代码质量         | 技术负责人 | 每迭代   |
| 废弃接口清理             | 技术负责人 | 每季度   |

> **重要**：SKILLS.md 和知识库质量直接决定 AI 生成代码的质量。
> 低质量的种子代码会导致整个生成系统输出劣化。

# 1. 初始化（首次）
node knowledge-base/scripts/build-index.js

# 2. 启动 Chroma 后写入向量（可选，不影响 BM25 检索）
docker-compose up -d chroma
OPENAI_API_KEY=xxx node knowledge-base/scripts/vectorize.js

# 3. 以后添加新功能代码
node knowledge-base/scripts/add-seed.js src/your-feature/ --feature=your_feature