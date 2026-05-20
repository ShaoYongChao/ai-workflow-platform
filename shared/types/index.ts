/**
 * shared/types/index.ts
 *
 * 跨服务共享类型定义
 * 所有微服务通过此文件保持类型一致，避免重复定义
 */

// ── Feature Spec（核心数据契约） ─────────────────────────────
export interface FeatureSpec {
  title:        string
  goal:         string
  platform:     ('client' | 'server')[]
  languages:    ('go' | 'typescript' | 'csharp' | 'java' | 'python')[]  // 新增：用户选择的生成语言
  rules:        Record<string, string>
  entities:     string[]
  api_contract: Array<{ name: string; type: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' }>
  acceptance:   string[]
  priority:     'high' | 'medium' | 'low'
  domain?:      string
  domain_specific?: Record<string, any>
}

// ── 生成文件 ──────────────────────────────────────────────────
export interface GeneratedFile {
  path:     string
  language: 'go' | 'typescript' | 'csharp' | 'python' | 'java' | 'sql'
  content:  string
  role:     'handler' | 'service' | 'model' | 'test' | 'types' | 'client'
}

// ── Kafka 消息载荷 ────────────────────────────────────────────
export interface SpecSubmittedPayload {
  specId:    string
  spec:      FeatureSpec
  projectId: string
  timestamp: number
}

export interface CodeGeneratedPayload {
  taskId:    string
  specId:    string
  spec:      FeatureSpec
  files:     GeneratedFile[]
  model:     string
  timestamp: number
}

export interface CodeTestedPayload {
  taskId:         string
  specId:         string
  status:         'pass' | 'manual_review'
  files:          GeneratedFile[]
  testResults:    TestRunResult[]
  fixAttempts:    number
  autoFixSucceeded: boolean
  timestamp:      number
}

// ── 测试结果 ──────────────────────────────────────────────────
export interface TestRunResult {
  language:     'go' | 'typescript'
  status:       'pass' | 'fail' | 'error' | 'timeout'
  totalTests:   number
  passedTests:  number
  failedTests:  number
  coverage?:    number
  testCases:    TestCase[]
  rawOutput:    string
  durationMs:   number
}

export interface TestCase {
  name:          string
  status:        'pass' | 'fail' | 'error' | 'timeout'
  durationMs:    number
  errorMessage?: string
}

// ── 通用 API 响应 ─────────────────────────────────────────────
export interface ApiResponse<T = any> {
  code:    number
  data?:   T
  msg:     string
}

// ── Kafka Topics（常量） ──────────────────────────────────────
export const KAFKA_TOPICS = {
  SPEC_SUBMITTED:   'spec.submitted',
  CODE_GENERATED:   'code.generated',
  CODE_TESTED:      'code.tested',
  MANUAL_REVIEW:    'code.manual_review',
  CODE_GEN_FAILED:  'code.generation.failed',
} as const
