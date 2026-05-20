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

// ── 生成结果 ─────────────────────────────────────────────────
export const generationTotal = mkCounter({
  name: 'awp_generation_total',
  help: '代码生成次数',
  labelNames: ['status'],   // started | success | failed
})

// ── 生成耗时 ─────────────────────────────────────────────────
export const generationDuration = mkHistogram({
  name: 'awp_generation_duration_seconds',
  help: '代码生成端到端耗时（秒）',
  buckets: [5, 10, 20, 40, 80, 160],
})

// ── LLM Token 消耗 ───────────────────────────────────────────
export const llmTokensTotal = mkCounter({
  name: 'awp_llm_tokens_total',
  help: 'LLM Token 消耗总量',
  labelNames: ['provider', 'type'],  // type: prompt | completion
})

export const register: any = prom?.register ?? null
