/**
 * services/admin/src/routes/admin-api.js
 *
 * 管理后台 REST API
 * 所有后台管理操作的统一入口
 *
 * 端点总览：
 *   /api/admin/llm-providers    CRUD  模型配置
 *   /api/admin/skills           CRUD  Skill 定义
 *   /api/admin/agents           CRUD  Agent 定义
 *   /api/admin/pipelines        CRUD  流水线定义
 *   /api/admin/kb               CRUD  知识库条目
 *   /api/admin/settings         CRUD  系统设置
 *   /api/admin/stats            GET   数据统计
 *   /api/admin/llm/test         POST  测试 LLM 连通性
 */

'use strict'

const express = require('express')
const { Pool } = require('pg')
const router  = express.Router()
const pool    = new Pool({ connectionString: process.env.POSTGRES_URL })

// ── 通用工具 ──────────────────────────────────────────────────
const ok   = (res, data)         => res.json({ success: true, data })
const fail = (res, msg, code=400) => res.status(code).json({ success: false, error: msg })

// 增强版审计日志：支持 resource_type / resource_id / ip_address / 变更内容
const logAudit = (action, req, resourceType = 'admin', resourceId = null, changes = {}) => {
  const safe = Object.assign({}, changes)
  delete safe.api_key_value   // 脱敏：不记录明文密钥
  delete safe.api_key_env
  return pool.query(
    `INSERT INTO audit_logs
       (action, actor, resource_type, resource_id, project_id, metadata, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      action,
      req.headers['x-developer-id'] || 'admin',
      resourceType,
      resourceId || null,
      req.query.project_id || req.headers['x-project-id'] || null,
      JSON.stringify(Object.keys(safe).length ? { changes: safe } : {}),
      req.ip || null,
    ]
  ).catch(() => {})
}

// ── LLM 模型配置 ──────────────────────────────────────────────
router.get('/llm-providers', async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM llm_providers ORDER BY is_default DESC, provider_type, name`
  )
  ok(res, r.rows)
})

router.post('/llm-providers', async (req, res) => {
  const { name, display_name, provider_type, base_url, api_key_env, api_key_value,
          model_id, context_window, max_output_tokens, extra_params } = req.body
  if (!name || !provider_type || !model_id) return fail(res, '缺少必填字段: name, provider_type, model_id')
  const r = await pool.query(
    `INSERT INTO llm_providers (name, display_name, provider_type, base_url, api_key_env, api_key_value, model_id, context_window, max_output_tokens, extra_params)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [name, display_name || name, provider_type, base_url || null, api_key_env || null,
     api_key_value || null, model_id, context_window || 128000, max_output_tokens || 8192,
     JSON.stringify(extra_params || {})]
  )
  await logAudit('llm_provider.create', req, 'llm_provider', null, req.body)
  ok(res, r.rows[0])
})

router.put('/llm-providers/:name', async (req, res) => {
  const updates = req.body
  const sets    = []
  const vals    = []
  let   idx     = 1
  for (const [k, v] of Object.entries(updates)) {
    if (['id','name','created_at'].includes(k)) continue
    sets.push(`${k} = $${idx++}`)
    vals.push(typeof v === 'object' ? JSON.stringify(v) : v)
  }
  if (sets.length === 0) return fail(res, '无有效字段')
  vals.push(req.params.name)
  const r = await pool.query(
    `UPDATE llm_providers SET ${sets.join(',')} WHERE name = $${idx} RETURNING *`, vals
  )
  await logAudit('llm_provider.update', req, 'llm_provider', null, { name: req.params.name, ...req.body })
  ok(res, r.rows[0])
})

router.delete('/llm-providers/:name', async (req, res) => {
  await pool.query(`UPDATE llm_providers SET enabled = false WHERE name = $1`, [req.params.name])
  await logAudit('llm_provider.disable', req, 'llm_provider', null, { name: req.params.name })
  ok(res, { disabled: true })
})

// ── LLM 连通性测试 ────────────────────────────────────────────
router.post('/llm/test', async (req, res) => {
  const { providerName, testPrompt } = req.body
  try {
    const { getLLMRouter } = require('../../agents/dynamic/llm-router')
    const llm    = getLLMRouter(pool)
    const start  = Date.now()
    const result = await llm.call({
      providerName,
      system: '你是一个 AI 助手。',
      user:   testPrompt || '请回复"连接测试成功"',
      maxTokens: 50
    })
    ok(res, { ok: true, content: result.content, latencyMs: Date.now() - start, model: result.model })
  } catch (err) {
    ok(res, { ok: false, error: err.message })
  }
})

// ── Skill 定义 CRUD ───────────────────────────────────────────
router.get('/skills', async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM skill_definitions
     WHERE project_id IS NULL OR project_id = $1
     ORDER BY is_builtin DESC, category, name`,
    [req.query.project_id || null]
  )
  ok(res, r.rows)
})

router.post('/skills', async (req, res) => {
  const { name, display_name, description, category, executor_type,
          system_prompt, user_prompt_template, preferred_llm, max_tokens,
          temperature, function_name, webhook_url, webhook_headers,
          script_code, input_schema, output_schema, project_id } = req.body
  if (!name || !executor_type) return fail(res, '缺少必填字段: name, executor_type')

  const r = await pool.query(
    `INSERT INTO skill_definitions
       (name, display_name, description, category, executor_type,
        system_prompt, user_prompt_template, preferred_llm, max_tokens,
        temperature, function_name, webhook_url, webhook_headers,
        script_code, input_schema, output_schema, project_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [name, display_name || name, description || '', category || 'custom', executor_type,
     system_prompt || null, user_prompt_template || null, preferred_llm || null,
     max_tokens || 4096, temperature || 0.2, function_name || null,
     webhook_url || null, JSON.stringify(webhook_headers || {}),
     script_code || null, JSON.stringify(input_schema || {}),
     JSON.stringify(output_schema || {}), project_id || null,
     req.headers['x-developer-id'] || 'admin']
  )
  await logAudit('skill.create', req, 'skill', r.rows[0].id, req.body)
  ok(res, r.rows[0])
})

router.put('/skills/:id', async (req, res) => {
  const { id } = req.params
  const fields  = ['display_name','description','category','system_prompt',
                   'user_prompt_template','preferred_llm','max_tokens','temperature',
                   'webhook_url','script_code','input_schema','output_schema','enabled']
  const sets = [], vals = []
  let idx = 1
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      sets.push(`${f} = $${idx++}`)
      vals.push(['input_schema','output_schema'].includes(f) ? JSON.stringify(req.body[f]) : req.body[f])
    }
  }
  if (sets.length === 0) return fail(res, '无有效字段')
  vals.push(id)
  const r = await pool.query(
    `UPDATE skill_definitions SET ${sets.join(',')} WHERE id = $${idx} AND is_builtin = false RETURNING *`, vals
  )
  if (r.rowCount === 0) return fail(res, '不存在或内置 Skill 不可修改', 404)
  await logAudit('skill.update', req, 'skill', id, req.body)
  ok(res, r.rows[0])
})

router.delete('/skills/:id', async (req, res) => {
  const r = await pool.query(
    `UPDATE skill_definitions SET enabled = false WHERE id = $1 AND is_builtin = false RETURNING id`,
    [req.params.id]
  )
  if (r.rowCount === 0) return fail(res, '不存在或内置 Skill 不可删除', 404)
  await logAudit('skill.delete', req, 'skill', req.params.id, {})
  ok(res, { disabled: true })
})

// ── Agent 定义 CRUD ───────────────────────────────────────────
router.get('/agents', async (req, res) => {
  const r = await pool.query(
    `SELECT ad.*, array_agg(sd.display_name) FILTER (WHERE sd.display_name IS NOT NULL) AS skill_display_names
     FROM agent_definitions ad
     LEFT JOIN skill_definitions sd ON sd.name = ANY(ad.skill_names)
     WHERE ad.project_id IS NULL OR ad.project_id = $1
     GROUP BY ad.id ORDER BY ad.is_builtin DESC, ad.domain, ad.name`,
    [req.query.project_id || null]
  )
  ok(res, r.rows)
})

router.post('/agents', async (req, res) => {
  const { name, display_name, description, domain, skill_names, system_prompt,
          preferred_llm, max_retries, timeout_ms, temperature, tags, project_id } = req.body
  if (!name || !skill_names?.length) return fail(res, '缺少必填字段: name, skill_names')

  // 验证 Skill 都存在
  const skillCheck = await pool.query(
    `SELECT name FROM skill_definitions WHERE name = ANY($1) AND enabled = true`, [skill_names]
  )
  const foundSkills = skillCheck.rows.map((r: any) => r.name)
  const missing = skill_names.filter((s: string) => !foundSkills.includes(s))
  if (missing.length > 0) return fail(res, `以下 Skill 不存在或已禁用: ${missing.join(', ')}`)

  const r = await pool.query(
    `INSERT INTO agent_definitions
       (name, display_name, description, domain, skill_names, system_prompt,
        preferred_llm, max_retries, timeout_ms, temperature, tags, project_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [name, display_name || name, description || '', domain || '*', skill_names,
     system_prompt || null, preferred_llm || null, max_retries || 3,
     timeout_ms || 120000, temperature || 0.2, tags || [],
     project_id || null, req.headers['x-developer-id'] || 'admin']
  )
  await logAudit('agent.create', req, 'agent', r.rows[0].id, req.body)
  ok(res, r.rows[0])
})

router.put('/agents/:id', async (req, res) => {
  const fields = ['display_name','description','domain','skill_names','system_prompt',
                  'preferred_llm','max_retries','timeout_ms','temperature','tags','enabled']
  const sets = [], vals = []
  let idx = 1
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      sets.push(`${f} = $${idx++}`)
      vals.push(req.body[f])
    }
  }
  if (sets.length === 0) return fail(res, '无有效字段')
  vals.push(req.params.id)
  const r = await pool.query(
    `UPDATE agent_definitions SET ${sets.join(',')} WHERE id = $${idx} AND is_builtin = false RETURNING *`, vals
  )
  if (r.rowCount === 0) return fail(res, '不存在或内置 Agent 不可修改', 404)
  await logAudit('agent.update', req, 'agent', req.params.id, req.body)
  ok(res, r.rows[0])
})

router.patch('/agents/:id/toggle', async (req, res) => {
  const r = await pool.query(
    `UPDATE agent_definitions SET enabled = NOT enabled WHERE id = $1 RETURNING id, name, enabled`,
    [req.params.id]
  )
  if (r.rowCount === 0) return fail(res, '不存在', 404)
  await logAudit('agent.toggle', req, 'agent', req.params.id, {})
  ok(res, r.rows[0])
})

// ── 知识库 CRUD ───────────────────────────────────────────────
router.get('/kb', async (req, res) => {
  const { project_id, language, entry_type, search, page = 1, limit = 20 } = req.query
  const conditions = ['1=1']
  const vals: any[] = []
  let idx = 1
  if (project_id) { conditions.push(`project_id = $${idx++}`); vals.push(project_id) }
  if (language)   { conditions.push(`language = $${idx++}`); vals.push(language) }
  if (entry_type) { conditions.push(`entry_type = $${idx++}`); vals.push(entry_type) }
  if (search)     { conditions.push(`(title ILIKE $${idx} OR content ILIKE $${idx++})`); vals.push(`%${search}%`) }
  vals.push(parseInt(limit as string), (parseInt(page as string) - 1) * parseInt(limit as string))
  const r = await pool.query(
    `SELECT id, title, entry_type, language, file_path, tags, quality_score, enabled, source, created_at,
            LEFT(content, 200) AS content_preview
     FROM kb_entries WHERE ${conditions.join(' AND ')}
     ORDER BY quality_score DESC, created_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`, vals
  )
  const total = await pool.query(`SELECT COUNT(*) FROM kb_entries WHERE ${conditions.join(' AND ')}`, vals.slice(0, -2))
  ok(res, { items: r.rows, total: parseInt(total.rows[0].count), page: parseInt(page as string), limit: parseInt(limit as string) })
})

router.get('/kb/:id', async (req, res) => {
  const r = await pool.query(`SELECT * FROM kb_entries WHERE id = $1`, [req.params.id])
  if (r.rows.length === 0) return fail(res, '不存在', 404)
  ok(res, r.rows[0])
})

router.post('/kb', async (req, res) => {
  const { title, content, entry_type, language, file_path, tags, project_id, quality_score } = req.body
  if (!title || !content) return fail(res, '缺少必填字段: title, content')
  // 自动提取符号（简单规则）
  const symbols = extractSymbols(content, language)
  const r = await pool.query(
    `INSERT INTO kb_entries (title, content, entry_type, language, file_path, tags, project_id, quality_score, symbols, source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',$10) RETURNING *`,
    [title, content, entry_type || 'code', language || null, file_path || null,
     tags || [], project_id || null, quality_score || 70, symbols,
     req.headers['x-developer-id'] || 'admin']
  )
  // 触发索引重建（异步）
  triggerKBReindex(project_id).catch(() => {})
  await logAudit('kb_entry.create', req, 'kb_entry', r.rows[0].id, req.body)
  ok(res, r.rows[0])
})

router.put('/kb/:id', async (req, res) => {
  const fields = ['title','content','entry_type','language','file_path','tags','quality_score','enabled']
  const sets = [], vals = []
  let idx = 1
  for (const f of fields) {
    if (req.body[f] !== undefined) { sets.push(`${f} = $${idx++}`); vals.push(req.body[f]) }
  }
  if (sets.length === 0) return fail(res, '无有效字段')
  // 重新提取符号
  if (req.body.content) { sets.push(`symbols = $${idx++}`); vals.push(extractSymbols(req.body.content, req.body.language)) }
  vals.push(req.params.id)
  const r = await pool.query(`UPDATE kb_entries SET ${sets.join(',')} WHERE id = $${idx} RETURNING *`, vals)
  if (r.rowCount === 0) return fail(res, '不存在', 404)
  await logAudit('kb_entry.update', req, 'kb_entry', req.params.id, req.body)
  ok(res, r.rows[0])
})

router.delete('/kb/:id', async (req, res) => {
  await pool.query(`DELETE FROM kb_entries WHERE id = $1`, [req.params.id])
  await logAudit('kb_entry.delete', req, 'kb_entry', req.params.id, {})
  ok(res, { deleted: true })
})

// ── 系统设置 ──────────────────────────────────────────────────
router.get('/settings', async (req, res) => {
  const r = await pool.query(`SELECT * FROM system_settings ORDER BY category, key`)
  ok(res, r.rows)
})

router.put('/settings/:key', async (req, res) => {
  const { value, description } = req.body
  if (value === undefined) return fail(res, '缺少 value')
  await pool.query(
    `INSERT INTO system_settings (key, value, description, updated_by)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $4, updated_at = NOW()`,
    [req.params.key, JSON.stringify(value), description || null, req.headers['x-developer-id'] || 'admin']
  )
  await logAudit('setting.update', req, 'system_setting', null, { key: req.params.key, value })
  ok(res, { key: req.params.key, value })
})

// ── 数据统计 ──────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  const [tasks, specs, kb, agents, skills] = await Promise.all([
    pool.query(`SELECT status, COUNT(*) FROM generation_tasks GROUP BY status`),
    pool.query(`SELECT COUNT(*) FROM feature_specs WHERE created_at > NOW()-INTERVAL '7 days'`),
    pool.query(`SELECT COUNT(*), language FROM kb_entries WHERE enabled=true GROUP BY language`),
    pool.query(`SELECT COUNT(*) FILTER (WHERE enabled) as enabled, COUNT(*) as total FROM agent_definitions`),
    pool.query(`SELECT COUNT(*) FILTER (WHERE enabled) as enabled, COUNT(*) as total FROM skill_definitions`)
  ])
  ok(res, {
    tasks:   Object.fromEntries(tasks.rows.map((r: any) => [r.status, parseInt(r.count)])),
    specs_7d: parseInt(specs.rows[0].count),
    kb:      { total: kb.rows.reduce((s: number, r: any) => s + parseInt(r.count), 0), byLanguage: Object.fromEntries(kb.rows.map((r: any) => [r.language, parseInt(r.count)])) },
    agents:  agents.rows[0],
    skills:  skills.rows[0]
  })
})

// ── 辅助函数 ──────────────────────────────────────────────────
function extractSymbols(content: string, language?: string): string[] {
  const symbols = new Set<string>()
  // 提取大写开头的标识符
  const matches = content.match(/\b[A-Z][a-zA-Z0-9]+\b/g) || []
  for (const m of matches) symbols.add(m)
  return Array.from(symbols).slice(0, 50)
}

async function triggerKBReindex(projectId?: string) {
  // 触发知识库重建（发 Redis 消息）
  try {
    const Redis = require('ioredis')
    const redis = new Redis(process.env.REDIS_URL)
    await redis.publish('kb:reindex', JSON.stringify({ projectId, timestamp: Date.now() }))
    await redis.quit()
  } catch { /* 非阻塞 */ }
}

module.exports = router
