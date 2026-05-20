/**
 * gateway/tenant-db.js
 *
 * 租户感知的 PostgreSQL 查询封装
 * 确保每个 SQL 查询都强制带上 project_id WHERE 条件
 */

'use strict'

const { Pool } = require('pg')
let pool

function initTenantDB(connectionString) {
  pool = new Pool({ connectionString })
}

/**
 * 租户隔离查询：自动为所有主表查询添加 project_id 过滤
 */
class TenantDB {
  constructor(projectId) {
    this.projectId = projectId
  }

  // ── feature_specs ─────────────────────────────────────────
  async listSpecs({ limit = 50, offset = 0, status } = {}) {
    const filters = [`project_id = $1`]
    const params  = [this.projectId]
    let idx = 2

    if (status) { filters.push(`status = $${idx++}`); params.push(status) }

    params.push(limit, offset)
    const sql = `
      SELECT * FROM feature_specs
      WHERE ${filters.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${idx++} OFFSET $${idx}
    `
    const r = await pool.query(sql, params)
    return r.rows
  }

  async saveSpec({ title, rawInput, structuredSpec, completenessScore, createdBy }) {
    const r = await pool.query(
      `INSERT INTO feature_specs
         (title, raw_input, structured_spec, completeness_score, project_id, created_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,'submitted')
       RETURNING id`,
      [title, rawInput, JSON.stringify(structuredSpec), completenessScore, this.projectId, createdBy || 'anonymous']
    )
    return r.rows[0]
  }

  // ── generation_tasks ──────────────────────────────────────
  async listTasks({ limit = 50, offset = 0, status } = {}) {
    const params = [this.projectId]
    let idx = 2
    let statusFilter = ''
    if (status) { statusFilter = `AND gt.status = $${idx++}`; params.push(status) }

    params.push(limit, offset)
    const sql = `
      SELECT
        gt.id AS task_id, gt.spec_id, gt.status, gt.priority,
        gt.retry_count, gt.created_at, gt.completed_at,
        fs.title AS spec_title, fs.structured_spec AS spec,
        sr.total_score
      FROM generation_tasks gt
      LEFT JOIN feature_specs fs ON gt.spec_id = fs.id
        AND fs.project_id = $1
      LEFT JOIN LATERAL (
        SELECT total_score FROM score_records
        WHERE task_id = gt.id ORDER BY created_at DESC LIMIT 1
      ) sr ON true
      WHERE fs.project_id = $1 ${statusFilter}
      ORDER BY gt.created_at DESC
      LIMIT $${idx++} OFFSET $${idx}
    `
    const r = await pool.query(sql, params)
    return { items: r.rows, total: r.rowCount }
  }

  // ── score_records（用于进化机制） ─────────────────────────
  async getHighScoreSamples({ minScore = 70, limit = 20 } = {}) {
    const r = await pool.query(
      `SELECT
         sr.*, gt.spec_id, fs.structured_spec AS spec,
         gt.generated_files
       FROM score_records sr
       JOIN generation_tasks gt ON sr.task_id = gt.id
       JOIN feature_specs fs ON gt.spec_id = fs.id
       WHERE fs.project_id = $1
         AND sr.total_score >= $2
         AND gt.status = 'human_accepted'
       ORDER BY sr.total_score DESC
       LIMIT $3`,
      [this.projectId, minScore, limit]
    )
    return r.rows
  }

  async getLowScoreSamples({ maxScore = 40, limit = 20 } = {}) {
    const r = await pool.query(
      `SELECT
         fs_s.*, gt.spec_id,
         gt.error_log, gt.test_result
       FROM failure_samples fs_s
       JOIN generation_tasks gt ON fs_s.task_id = gt.id
       JOIN feature_specs fs ON gt.spec_id = fs.id
       WHERE fs.project_id = $1
         AND fs_s.resolved = false
       ORDER BY fs_s.created_at DESC
       LIMIT $2`,
      [this.projectId, limit]
    )
    return r.rows
  }

  // ── 审计日志（强制带 project_id） ─────────────────────────
  async writeAuditLog({ action, actor, resourceType, resourceId, metadata = {} }) {
    await pool.query(
      `INSERT INTO audit_logs
         (action, actor, resource_type, resource_id, project_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [action, actor, resourceType, resourceId, this.projectId, JSON.stringify(metadata)]
    )
  }
}

module.exports = { initTenantDB, TenantDB }
