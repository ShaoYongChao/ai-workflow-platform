import { FeatureSpec, RetrievalContext } from '../schemas/types'

export function buildTSGeneratorPrompt(
  spec: FeatureSpec,
  context: RetrievalContext
): { system: string; user: string } {
  const system = `你是一名资深 TypeScript 前端工程师，专注于游戏客户端开发（Cocos Creator / Unity WebGL）。
你将根据标准化需求 Spec 和后端 API 合约，生成高质量的 TypeScript 客户端代码。

## 代码规范（必须严格遵守）
- 所有变量/函数使用明确的 TypeScript 类型，禁止 any
- API 调用必须处理网络错误和超时
- 使用 async/await，禁止 callback 嵌套
- UI 状态更新必须在主线程（Cocos 环境下使用 scheduleOnce）
- 所有 public 方法必须有 JSDoc 注释

## 文件输出格式（严格遵守）
### FILE: <相对路径>
\`\`\`typescript
<代码内容>
\`\`\`

## 必须生成的文件
1. \`client/<feature>/api.ts\`        - API 请求层（封装 HTTP 调用）
2. \`client/<feature>/types.ts\`      - 请求/响应类型定义
3. \`client/<feature>/<Feature>Manager.ts\` - 业务逻辑管理器（状态管理）
4. \`client/<feature>/<Feature>Manager.test.ts\` - 单元测试

## 接口规范（与后端严格对齐）
${context.relatedInterfaces.length > 0
    ? context.relatedInterfaces.map(i => `- ${i}`).join('\n')
    : '- 根据 Spec 中的 api_contract 生成'}

## 项目历史最佳实践
${context.projectMemories && context.projectMemories.length > 0
    ? context.projectMemories.map(m => `- ${m}`).join('\n')
    : '- 暂无历史记忆，遵循通用规范'}

## 禁止事项
- 禁止在 Manager 层直接操作 DOM 或 Cocos 节点（通过事件解耦）
- 禁止硬编码 API 地址（从配置读取）
- 禁止使用 any 类型`

  const featureName = spec.title
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')

  const user = `请根据以下需求 Spec 生成完整的 TypeScript 客户端代码：

## 需求 Spec
\`\`\`json
${JSON.stringify(spec, null, 2)}
\`\`\`

## Manager 类名
\`${featureName}Manager\`

## 关键要求
- 对接后端 API：${spec.api_contract.map((a: any) => `${a.type} /${a.name}`).join('、')}
- 涉及实体：${spec.entities.join('、')}
- 业务规则需在客户端体现：
${Object.entries(spec.rules).map(([k, v]) => `  - ${k}: ${v}`).join('\n')}

## 特别注意
- getStatus 需要在登录后自动调用，缓存服务端状态
- claim 需要防重复点击（请求中禁止再次触发）
- 状态变化通过 EventTarget 或自定义事件通知 UI 层

请生成4个文件（api / types / Manager / Manager.test），确保类型完整、错误处理到位。`

  return { system, user }
}