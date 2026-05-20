// ============================================================
// VS Code 插件 — 与 executor 后端 API 严格对齐的类型定义
// 后端契约见: services/executor/src/routes/task-api.ts
// ============================================================

// ── 任务状态机（与 executor schemas/types.ts 保持一致） ──────
export type ExecutionStatus =
  | 'running'             // 正在执行测试
  | 'generated'           // 代码生成成功，等待执行
  | 'test_pass'           // 测试通过，待人工 Review
  | 'auto_fix_1'
  | 'auto_fix_2'
  | 'auto_fix_3'
  | 'manual_review'       // Auto-Fix 失败，需人工
  | 'human_accepted'      // 开发者接受
  | 'human_rejected'      // 开发者拒绝
  | 'human_partial_accepted'
  | 'error'
  | 'failed'

// ── Spec（来自 spec-normalizer，executor 透传） ─────────────
export interface FeatureSpec {
  title: string
  goal: string
  platform: ('client' | 'server')[]
  rules: Record<string, string>
  entities: string[]
  api_contract: Array<{ name: string; type: string }>
  acceptance: string[]
  priority: 'high' | 'medium' | 'low'
}

// ── 生成的代码文件 ──────────────────────────────────────────
export interface GeneratedFile {
  path: string                   // server/daily_signin/handler.go
  language: 'go' | 'typescript' | 'csharp'
  content: string
  role: 'handler' | 'service' | 'model' | 'test' | 'types' | 'client' | 'script' | 'component'
}

// ── /api/v1/tasks 列表返回项 ────────────────────────────────
export interface TaskSummary {
  task_id: string
  spec_id: string
  status: ExecutionStatus
  priority: 'P0' | 'P1' | 'P2'
  retry_count: number
  created_at: string             // ISO 8601
  completed_at?: string
  spec_title: string
  spec?: FeatureSpec
  total_score?: number           // 0-100
}

// ── /api/v1/tasks/:id/result 完整结果 ────────────────────────
export interface TestCase {
  name: string
  status: 'pass' | 'fail' | 'error' | 'timeout'
  durationMs: number
  errorMessage?: string
}

export interface TestRunResult {
  language: 'go' | 'typescript'
  status: 'pass' | 'fail' | 'error' | 'timeout'
  totalTests: number
  passedTests: number
  failedTests: number
  coverage?: number
  testCases: TestCase[]
  rawOutput: string
  durationMs: number
}

export interface KBChunkMetadata {
  id: string
  type: string
  language: 'go' | 'typescript'
  file: string
  symbols: string[]
}

export interface TaskResult extends TaskSummary {
  generated_files: GeneratedFile[]
  test_result: TestRunResult[]
  kb_chunks_used?: KBChunkMetadata[]
  correctness_score?: number
  test_coverage?: number
  quality_score?: number
  error_log?: string
}

// ── /api/v1/tasks/stats/summary 统计 ─────────────────────────
export interface TaskStats {
  running: number
  pending_review: number
  accepted: number
  rejected: number
  manual_review: number
  total: number
  avg_duration_sec: number | null
}

// ── /api/v1/specs 列表返回项（手动触发生成用） ───────────────
export interface SpecItem {
  id: string
  title: string
  goal?: string                          // 从 structured_spec JSONB 提取，可能为空
  platform?: string | string[]           // JSONB 提取结果可能是字符串或数组
  priority?: 'high' | 'medium' | 'low'  // 从 structured_spec JSONB 提取
  status: string
  project_id?: string
  created_at: string
}

// ── /api/v1/specs/:specId/generate 返回 ─────────────────────
export interface TriggerGenerationResult {
  taskId: string
  specTitle: string
  message: string
  codeGeneratorTaskId?: string
}

// ── WebSocket 消息（与 executor websocket-server.ts 对齐） ───
export type WSMessage =
  | { type: 'hello'; message: string }
  | { type: 'pong'; ts: number }
  | { type: 'task_update'; taskId: string; status: ExecutionStatus; fixAttempts?: number; durationMs?: number; score?: number; finalFilesCount?: number; timestamp: number }
  | { type: 'task_decision'; taskId: string; decision: 'accept' | 'reject' | 'partial_accept'; developerId: string }
  | { type: 'task_log'; taskId: string; stage: string; detail?: any; timestamp: number }
  | { type: 'error'; message: string }
