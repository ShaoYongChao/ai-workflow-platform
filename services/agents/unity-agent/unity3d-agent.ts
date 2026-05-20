/**
 * services/agents/unity-agent/unity3d-agent.ts
 *
 * Unity3D 前端 Agent
 *
 * 职责：
 *   根据功能 Spec 生成 Unity C# 客户端代码：
 *   - Manager：业务逻辑控制器（MonoBehaviour 解耦）
 *   - UI Presenter：UGUI 界面逻辑
 *   - 数据模型：与服务端 JSON 对齐的 C# 类
 *   - 网络层：封装后端 API 调用（UnityWebRequest）
 *   - Editor 测试：使用 Unity Test Framework
 *
 * 技术规范：
 *   - 遵循 MVC/MVP 分层（不在 MonoBehaviour 里写业务逻辑）
 *   - 使用 UniTask 替代 coroutine（更清晰的异步）
 *   - ScriptableObject 用于配置数据
 *   - 禁止 FindObjectOfType（使用依赖注入或 ServiceLocator）
 */

import { BaseAgent, AgentContext, AgentOutput, Skill, DomainConfig } from '../base/agent'
import { llmCallSkill, fileParserSkill, knowledgeRetrievalSkill, staticAnalysisSkill } from '../skills/builtin-skills'

// Unity 专用领域配置（可从外部传入，这里提供默认值）
export const UNITY_DOMAIN_CONFIG: DomainConfig = {
  name:         'game',
  language:     ['csharp'],
  framework:    'Unity 2022.3 LTS + UniTask',
  conventions: [
    '使用 namespace 避免命名冲突',
    'MonoBehaviour 只做生命周期管理，业务逻辑放 Manager/Service',
    '网络请求使用 async/await + UniTask',
    '配置数据使用 ScriptableObject',
    'UI 事件用 UnityEvent 或 Action，不硬引用组件',
    '资源加载通过 AddressableAssets，禁止 Resources.Load',
    '禁止 FindObjectOfType，使用依赖注入'
  ],
  outputFormat: 'code'
}

export class Unity3DAgent extends BaseAgent {
  readonly name        = 'unity3d-agent'
  readonly description = 'Unity3D 前端代码生成：C# Manager/Presenter/Model/Network/Test'
  readonly domain      = 'game'
  readonly skills: Skill[] = [llmCallSkill, fileParserSkill, knowledgeRetrievalSkill, staticAnalysisSkill]

  async execute(ctx: AgentContext): Promise<AgentOutput> {
    const spec = ctx.spec

    // 从上游 spec-agent 取精化后的 Spec
    const specOutput = ctx.prevOutputs['spec-analysis-agent']
    const finalSpec  = specOutput?.data?.structuredSpec || spec

    // 1. 知识库检索（优先 C# 相关接口）
    const retrieval = await knowledgeRetrievalSkill.execute(ctx, { spec: finalSpec })

    // 2. 服务端输出（如果有，用于对齐接口）
    const serverFiles = ctx.prevOutputs['codegen-agent']?.files?.filter(
      (f: any) => f.language === 'go'
    ) || []
    const apiContracts = extractAPIContracts(serverFiles, finalSpec)

    // 3. 生成 C# Unity 代码
    const { system, user } = buildUnityPrompt(finalSpec, retrieval, apiContracts)
    const result    = await llmCallSkill.execute(ctx, { system, user, maxTokens: 10240 })
    const parsed    = await fileParserSkill.execute(ctx, { raw: result.content })

    // 4. 静态分析 C# 文件
    const analysis  = await staticAnalysisSkill.execute(ctx, { files: parsed.files })
    if (analysis.issues.length > 0) {
      console.warn(`[Unity3DAgent] 静态分析发现 ${analysis.issues.length} 个问题:`, analysis.issues)
    }

    return {
      agentName: this.name,
      status:    parsed.files.length > 0 ? 'done' : 'failed',
      data: {
        fileCount:    parsed.files.length,
        quality:      analysis.quality,
        issues:       analysis.issues,
        hasTests:     analysis.hasTests,
        apiContracts: apiContracts.length
      },
      files:    parsed.files,
      error:    parsed.files.length === 0 ? '未解析到 C# 文件' : undefined,
      metadata: {
        durationMs:  0,
        tokensUsed:  result.tokens,
        retries:     0,
        skillsUsed:  ['llm-call', 'file-parser', 'knowledge-retrieval', 'static-analysis']
      }
    }
  }
}

// ── Unity C# Prompt 构建 ──────────────────────────────────────

function buildUnityPrompt(spec: any, retrieval: any, apiContracts: string[]) {
  const featureName   = toPascalCase(spec.title)
  const featureFolder = toSnakeCase(spec.title)

  const system = `你是资深 Unity3D C# 工程师，专注于游戏客户端架构。
根据功能 Spec 生成完整的 Unity C# 代码，遵循 MVP 架构。

## 必须生成的文件（5个）

### FILE: Scripts/${featureName}/${featureName}Data.cs
数据模型：与服务端 JSON 字段严格对齐的 C# 类（使用 [Serializable] + [JsonProperty]）

### FILE: Scripts/${featureName}/${featureName}NetworkService.cs
网络服务：封装后端 API 调用（UnityWebRequest + UniTask），返回强类型结果

### FILE: Scripts/${featureName}/${featureName}Manager.cs
业务逻辑管理器：继承 MonoBehaviour，管理状态和协调 Network/UI
使用事件系统（Action/UnityEvent）通知 UI，不直接引用 UI 组件

### FILE: Scripts/${featureName}/UI/${featureName}Presenter.cs
UI Presenter：继承 MonoBehaviour，持有 UI 引用，响应 Manager 事件
只做 UI 展示逻辑，不包含业务判断

### FILE: Scripts/${featureName}/Tests/${featureName}Tests.cs
Unity Test Framework 测试（EditMode）：测试 Manager 核心业务逻辑
Mock NetworkService 依赖

## 输出格式（严格遵守）
### FILE: <路径>
\`\`\`csharp
<完整代码>
\`\`\`

## 技术规范
- Unity 2022.3 LTS + UniTask 2.3.x
- 命名空间：GameProject.${featureName}
- 使用 Cysharp.Threading.Tasks（UniTask）替代 Coroutine
- 网络超时：10 秒
- 错误处理：区分网络错误/业务错误/服务器错误
- 禁止：FindObjectOfType / Resources.Load / string.Format（用 $""）
- 日志：使用 Debug.Log 并加 [${featureName}] 前缀
- 防重复点击：请求进行中禁止重复触发

## 已知服务端接口
${apiContracts.length > 0
    ? apiContracts.join('\n')
    : spec.api_contract?.map((a: any) => `${a.type} /api/${featureFolder}/${a.name}`).join('\n')}

## 知识库参考接口
${(retrieval.relatedInterfaces || []).slice(0, 3).join('\n') || '（无参考接口）'}`

  const user = `## 功能 Spec
${JSON.stringify(spec, null, 2)}

业务规则：
${Object.entries(spec.rules || {}).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

验收标准（测试必须覆盖）：
${(spec.acceptance || []).map((a: string, i: number) => `${i + 1}. ${a}`).join('\n')}

请生成完整的 Unity C# 代码，Manager 和 NetworkService 使用接口（IXxxService）设计，方便测试时 Mock。`

  return { system, user }
}

// ── 从服务端生成文件中提取 API 契约（对齐客户端） ────────────

function extractAPIContracts(serverFiles: any[], spec: any): string[] {
  const contracts: string[] = []

  for (const file of serverFiles) {
    if (file.role !== 'handler') continue
    const handlerLines = file.content.split('\n').filter((l: string) =>
      l.includes('HandleFunc') || l.includes('func (h *Handler)') || l.includes('mux.Handle')
    )
    contracts.push(...handlerLines.map((l: string) => `// 服务端: ${l.trim()}`))
  }

  // fallback 使用 spec 中的 api_contract
  if (contracts.length === 0) {
    const featureFolder = toSnakeCase(spec.title)
    return (spec.api_contract || []).map((a: any) =>
      `${a.type} /api/${featureFolder}/${a.name}`
    )
  }
  return contracts.slice(0, 10)
}

// ── 工具函数 ──────────────────────────────────────────────────

function toPascalCase(str: string): string {
  return str
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('')
}

function toSnakeCase(str: string): string {
  return str
    .replace(/[^\w\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .toLowerCase()
}
