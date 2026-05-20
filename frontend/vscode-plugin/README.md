# AWP — AI Workflow Platform VS Code 插件

AI 自动化工作流平台的开发者端入口：查看任务、预览代码、接受/拒绝、评分反馈。

## 功能

| 功能 | 说明 |
|------|------|
| 任务列表 | 实时展示所有代码生成任务，按状态着色，支持离线缓存 |
| 代码预览 | 点击文件以只读方式预览 AI 生成的代码 |
| 批量对比 | WebView 总览所有生成文件，一键打开逐个预览 |
| 按语言分组 | Go / TypeScript / C# 分组查看，支持按语言批量接受 |
| 全部接受 / 拒绝 | 一键应用所有文件到工作区，或拒绝并填写反馈 |
| 局部接受 | 多选文件，只接受部分生成结果 |
| 评分反馈 | 1-5 星评分 + 文字反馈，回传到进化引擎 |
| 知识库浏览 | 按语言/文件/chunk 树形展示 AI 参考的代码知识库 |
| 执行控制台 | WebSocket 实时日志（代码生成、测试、Auto-Fix 各阶段） |
| 手动触发生成 | 从 Spec 列表选择功能需求，一键触发代码生成 |
| WebSocket 实时同步 | 任务状态变化、执行进度推送，自动重连 + 心跳保活 |

## 安装

```bash
cd frontend/vscode-plugin
npm install
npm run compile

# 开发模式：在 VS Code 中按 F5，打开 Extension Development Host 窗口
# 打包安装：
npx vsce package
# 然后安装生成的 awp-vscode-0.1.0.vsix
```

## 使用流程

1. **启动后端**：`docker-compose up -d` 或 `./scripts/start.sh all`，确保 executor 服务在 `http://localhost:3004` 运行
2. **打开 VS Code**：左侧活动栏出现 AWP 图标，底部面板出现执行控制台
3. **三个视图**：
   - **代码生成任务**（侧边栏）：所有任务列表，展开可看生成文件
   - **知识库浏览**（侧边栏）：当前项目的代码知识库（按语言 > 文件 > chunk）
   - **执行控制台**（底部面板）：连接状态 + WebSocket 实时日志
4. **触发生成**：
   - 点击任务列表标题栏的 `▶` 按钮
   - 从 Spec 列表选择功能需求 → 确认触发
   - 控制台自动聚焦到该任务的实时日志
5. **Review 流程**：
   - 展开任务 → 点击语言分组（如 `Go 代码 (4 个文件)`）→ 逐文件预览 → 全部接受 / 局部接受 / 取消
   - 或展开任务 → 点击单个文件 → 只读预览生成内容
   - 右键任务 → `接受所有生成文件` / `局部接受` / `拒绝`
   - 右键任务 → `批量对比所有文件`（WebView 总览表格）
6. **评分**：接受时弹出 1-5 星评分 + 可选反馈文字，数据回传到进化引擎
7. **应用文件**：右键单个文件 → `应用文件到工作区`，可选择创建/覆盖或只读预览
8. **状态栏**：右下角显示连接状态（`✓ AWP` 或 `✗ AWP 离线`）

## 配置

打开 VS Code 设置（`Cmd+,`），搜索 `awp`：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `awp.serverUrl` | `http://localhost:3004` | executor 服务地址 |
| `awp.developerId` | （空，使用系统用户名） | 开发者 ID，用于 Review 决策记录 |
| `awp.autoRefreshInterval` | `30` | 任务列表自动刷新间隔（秒，0 禁用） |
| `awp.kbPath` | （空，自动检测） | 知识库 kb.json 的绝对路径 |

## 命令列表

| 命令 | 快捷方式 | 说明 |
|------|---------|------|
| `AWP: 手动触发代码生成` | 任务列表 `▶` 按钮 | 选择 Spec 触发 AI 代码生成 |
| `AWP: 刷新任务列表` | 任务列表 `↻` 按钮 | 重新拉取任务列表 |
| `AWP: 接受所有生成文件` | 右键待 Review 任务 | 写入工作区 + 评分 + 上报 |
| `AWP: 局部接受（选择文件）` | 右键待 Review 任务 | 多选文件接受 |
| `AWP: 拒绝所有生成文件` | 右键待 Review 任务 | 填写拒绝原因（必填） |
| `AWP: 批量对比所有文件` | 右键待 Review 任务 | 打开 WebView 总览 |
| `AWP: 对比并应用语言文件` | 点击语言分组节点 | 按语言逐文件预览 |
| `AWP: 应用文件到工作区` | 右键单个文件 | 创建/覆盖 或 只读预览 |
| `AWP: 显示任务使用的知识库` | 右键任务 | 查看 AI 参考了哪些知识库片段 |
| `AWP: 复制任务 ID` | 右键任务 | 复制完整 UUID 到剪贴板 |
| `AWP: 在浏览器中打开任务` | 右键任务 | 跳转到 executor Web 页面 |

## 架构

```
┌─────────────────────────────────────────────────┐
│                VS Code 插件                      │
├─────────────────────────────────────────────────┤
│                                                 │
│  TreeView          TreeView        WebView      │
│  (任务列表)        (知识库)        (执行控制台)   │
│     │                 │               │         │
│     └────┬────────────┘               │         │
│          │                            │         │
│  ┌───────▼────────┐    ┌─────────────▼──────┐  │
│  │  HTTP Client   │    │    WS Client       │  │
│  │ (Node http/s)  │    │ (ws 库，自动重连)   │  │
│  └───────┬────────┘    └─────────────┬──────┘  │
│          │                           │         │
│  ┌───────▼────────┐                  │         │
│  │  Preview View  │                  │         │
│  │ (只读文档预览)  │                  │         │
│  └────────────────┘                  │         │
└──────────┬───────────────────────────┬─────────┘
           │ HTTP/REST                  │ WebSocket
           │                            │
┌──────────▼────────────────────────────▼─────────┐
│           executor service (:3004)               │
│  GET  /api/v1/tasks               任务列表       │
│  GET  /api/v1/tasks/:id/files     生成文件       │
│  GET  /api/v1/tasks/:id/result    完整结果       │
│  POST /api/v1/tasks/:id/decision  接受/拒绝      │
│  GET  /api/v1/specs               Spec 列表      │
│  POST /api/v1/specs/:id/generate  触发生成       │
│  GET  /health                     健康检查       │
│  WS   /ws/tasks                   实时推送       │
└──────────────────────────────────────────────────┘
```

## 数据流

```
策划界面 → Spec → Kafka → code-generator → Kafka → executor
                                                      │
                                                      ▼
                                              WebSocket 推送
                                                      │
                                                      ▼
开发者 VS Code 插件 ◄───── 实时日志 + 任务状态更新
      │
      ├─ 预览生成代码 → 只读文档查看
      │
      ├─ 接受 → POST /decision (accept)
      │         ├─ 写入工作区文件
      │         ├─ 评分 → score_records
      │         └─ 学习 → evolution engine (learnFromHighScore)
      │
      └─ 拒绝 → POST /decision (reject)
                ├─ 反馈 → failure_samples
                ├─ 进化 → evolution engine (evolveFromFeedback)
                └─ 审计 → audit_logs
```

## 文件结构

```
src/
├── extension.ts               主入口：激活、注册视图和命令、WS 连接
├── api/
│   ├── types.ts               类型定义（与 executor API 对齐）
│   ├── client.ts              HTTP 客户端（Node http/https，无第三方依赖）
│   └── ws-client.ts           WebSocket 客户端（自动重连 + 心跳 + 任务订阅）
├── commands/
│   └── index.ts               所有命令注册（预览、接受、拒绝、评分、触发生成等）
└── views/
    ├── tasks-provider.ts      任务列表 TreeView（TaskNode / LangActionNode / FileNode）
    ├── knowledge-provider.ts  知识库 TreeView（按语言 > 文件 > chunk）
    └── console-provider.ts    执行控制台 WebView（连接状态 + 实时日志）
```

## 调试

- **插件日志**：VS Code `Help > Toggle Developer Tools` → Console
- **WebSocket 日志**：Output 面板 → 选择 `AWP WebSocket` 频道
- **后端日志**：`docker logs awp-executor -f`
- **离线模式**：executor 不可达时自动使用缓存的任务列表
