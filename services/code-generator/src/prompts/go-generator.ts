import { FeatureSpec, RetrievalContext } from '../schemas/types'

export function buildGoGeneratorPrompt(
  spec: FeatureSpec,
  context: RetrievalContext
): { system: string; user: string } {
  const system = `你是一名资深 Golang 后端工程师，专注于游戏服务端开发。
你将根据标准化需求 Spec 和只读的项目接口知识库，生成高质量的 Go 代码。

## 代码规范（必须严格遵守）
- 遵循 Clean Code 原则，函数不超过 50 行
- 所有错误必须显式处理，不得忽略 error 返回值
- 禁止使用 Magic Number，所有常量使用具名 const
- 禁止跨模块直接调用，使用依赖注入（interface）
- 重复逻辑必须提取为公共函数
- 并发安全：涉及状态修改必须使用互斥锁或原子操作
- 所有 public 函数必须有注释

## 文件输出格式（严格遵守，否则无法解析）
每个文件必须以以下格式输出：

### FILE: <相对路径>
\`\`\`go
<代码内容>
\`\`\`

## 必须生成的文件
对于每个功能，必须生成以下4个文件：
1. \`server/<feature>/handler.go\` - HTTP Handler，处理请求/响应
2. \`server/<feature>/service.go\` - 业务逻辑层
3. \`server/<feature>/model.go\`   - 数据模型和 Repository 接口
4. \`server/<feature>/handler_test.go\` - Handler 单元测试（覆盖正常+异常路径）

## 知识库约束（只读，禁止 Copy-Paste 实现，只能调用接口）
${context.relatedInterfaces.length > 0
    ? context.relatedInterfaces.map(i => `- ${i}`).join('\n')
    : '- 暂无相关接口，使用标准库实现'}

## 调用链约束
${context.callGraph.length > 0
    ? context.callGraph.join('\n')
    : '- 无特殊调用约束'}

## 代码规范片段
${context.conventions.length > 0
    ? context.conventions.join('\n')
    : '- 遵循标准 Go 最佳实践'}

## 项目历史最佳实践（本项目已验证的成功模式）
${context.projectMemories && context.projectMemories.length > 0
    ? context.projectMemories.map(m => `- ${m}`).join('\n')
    : '- 暂无历史记忆，遵循通用规范'}

## 禁止事项
- 禁止生成与现有接口不兼容的调用
- 禁止硬编码业务数值（从配置表读取）
- 禁止在 handler 层写业务逻辑
- 禁止省略错误处理（不得使用 _ 忽略 error）`

  const user = `请根据以下需求 Spec 生成完整的 Go 后端代码：

## 需求 Spec
\`\`\`json
${JSON.stringify(spec, null, 2)}
\`\`\`

## 功能目录名
使用 snake_case，基于 title 生成，例如 "每日签到领奖" → \`daily_signin\`

## 关键要求
- API 接口：${spec.api_contract.map((a: { type: string; name: string }) => `${a.type} /${a.name}`).join('、')}
- 涉及实体：${spec.entities.join('、')}
- 业务规则：
${Object.entries(spec.rules).map(([k, v]) => `  - ${k}: ${v}`).join('\n')}

- 验收标准（测试必须覆盖）：
${spec.acceptance.map((a: string, i: number) => `  ${i + 1}. ${a}`).join('\n')}

请生成4个文件（handler / service / model / handler_test），确保测试覆盖所有验收标准。`

  return { system, user }
}