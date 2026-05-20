'use strict'
/**
 * server.js — 纯 Node.js 内置模块实现的 HTTP 服务器
 * 无 express/cors/dotenv 等任何第三方依赖
 */
const { normalize } = require('./normalize')

const http = require('http')
const { URL } = require('url')

// ── 环境变量（简单 .env 读取） ────────────────────────────────
function loadEnv() {
  const fs   = require('fs')
  const path = require('path')
  const candidates = [
    path.resolve(__dirname, '../../../.env'),
    path.resolve(__dirname, '../../../../.env'),
    path.resolve(process.cwd(), '.env'),
  ]
  for (const f of candidates) {
    if (fs.existsSync(f)) {
      const lines = fs.readFileSync(f, 'utf8').split('\n')
      for (const line of lines) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
        if (m && !process.env[m[1]]) {
          process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim()
        }
      }
      break
    }
  }
}
loadEnv()

const { PGPool } = require('./pg-pool')
const pool = new PGPool(process.env.POSTGRES_URL || 'postgresql://awp:awp_secret_2024@localhost:5432/ai_workflow')

// ── CORS Headers ──────────────────────────────────────────────
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Admin-Key,X-Developer-ID,X-Project-ID')
}

// ── 响应工具 ──────────────────────────────────────────────────
function json(res, data, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}
const ok   = (res, data)          => json(res, { success: true,  data })
const fail = (res, msg, code=400) => json(res, { success: false, error: msg }, code)

// ── Body 解析 ─────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', c => { raw += c; if (raw.length > 2_000_000) reject(new Error('body too large')) })
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}) }
      catch { resolve({}) }
    })
    req.on('error', reject)
  })
}

// ── 审计日志 ──────────────────────────────────────────────────
function auditLog(action, req) {
  pool.query(
    `INSERT INTO audit_logs (action, actor, resource_type, metadata) VALUES ($1,$2,'admin',$3)`,
    [action, req.headers['x-developer-id'] || 'admin', JSON.stringify({ ip: req.socket.remoteAddress })]
  ).catch(() => {})
}

// ── 简单路由器 ────────────────────────────────────────────────
const routes = []
function route(method, pattern, handler) {
  routes.push({ method: method.toUpperCase(), pattern, handler })
}

function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method && r.method !== 'ALL') continue
    if (typeof r.pattern === 'string') {
      if (r.pattern === pathname) return { handler: r.handler, params: {} }
    } else {
      const m = pathname.match(r.pattern)
      if (m) return { handler: r.handler, params: m.groups || {} }
    }
  }
  return null
}

// ── 路由注册 ─────────────────────────────────────────────────

// Health
route('GET', '/health', async (req, res) => {
  try {
    await pool.query('SELECT 1')
    ok(res, { status: 'ok', service: 'admin', db: 'connected', ts: Date.now() })
  } catch (e) {
    ok(res, { status: 'degraded', service: 'admin', db: 'disconnected', error: e.message, ts: Date.now() })
  }
})

// ── LLM Providers ────────────────────────────────────────────
route('GET', '/api/admin/llm-providers', async (req, res) => {
  const r = await pool.query(`SELECT * FROM llm_providers ORDER BY is_default DESC, provider_type, name`)
  ok(res, normalize('llm_providers', r.rows))
})

route('POST', '/api/admin/llm-providers', async (req, res) => {
  const b = await readBody(req)
  if (!b.name || !b.provider_type || !b.model_id) return fail(res, '缺少必填字段: name, provider_type, model_id')
  const r = await pool.query(
    `INSERT INTO llm_providers (name,display_name,provider_type,base_url,api_key_env,api_key_value,model_id,context_window,max_output_tokens,extra_params)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [b.name, b.display_name||b.name, b.provider_type, b.base_url||null, b.api_key_env||null,
     b.api_key_value||null, b.model_id, b.context_window||128000, b.max_output_tokens||8192,
     JSON.stringify(b.extra_params||{})]
  )
  auditLog(`llm_provider.create:${b.name}`, req)
  ok(res, normalize('llm_providers', r.rows[0]))
})

route('PUT', /^\/api\/admin\/llm-providers\/(?<name>[^/]+)$/, async (req, res, params) => {
  const b    = await readBody(req)
  const sets = [], vals = []
  let idx = 1
  const allowed = ['display_name','base_url','api_key_env','api_key_value','model_id',
                   'context_window','max_output_tokens','enabled','is_default','extra_params','input_price_per_1k','output_price_per_1k']
  for (const k of allowed) {
    if (b[k] !== undefined) {
      sets.push(`${k} = $${idx++}`)
      vals.push(k === 'extra_params' ? JSON.stringify(b[k]) : b[k])
    }
  }
  if (!sets.length) return fail(res, '无有效字段')
  vals.push(params.name)
  const r = await pool.query(`UPDATE llm_providers SET ${sets.join(',')} WHERE name=$${idx} RETURNING *`, vals)
  auditLog(`llm_provider.update:${params.name}`, req)
  ok(res, normalize('llm_providers', r.rows[0]))
})

route('DELETE', /^\/api\/admin\/llm-providers\/(?<name>[^/]+)$/, async (req, res, params) => {
  await pool.query(`UPDATE llm_providers SET enabled=false WHERE name=$1`, [params.name])
  auditLog(`llm_provider.disable:${params.name}`, req)
  ok(res, { disabled: true })
})

// LLM 连通性测试
route('POST', '/api/admin/llm/test', async (req, res) => {
  const { providerName, testPrompt } = await readBody(req)
  try {
    const r = await pool.query(`SELECT * FROM llm_providers WHERE name=$1 AND enabled=true`, [providerName])
    if (!r.rows.length) return fail(res, `模型 ${providerName} 不存在或已禁用`)
    const p = r.rows[0]
    // 获取 API Key
    const apiKey = p.api_key_value || process.env[p.api_key_env] || ''
    if (!apiKey && p.provider_type !== 'ollama') return ok(res, { ok: false, error: 'API Key 未配置' })
    // 简单 HTTP 测试调用
    const result = await testLLM(p, apiKey, testPrompt || '请回复"连接测试成功"')
    ok(res, result)
  } catch (e) {
    ok(res, { ok: false, error: e.message })
  }
})

// ── Skills ───────────────────────────────────────────────────
route('GET', '/api/admin/skills', async (req, res) => {
  const url    = new URL(`http://x${req.url}`)
  const projId = url.searchParams.get('project_id') || null
  const r = await pool.query(
    `SELECT * FROM skill_definitions WHERE project_id IS NULL OR project_id=$1 ORDER BY is_builtin DESC, category, name`,
    [projId]
  )
  ok(res, normalize('skill_definitions', r.rows))
})

route('POST', '/api/admin/skills', async (req, res) => {
  const b = await readBody(req)
  if (!b.name || !b.executor_type) return fail(res, '缺少必填字段: name, executor_type')
  const r = await pool.query(
    `INSERT INTO skill_definitions
       (name,display_name,description,category,executor_type,system_prompt,user_prompt_template,
        preferred_llm,max_tokens,temperature,function_name,webhook_url,webhook_headers,
        script_code,input_schema,output_schema,project_id,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [b.name, b.display_name||b.name, b.description||'', b.category||'custom', b.executor_type,
     b.system_prompt||null, b.user_prompt_template||null, b.preferred_llm||null,
     b.max_tokens||4096, b.temperature||0.2, b.function_name||null,
     b.webhook_url||null, JSON.stringify(b.webhook_headers||{}),
     b.script_code||null, JSON.stringify(b.input_schema||{}),
     JSON.stringify(b.output_schema||{}), b.project_id||null,
     req.headers['x-developer-id']||'admin']
  )
  auditLog(`skill.create:${b.name}`, req)
  ok(res, normalize('skill_definitions', r.rows[0]))
})

route('PUT', /^\/api\/admin\/skills\/(?<id>[^/]+)$/, async (req, res, params) => {
  const b = await readBody(req)
  const allowed = ['display_name','description','category','system_prompt','user_prompt_template',
                   'preferred_llm','max_tokens','temperature','webhook_url','script_code',
                   'input_schema','output_schema','enabled']
  const sets = [], vals = []
  let idx = 1
  for (const k of allowed) {
    if (b[k] !== undefined) {
      sets.push(`${k}=$${idx++}`)
      vals.push(['input_schema','output_schema'].includes(k) ? JSON.stringify(b[k]) : b[k])
    }
  }
  if (!sets.length) return fail(res, '无有效字段')
  vals.push(params.id)
  const r = await pool.query(
    `UPDATE skill_definitions SET ${sets.join(',')} WHERE id=$${idx} AND is_builtin=false RETURNING *`, vals
  )
  if (!r.rows.length) return fail(res, '不存在或内置 Skill 不可修改', 404)
  auditLog(`skill.update:${params.id}`, req)
  ok(res, normalize('skill_definitions', r.rows[0]))
})

route('DELETE', /^\/api\/admin\/skills\/(?<id>[^/]+)$/, async (req, res, params) => {
  const r = await pool.query(
    `UPDATE skill_definitions SET enabled=false WHERE id=$1 AND is_builtin=false RETURNING id`, [params.id]
  )
  if (!r.rows.length) return fail(res, '不存在或内置 Skill 不可删除', 404)
  auditLog(`skill.delete:${params.id}`, req)
  ok(res, { disabled: true })
})

// ── Agents ───────────────────────────────────────────────────
route('GET', '/api/admin/agents', async (req, res) => {
  const url    = new URL(`http://x${req.url}`)
  const projId = url.searchParams.get('project_id') || null
  const r = await pool.query(
    `SELECT ad.*, ARRAY(SELECT sd.display_name FROM skill_definitions sd WHERE sd.name=ANY(ad.skill_names) AND sd.display_name IS NOT NULL) AS skill_display_names
     FROM agent_definitions ad WHERE ad.project_id IS NULL OR ad.project_id=$1
     ORDER BY ad.is_builtin DESC, ad.domain, ad.name`,
    [projId]
  )
  ok(res, normalize('agent_definitions', r.rows))
})

route('POST', '/api/admin/agents', async (req, res) => {
  const b = await readBody(req)
  if (!b.name || !b.skill_names?.length) return fail(res, '缺少必填字段: name, skill_names')
  const check = await pool.query(`SELECT name FROM skill_definitions WHERE name=ANY($1) AND enabled=true`, [b.skill_names])
  const found   = check.rows.map(r => r.name)
  const missing = b.skill_names.filter(s => !found.includes(s))
  if (missing.length) return fail(res, `Skill 不存在或已禁用: ${missing.join(', ')}`)
  const r = await pool.query(
    `INSERT INTO agent_definitions (name,display_name,description,domain,skill_names,system_prompt,preferred_llm,max_retries,timeout_ms,temperature,tags,project_id,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [b.name, b.display_name||b.name, b.description||'', b.domain||'*', b.skill_names,
     b.system_prompt||null, b.preferred_llm||null, b.max_retries||3,
     b.timeout_ms||120000, b.temperature||0.2, b.tags||[],
     b.project_id||null, req.headers['x-developer-id']||'admin']
  )
  auditLog(`agent.create:${b.name}`, req)
  ok(res, normalize('agent_definitions', r.rows[0]))
})

route('PUT', /^\/api\/admin\/agents\/(?<id>[^/]+)$/, async (req, res, params) => {
  const b = await readBody(req)
  const allowed = ['display_name','description','domain','skill_names','system_prompt',
                   'preferred_llm','max_retries','timeout_ms','temperature','tags','enabled']
  const sets = [], vals = []
  let idx = 1
  for (const k of allowed) {
    if (b[k] !== undefined) { sets.push(`${k}=$${idx++}`); vals.push(b[k]) }
  }
  if (!sets.length) return fail(res, '无有效字段')
  vals.push(params.id)
  const r = await pool.query(
    `UPDATE agent_definitions SET ${sets.join(',')} WHERE id=$${idx} AND is_builtin=false RETURNING *`, vals
  )
  if (!r.rows.length) return fail(res, '不存在或内置 Agent 不可修改', 404)
  auditLog(`agent.update:${params.id}`, req)
  ok(res, normalize('agent_definitions', r.rows[0]))
})

route('PATCH', /^\/api\/admin\/agents\/(?<id>[^/]+)\/toggle$/, async (req, res, params) => {
  const r = await pool.query(
    `UPDATE agent_definitions SET enabled=NOT enabled WHERE id=$1 RETURNING id,name,enabled`, [params.id]
  )
  if (!r.rows.length) return fail(res, '不存在', 404)
  auditLog(`agent.toggle:${params.id}`, req)
  ok(res, r.rows[0])
})

// ── Knowledge Base ────────────────────────────────────────────
route('GET', '/api/admin/kb', async (req, res) => {
  const url     = new URL(`http://x${req.url}`)
  const page    = parseInt(url.searchParams.get('page') || '1')
  const limit   = parseInt(url.searchParams.get('limit') || '20')
  const projId  = url.searchParams.get('project_id') || null
  const lang    = url.searchParams.get('language') || null
  const type    = url.searchParams.get('entry_type') || null
  const search  = url.searchParams.get('search') || null
  const offset  = (page - 1) * limit

  const conds = ['1=1'], vals = []
  let idx = 1
  if (projId) { conds.push(`project_id=$${idx++}`); vals.push(projId) }
  if (lang)   { conds.push(`language=$${idx++}`);   vals.push(lang) }
  if (type)   { conds.push(`entry_type=$${idx++}`); vals.push(type) }
  if (search) { conds.push(`(title ILIKE $${idx} OR content ILIKE $${idx++})`); vals.push(`%${search}%`) }

  const where = conds.join(' AND ')
  const items = await pool.query(
    `SELECT id,title,entry_type,language,file_path,tags,quality_score,enabled,source,created_at,LEFT(content,200) AS content_preview
     FROM kb_entries WHERE ${where} ORDER BY quality_score DESC,created_at DESC LIMIT $${idx} OFFSET $${idx+1}`,
    [...vals, limit, offset]
  )
  const total = await pool.query(`SELECT COUNT(*) FROM kb_entries WHERE ${where}`, vals)
  ok(res, { items: normalize('kb_entries', items.rows), total: parseInt(total.rows[0].count), page, limit })
})

route('GET', /^\/api\/admin\/kb\/(?<id>[^/]+)$/, async (req, res, params) => {
  const r = await pool.query(`SELECT * FROM kb_entries WHERE id=$1`, [params.id])
  if (!r.rows.length) return fail(res, '不存在', 404)
  ok(res, normalize('kb_entries', r.rows[0]))
})

route('POST', '/api/admin/kb', async (req, res) => {
  const b = await readBody(req)
  if (!b.title || !b.content) return fail(res, '缺少必填字段: title, content')
  const symbols = extractSymbols(b.content, b.language)
  const r = await pool.query(
    `INSERT INTO kb_entries (title,content,entry_type,language,file_path,tags,project_id,quality_score,symbols,source,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',$10) RETURNING *`,
    [b.title, b.content, b.entry_type||'code', b.language||null, b.file_path||null,
     b.tags||[], b.project_id||null, b.quality_score||70, symbols,
     req.headers['x-developer-id']||'admin']
  )
  auditLog(`kb.create:${b.title}`, req)
  ok(res, normalize('kb_entries', r.rows[0]))
})

route('PUT', /^\/api\/admin\/kb\/(?<id>[^/]+)$/, async (req, res, params) => {
  const b = await readBody(req)
  const allowed = ['title','content','entry_type','language','file_path','tags','quality_score','enabled']
  const sets = [], vals = []
  let idx = 1
  for (const k of allowed) {
    if (b[k] !== undefined) { sets.push(`${k}=$${idx++}`); vals.push(b[k]) }
  }
  if (!sets.length) return fail(res, '无有效字段')
  if (b.content) { sets.push(`symbols=$${idx++}`); vals.push(extractSymbols(b.content, b.language)) }
  vals.push(params.id)
  const r = await pool.query(`UPDATE kb_entries SET ${sets.join(',')} WHERE id=$${idx} RETURNING *`, vals)
  if (!r.rows.length) return fail(res, '不存在', 404)
  auditLog(`kb.update:${params.id}`, req)
  ok(res, normalize('kb_entries', r.rows[0]))
})

route('DELETE', /^\/api\/admin\/kb\/(?<id>[^/]+)$/, async (req, res, params) => {
  await pool.query(`DELETE FROM kb_entries WHERE id=$1`, [params.id])
  auditLog(`kb.delete:${params.id}`, req)
  ok(res, { deleted: true })
})

// ── Settings ─────────────────────────────────────────────────
route('GET', '/api/admin/settings', async (req, res) => {
  const r = await pool.query(`SELECT * FROM system_settings ORDER BY category, key`)
  ok(res, normalize('system_settings', r.rows))
})

route('PUT', /^\/api\/admin\/settings\/(?<key>[^/]+)$/, async (req, res, params) => {
  const { value, description } = await readBody(req)
  if (value === undefined) return fail(res, '缺少 value')
  await pool.query(
    `INSERT INTO system_settings (key,value,description,updated_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (key) DO UPDATE SET value=$2, updated_by=$4, updated_at=NOW()`,
    [params.key, JSON.stringify(value), description||null, req.headers['x-developer-id']||'admin']
  )
  auditLog(`setting.update:${params.key}`, req)
  ok(res, { key: params.key, value })
})

// ── 代码生成任务管理 ──────────────────────────────────────────
// 注意：静态路由必须在 /:id 的正则路由前注册，否则会被当成 id

// 任务状态统计（静态路由，防止被 /:id 捕获）
route('GET', '/api/admin/tasks/stats', async (req, res) => {
  const r = await pool.query(
    `SELECT status, COUNT(*) AS count
     FROM generation_tasks
     GROUP BY status`
  )
  const byStatus = {}
  r.rows.forEach(row => { byStatus[row.status] = parseInt(row.count) })
  const total = r.rows.reduce((s, row) => s + parseInt(row.count), 0)
  ok(res, { byStatus, total })
})

// 任务列表（分页 + 过滤）
route('GET', '/api/admin/tasks', async (req, res) => {
  const url    = new URL(`http://x${req.url}`)
  const status = url.searchParams.get('status')  || null
  const search = url.searchParams.get('search')  || null
  const page   = Math.max(1, parseInt(url.searchParams.get('page')  || '1'))
  const limit  = Math.min(100, parseInt(url.searchParams.get('limit') || '20'))
  const offset = (page - 1) * limit

  const conds = ['1=1'], vals = []
  let idx = 1
  if (status) { conds.push(`gt.status=$${idx++}`);              vals.push(status) }
  if (search) { conds.push(`fs.title ILIKE $${idx++}`);         vals.push(`%${search}%`) }
  const where = conds.join(' AND ')

  const [items, cnt] = await Promise.all([
    pool.query(`
      SELECT
        gt.id, gt.spec_id, gt.status, gt.priority, gt.retry_count,
        gt.created_at, gt.completed_at, gt.started_at,
        LEFT(gt.error_log, 200) AS error_log,
        fs.title  AS spec_title,
        fs.project_id,
        sr.total_score
      FROM generation_tasks gt
      LEFT JOIN feature_specs fs ON gt.spec_id = fs.id
      LEFT JOIN LATERAL (
        SELECT total_score FROM score_records
        WHERE task_id = gt.id ORDER BY created_at DESC LIMIT 1
      ) sr ON true
      WHERE ${where}
      ORDER BY gt.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `, [...vals, limit, offset]),
    pool.query(
      `SELECT COUNT(*) FROM generation_tasks gt
       LEFT JOIN feature_specs fs ON gt.spec_id = fs.id
       WHERE ${where}`,
      vals
    )
  ])

  ok(res, { items: items.rows, total: parseInt(cnt.rows[0].count), page, limit })
})

// 批量删除（静态路由，必须在 /:id 前）
route('POST', '/api/admin/tasks/batch-delete', async (req, res) => {
  const { ids, status: delStatus } = await readBody(req)

  if (ids && Array.isArray(ids) && ids.length > 0) {
    await pool.query(`DELETE FROM score_records   WHERE task_id = ANY($1)`, [ids])
    await pool.query(`DELETE FROM failure_samples WHERE task_id = ANY($1)`, [ids])
    const r = await pool.query(
      `DELETE FROM generation_tasks WHERE id = ANY($1) RETURNING id`, [ids]
    )
    auditLog(`task.batch_delete:${r.rowCount}条`, req)
    ok(res, { deleted: r.rowCount })
  } else if (delStatus) {
    // 按状态批量删除
    const tids = await pool.query(
      `SELECT id FROM generation_tasks WHERE status=$1`, [delStatus]
    )
    const idList = tids.rows.map(r => r.id)
    if (!idList.length) return ok(res, { deleted: 0 })

    await pool.query(`DELETE FROM score_records   WHERE task_id = ANY($1)`, [idList])
    await pool.query(`DELETE FROM failure_samples WHERE task_id = ANY($1)`, [idList])
    const r = await pool.query(
      `DELETE FROM generation_tasks WHERE status=$1 RETURNING id`, [delStatus]
    )
    auditLog(`task.batch_delete_by_status:${delStatus}:${r.rowCount}条`, req)
    ok(res, { deleted: r.rowCount })
  } else {
    fail(res, '需要提供 ids 数组或 status 参数')
  }
})

// 任务详情
route('GET', /^\/api\/admin\/tasks\/(?<id>[^/]+)$/, async (req, res, params) => {
  const r = await pool.query(`
    SELECT
      gt.*,
      fs.title AS spec_title, fs.structured_spec AS spec, fs.project_id,
      sr.correctness_score, sr.test_coverage, sr.quality_score, sr.total_score,
      sr.human_score, sr.feedback_text
    FROM generation_tasks gt
    LEFT JOIN feature_specs fs ON gt.spec_id = fs.id
    LEFT JOIN LATERAL (
      SELECT * FROM score_records WHERE task_id = gt.id ORDER BY created_at DESC LIMIT 1
    ) sr ON true
    WHERE gt.id = $1
  `, [params.id])
  if (!r.rows.length) return fail(res, '任务不存在', 404)
  ok(res, r.rows[0])
})

// 删除任务
route('DELETE', /^\/api\/admin\/tasks\/(?<id>[^/]+)$/, async (req, res, params) => {
  const exist = await pool.query(
    `SELECT id FROM generation_tasks WHERE id=$1`, [params.id]
  )
  if (!exist.rows.length) return fail(res, '任务不存在', 404)
  await pool.query(`DELETE FROM score_records   WHERE task_id=$1`, [params.id])
  await pool.query(`DELETE FROM failure_samples WHERE task_id=$1`, [params.id])
  await pool.query(`DELETE FROM generation_tasks WHERE id=$1`,     [params.id])
  auditLog(`task.delete:${params.id}`, req)
  ok(res, { deleted: true })
})

// 取消任务（将运行中的任务标记为 error）
route('POST', /^\/api\/admin\/tasks\/(?<id>[^/]+)\/cancel$/, async (req, res, params) => {
  const r = await pool.query(
    `UPDATE generation_tasks
     SET status='error', error_log='管理员手动取消', completed_at=NOW()
     WHERE id=$1
       AND status IN ('running','generated','auto_fix_1','auto_fix_2','auto_fix_3')
     RETURNING id`,
    [params.id]
  )
  if (!r.rows.length) return fail(res, '任务不在可取消状态（仅支持取消执行中的任务）', 400)
  auditLog(`task.cancel:${params.id}`, req)
  ok(res, { cancelled: true })
})

// ── Stats ────────────────────────────────────────────────────
route('GET', '/api/admin/stats', async (req, res) => {
  const [tasks, specs, kb, agents, skills] = await Promise.all([
    pool.query(`SELECT status, COUNT(*) FROM generation_tasks GROUP BY status`),
    pool.query(`SELECT COUNT(*) FROM feature_specs WHERE created_at>NOW()-INTERVAL '7 days'`),
    pool.query(`SELECT COUNT(*), language FROM kb_entries WHERE enabled=true GROUP BY language`),
    pool.query(`SELECT COUNT(*) FILTER (WHERE enabled) AS enabled, COUNT(*) AS total FROM agent_definitions`),
    pool.query(`SELECT COUNT(*) FILTER (WHERE enabled) AS enabled, COUNT(*) AS total FROM skill_definitions`),
  ])
  ok(res, {
    tasks:    Object.fromEntries(tasks.rows.map(r => [r.status, parseInt(r.count)])),
    specs_7d: parseInt(specs.rows[0].count),
    kb:       { total: kb.rows.reduce((s,r) => s+parseInt(r.count), 0), byLanguage: Object.fromEntries(kb.rows.map(r => [r.language, parseInt(r.count)])) },
    agents:   agents.rows[0],
    skills:   skills.rows[0],
  })
})

// ── LLM 测试辅助 ──────────────────────────────────────────────
function testLLM(provider, apiKey, prompt) {
  return new Promise((resolve) => {
    const https = require('https')
    const http2 = require('http')

    let body, hostname, path, lib

    if (provider.provider_type === 'anthropic') {
      body = JSON.stringify({ model: provider.model_id, max_tokens: 50, messages: [{ role: 'user', content: prompt }] })
      hostname = 'api.anthropic.com'; path = '/v1/messages'; lib = https
    } else if (['openai','deepseek','qwen','zhipu','custom'].includes(provider.provider_type)) {
      body = JSON.stringify({ model: provider.model_id, max_tokens: 50, messages: [{ role: 'user', content: prompt }] })
      const base = provider.base_url || (provider.provider_type === 'deepseek' ? 'https://api.deepseek.com' : provider.provider_type === 'qwen' ? 'https://dashscope.aliyuncs.com/compatible-mode' : 'https://api.openai.com')
      // const u = new URL('/v1/chat/completions', base)
      const u = new URL('/v1/', base)
      hostname = u.hostname; path = u.pathname; lib = u.protocol === 'https:' ? https : http2
    } else if (provider.provider_type === 'ollama') {
      body = JSON.stringify({ model: provider.model_id, messages: [{ role: 'user', content: prompt }], stream: false })
      const base = provider.base_url || 'http://localhost:11434'
      const u = new URL('/api/chat', base)
      hostname = u.hostname; path = u.pathname; lib = u.protocol === 'https:' ? https : http2
    } else {
      return resolve({ ok: false, error: `不支持的 provider_type: ${provider.provider_type}` })
    }

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    }
    if (provider.provider_type === 'anthropic') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else if (provider.provider_type !== 'ollama') {
      headers['Authorization'] = `Bearer ${apiKey}`
    }

    const start = Date.now()
    const req = lib.request({ hostname, path, method: 'POST', headers, timeout: 15000 }, (res) => {
      let raw = ''
      res.on('data', d => raw += d)
      res.on('end', () => {
        try {
          const d = JSON.parse(raw)
          const content = d.content?.[0]?.text || d.choices?.[0]?.message?.content || d.message?.content || ''
          resolve({ ok: true, content: content.slice(0,100), latencyMs: Date.now()-start, model: provider.model_id })
        } catch { resolve({ ok: false, error: raw.slice(0,200) }) }
      })
    })
    req.on('error', e => resolve({ ok: false, error: e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '请求超时' }) })
    req.write(body)
    req.end()
  })
}

// ── 工具函数 ──────────────────────────────────────────────────
function extractSymbols(content, language) {
  const symbols = new Set()
  const matches = content.match(/\b[A-Z][a-zA-Z0-9]+\b/g) || []
  for (const m of matches) symbols.add(m)
  return Array.from(symbols).slice(0, 50)
}

// ── HTTP Server ───────────────────────────────────────────────
const PORT    = parseInt(process.env.ADMIN_PORT || '3006')
const API_KEY = process.env.ADMIN_API_KEY || ''

const server = http.createServer(async (req, res) => {
  setCORS(res)

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return
  }

  // 鉴权（跳过 health 检查）
  const pathname = new URL(`http://x${req.url}`).pathname
  if (pathname !== '/health') {
    const key = req.headers['x-admin-key']
    if (API_KEY && key !== API_KEY) {
      return json(res, { success: false, error: '未授权' }, 401)
    }
  }

  const match = matchRoute(req.method, pathname)
  if (!match) return json(res, { success: false, error: '接口不存在' }, 404)

  try {
    await match.handler(req, res, match.params)
  } catch (err) {
    console.error(`[Admin API Error] ${req.method} ${pathname}:`, err.message)
    json(res, { success: false, error: err.message }, 500)
  }
})

server.listen(PORT, () => {
  console.log(`🚀 admin 服务启动，端口 ${PORT}`)
  console.log(`   健康检查: http://localhost:${PORT}/health`)
  console.log(`   管理 API: http://localhost:${PORT}/api/admin/...`)
})

server.on('error', err => {
  console.error('服务器启动失败:', err.message)
  process.exit(1)
})

process.on('SIGTERM', async () => { await pool.end(); process.exit(0) })
process.on('SIGINT',  async () => { await pool.end(); process.exit(0) })
