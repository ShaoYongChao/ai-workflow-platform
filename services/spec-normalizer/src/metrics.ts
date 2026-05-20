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

const mkCounter = (cfg: any) => { try { return prom ? new prom.Counter(cfg) : null } catch { return null } }
const mkGauge   = (cfg: any) => { try { return prom ? new prom.Gauge(cfg)   : null } catch { return null } }

// ── Spec 提交数 ──────────────────────────────────────────────
export const specsTotal = mkCounter({
  name: 'awp_specs_total',
  help: '已提交需求总数',
  labelNames: ['status'],  // submitted | rejected
})

// ── WebSocket 活跃连接数 ─────────────────────────────────────
export const wsConnections = mkGauge({
  name: 'awp_ws_connections_active',
  help: '当前活跃 WebSocket 连接数',
})

// ── 对话轮次分布 ─────────────────────────────────────────────
export const dialogueTurns = mkCounter({
  name: 'awp_dialogue_turns_total',
  help: '多轮对话轮次累计',
})

export const register: any = prom?.register ?? null
