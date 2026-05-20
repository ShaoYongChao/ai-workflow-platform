'use strict'
/**
 * normalize.js — 把 pg-client 返回的原始字符串行规范化为正确类型
 * pg 返回所有值都是字符串，JSONB/TEXT[]/boolean/integer 需要手动转换
 */

// PostgreSQL TEXT[] 格式 {a,b,"c d"} → JS 数组
function pgArray(str) {
  if (!str) return []
  if (Array.isArray(str)) return str
  if (typeof str !== 'string') return []
  if (str === '{}') return []
  const inner = str.replace(/^{|}$/g, '')
  if (!inner) return []
  // 支持带引号的元素
  const result = []
  let cur = '', inQuote = false
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c === '"' && inner[i-1] !== '\\') { inQuote = !inQuote; continue }
    if (c === ',' && !inQuote) { result.push(cur); cur = ''; continue }
    cur += c
  }
  if (cur !== '') result.push(cur)
  return result
}

// 安全 JSON.parse，失败返回原值
function tryParse(v) {
  if (v === null || v === undefined) return v
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { return v }
}

// 布尔字符串转布尔值
function pgBool(v) {
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === 't') return true
  if (v === 'false' || v === 'f') return false
  return v
}

// 数值字符串转数值
function pgInt(v) {
  if (v === null || v === undefined) return v
  const n = parseInt(v)
  return isNaN(n) ? v : n
}
function pgFloat(v) {
  if (v === null || v === undefined) return v
  const n = parseFloat(v)
  return isNaN(n) ? v : n
}

// 各表的字段规范化定义
const NORMALIZERS = {
  llm_providers: row => ({
    ...row,
    enabled:            pgBool(row.enabled),
    is_default:         pgBool(row.is_default),
    supports_streaming: pgBool(row.supports_streaming),
    supports_function_call: pgBool(row.supports_function_call),
    context_window:     pgInt(row.context_window),
    max_output_tokens:  pgInt(row.max_output_tokens),
    input_price_per_1k: pgFloat(row.input_price_per_1k),
    output_price_per_1k:pgFloat(row.output_price_per_1k),
    extra_params:       tryParse(row.extra_params) || {},
  }),

  skill_definitions: row => ({
    ...row,
    enabled:        pgBool(row.enabled),
    is_builtin:     pgBool(row.is_builtin),
    max_tokens:     pgInt(row.max_tokens),
    temperature:    pgFloat(row.temperature),
    webhook_timeout_ms: pgInt(row.webhook_timeout_ms),
    input_schema:   tryParse(row.input_schema) || {},
    output_schema:  tryParse(row.output_schema) || {},
    webhook_headers:tryParse(row.webhook_headers) || {},
  }),

  agent_definitions: row => ({
    ...row,
    enabled:     pgBool(row.enabled),
    is_builtin:  pgBool(row.is_builtin),
    max_retries: pgInt(row.max_retries),
    timeout_ms:  pgInt(row.timeout_ms),
    temperature: pgFloat(row.temperature),
    skill_names: Array.isArray(row.skill_names)
      ? row.skill_names
      : pgArray(row.skill_names),
    tags: Array.isArray(row.tags)
      ? row.tags
      : pgArray(row.tags),
    skill_display_names: Array.isArray(row.skill_display_names)
      ? row.skill_display_names
      : pgArray(row.skill_display_names),
  }),

  kb_entries: row => ({
    ...row,
    enabled:       pgBool(row.enabled),
    quality_score: pgInt(row.quality_score),
    tags:          Array.isArray(row.tags) ? row.tags : pgArray(row.tags),
    symbols:       Array.isArray(row.symbols) ? row.symbols : pgArray(row.symbols),
  }),

  system_settings: row => ({
    ...row,
    // value 是 JSONB，直接 parse 得到真实值（字符串/数字/布尔）
    value: tryParse(row.value),
  }),
}

function normalize(table, rows) {
  const fn = NORMALIZERS[table]
  if (!fn) return rows
  return Array.isArray(rows) ? rows.map(fn) : fn(rows)
}

module.exports = { normalize, pgArray, tryParse, pgBool, pgInt, pgFloat }
