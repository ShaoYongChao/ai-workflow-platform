// ── 上游：来自 code-generator 的 Kafka 消息 ─────────────────
export interface GeneratedFile {
  path: string
  language: 'go' | 'typescript' | 'csharp' | 'java' | 'python'
  content: string
  role: 'handler' | 'service' | 'model' | 'test' | 'types' | 'client'
}

export interface CodeGeneratedPayload {
  taskId: string
  specId: string
  spec: FeatureSpec
  files: GeneratedFile[]
  projectId?: string
  durationMs: number
  model: string
  timestamp: number
}

export interface FeatureSpec {
  title: string
  goal: string
  platform: ('client' | 'server')[]
  languages?: ('go' | 'typescript' | 'csharp' | 'java' | 'python')[]
  rules: Record<string, string>
  entities: string[]
  api_contract: Array<{ name: string; type: string }>
  acceptance: string[]
  priority: string
}

// ── 测试执行结果 ─────────────────────────────────────────────
export type TestStatus = 'pass' | 'fail' | 'error' | 'timeout'

export interface TestCase {
  name: string
  status: TestStatus
  durationMs: number
  errorMessage?: string
  stackTrace?: string
}

export interface TestRunResult {
  language: 'go' | 'typescript' | 'csharp' | 'java' | 'python'
  status: TestStatus
  totalTests: number
  passedTests: number
  failedTests: number
  coverage?: number          // 0-100
  testCases: TestCase[]
  rawOutput: string          // 原始 stdout/stderr
  durationMs: number
}

// ── Auto-Fix 记录 ────────────────────────────────────────────
export type FixStrategy = 'direct_fix' | 'rethink_then_fix' | 'simplify_then_fix'

export interface FixAttempt {
  attempt: number            // 1 | 2 | 3
  strategy: FixStrategy
  errorSummary: string       // 送给 LLM 的错误摘要
  fixedFiles: GeneratedFile[]
  testResult: TestRunResult
  success: boolean
  durationMs: number
}

// ── 执行任务完整状态 ─────────────────────────────────────────
export type ExecutionStatus =
  | 'running'
  | 'test_pass'
  | 'auto_fix_1' | 'auto_fix_2' | 'auto_fix_3'
  | 'manual_review'
  | 'error'

export interface ExecutionResult {
  taskId: string
  specId: string
  status: ExecutionStatus
  finalFiles: GeneratedFile[]      // 最终通过测试的文件（或最后一次尝试）
  testResults: TestRunResult[]     // 每次跑测试的结果
  fixAttempts: FixAttempt[]
  totalDurationMs: number
  autoFixSucceeded: boolean
}