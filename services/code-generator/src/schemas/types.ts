import { z, infer as zinfer } from 'zod'

// ── FeatureSpec（与 spec-normalizer 保持一致） ──────────────
export const FeatureSpecSchema = z.object({
  title: z.string(),
  goal: z.string(),
  platform: z.array(z.enum(['client', 'server'])),
  languages: z.array(z.enum(['go', 'typescript', 'csharp', 'java', 'python'])).optional(),
  rules: z.record(z.string()),
  entities: z.array(z.string()),
  api_contract: z.array(z.object({
    name: z.string(),
    type: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
  })),
  acceptance: z.array(z.string()),
  priority: z.enum(['high', 'medium', 'low']).default('medium')
})

export type FeatureSpec = zinfer<typeof FeatureSpecSchema>

// ── Kafka 消息载荷 ──────────────────────────────────────────
export interface SpecSubmittedPayload {
  specId: string
  spec: FeatureSpec
  projectId?: string
  timestamp: number
}

// ── 生成结果 ────────────────────────────────────────────────
export interface GeneratedFile {
  path: string           // 相对路径，如 server/signin/handler.go
  language: 'go' | 'typescript' | 'csharp' | 'java' | 'python'
  content: string
  role: 'handler' | 'service' | 'model' | 'test' | 'types' | 'client'
}

export interface GenerationResult {
  taskId: string
  specId: string
  spec: FeatureSpec
  files: GeneratedFile[]
  status: 'success' | 'failed'
  error?: string
  durationMs: number
  model: string
  promptTokens: number
  completionTokens: number
  usedChunks: KBChunkMetadata[] // 本次生成使用的 KB chunks
}

// ── 知识库 Chunk 元数据 ──────────────────────────────────────
export interface KBChunkMetadata {
  id: string
  type: string
  language: 'go' | 'typescript' | 'csharp' | 'java' | 'python'
  file: string
  symbols: string[]
}

// ── 检索上下文（由 retrieval 服务提供，Phase1 先 mock） ──────
export interface RetrievalContext {
  relatedInterfaces: string[]   // 相关接口签名
  relatedModels: string[]       // 相关数据模型
  callGraph: string[]           // 调用链信息
  conventions: string[]         // 代码规范片段
  usedChunks: KBChunkMetadata[] // 本次生成实际使用的 KB chunks
  projectMemories: string[]     // 项目长期记忆（历史最佳实践）
}