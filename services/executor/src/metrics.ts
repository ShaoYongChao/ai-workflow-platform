/**
 * Prometheus 指标注册（prom-client）
 * 若 prom-client 未安装，所有指标静默为 null，不影响主流程。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
let prom: any = null
try {
  prom = require('prom-client')
  prom.collectDefaultMetrics({ prefix: 'awp_node_' })
} catch { /* prom-client 未安装 */ }

const mkCounter   = (cfg: any) => { try { return prom ? new prom.Counter(cfg)   : null } catch { return null } }
const mkHistogram = (cfg: any) => { try { return prom ? new prom.Histogram(cfg) : null } catch { return null } }

// ── 测试结果 ─────────────────────────────────────────────────
export const testPassTotal = mkCounter({
  name: 'awp_test_pass_total',
  help: '自动测试通过次数',
  labelNames: ['language'],
})

export const testFailTotal = mkCounter({
  name: 'awp_test_fail_total',
  help: '自动测试失败次数',
  labelNames: ['language'],
})

// ── Auto-Fix ─────────────────────────────────────────────────
export const autoFixTotal = mkCounter({
  name: 'awp_autofix_total',
  help: 'Auto-Fix 触发次数',
  labelNames: ['result'],   // success | exhausted
})

// ── 人工降级 ─────────────────────────────────────────────────
export const manualReviewTotal = mkCounter({
  name: 'awp_manual_review_total',
  help: '降级人工审查次数',
  labelNames: ['reason'],   // not_fixable | exhausted
})

// ── 任务端到端耗时 ───────────────────────────────────────────
export const taskDuration = mkHistogram({
  name: 'awp_task_duration_seconds',
  help: '任务端到端耗时（秒）',
  buckets: [10, 30, 60, 120, 300],
})

export const register: any = prom?.register ?? null
