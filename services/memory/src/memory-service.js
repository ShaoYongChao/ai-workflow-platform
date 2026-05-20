/**
 * services/memory/src/memory-service.js
 *
 * Hemers 架构记忆系统
 *   - 会话记忆（短期）：Redis TTL，任务完成后持久化摘要
 *   - 长期项目记忆：PostgreSQL + access_count 追踪
 *   - 技能记忆：可复用生成模板，高频记忆触发巩固
 *   - 巩固机制（Consolidation）：每日凌晨，高频短期 → 长期
 *   - 记忆衰减：低分样本降权，连续 3 次低分从库中移除
 */

'use strict'

const { Pool }  = require('pg')
const Redis     = require('ioredis')

// ── 常量 ──────────────────────────────────────────────────────
const SESSION_TTL_SECONDS     = 24 * 60 * 60    // 会话记忆 24h
const CONSOLIDATION_THRESHOLD = 3               // 7天内访问 N 次触发巩固
const CONSOLIDATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const LOW_SCORE_THRESHOLD     = 40              // 低于此分数视为低质量
const LOW_SCORE_REMOVE_COUNT  = 3               // 连续 N 次低分则移除

class MemoryService {
  constructor({ postgresUrl, redisUrl } = {}) {
    this.pool  = new Pool({ connectionString: postgresUrl })
    this.redis = new Redis(redisUrl || 'redis://localhost:6379')
  }

  // ================================================================
  // 编码（Encoding）
  // 将交互关键信息转化为向量并存储
  // ================================================================

  /**
   * 编码会话事件（如"策划确认了某需求"、"代码重构成功"）
   */
  async encodeSessionEvent(sessionId, projectId, event) {
    const key     = `mem:session:${sessionId}`
    const content = typeof event === 'string' ? event : JSON.stringify(event)

    // 推入 Redis 列表（按时间顺序）
    await this.redis.rpush(key, JSON.stringify({
      content, timestamp: Date.now(), projectId
    }))
    await this.redis.expire(key, SESSION_TTL_SECONDS)
  }

  /**
   * 编码任务完成事件（持久化到 PostgreSQL session_memories）
   */
  async encodeTaskCompletion(taskId, projectId, developerId, summary) {
    await this.pool.query(
      `INSERT INTO session_memories
         (session_id, project_id, developer_id, content, expires_at)
       VALUES ($1,$2,$3,$4, NOW() + INTERVAL '7 days')`,
      [taskId, projectId, developerId, summary]
    )
  }

  // ================================================================
  // 检索（Retrieval）
  // 根据当前任务语义，从长期记忆检索相关"历史经验"注入上下文
  // ================================================================

  /**
   * 检索项目相关记忆（基于关键词匹配 + access_count 排序）
   */
  async retrieveProjectMemory(projectId, keywords = [], types = []) {
    const conditions = ['project_id = $1']
    const params     = [projectId]
    let   idx        = 2

    if (types.length > 0) {
      conditions.push(`memory_type = ANY($${idx++})`)
      params.push(types)
    }

    if (keywords.length > 0) {
      const kwConditions = keywords.map(() => `(title ILIKE $${idx++} OR content ILIKE $${idx - 1})`)
      conditions.push(`(${kwConditions.join(' OR ')})`)
      for (const kw of keywords) params.push(`%${kw}%`)
    }

    const sql = `
      SELECT id, memory_type, title, content, access_count, confidence
      FROM project_memories
      WHERE ${conditions.join(' AND ')}
      ORDER BY confidence DESC, access_count DESC
      LIMIT 10
    `
    const r = await this.pool.query(sql, params)

    // 更新访问次数
    if (r.rows.length > 0) {
      const ids = r.rows.map(row => row.id)
      await this.pool.query(
        `UPDATE project_memories
         SET access_count = access_count + 1, last_accessed = NOW()
         WHERE id = ANY($1)`,
        [ids]
      )
    }

    return r.rows
  }

  /**
   * 检索技能记忆（供 code-generator 使用）
   */
  async retrieveSkills(projectId, featureKeywords = []) {
    const params = [projectId]
    let   idx    = 2
    let   kwCond = ''

    if (featureKeywords.length > 0) {
      const conds = featureKeywords.map(() => `(skill_name ILIKE $${idx++} OR description ILIKE $${idx - 1})`)
      kwCond      = `AND (${conds.join(' OR ')})`
      for (const kw of featureKeywords) params.push(`%${kw}%`)
    }

    const r = await this.pool.query(
      `SELECT skill_name, description, template, input_schema, success_rate
       FROM skill_memories
       WHERE (project_id = $1 OR project_id IS NULL) ${kwCond}
       ORDER BY success_rate DESC, use_count DESC
       LIMIT 5`,
      params
    )
    return r.rows
  }

  /**
   * 获取会话历史（给 spec-normalizer 注入上轮对话上下文）
   */
  async getSessionHistory(sessionId) {
    const key  = `mem:session:${sessionId}`
    const items = await this.redis.lrange(key, 0, -1)
    return items.map(item => {
      try { return JSON.parse(item) } catch { return { content: item } }
    })
  }

  // ================================================================
  // 巩固（Consolidation）
  // 每日凌晨：将高频短期记忆沉淀为长期记忆中的"技能"
  // ================================================================

  async runConsolidation(projectId) {
    const since = new Date(Date.now() - CONSOLIDATION_WINDOW_MS)
    console.log(`[Memory] 开始巩固 project=${projectId} since=${since.toISOString()}`)

    // 查找 7 天内被访问 3+ 次的短期记忆
    const r = await this.pool.query(
      `SELECT sm.session_id, sm.content, COUNT(*) as access_count
       FROM session_memories sm
       WHERE sm.project_id = $1
         AND sm.created_at > $2
         AND sm.expires_at > NOW()
       GROUP BY sm.session_id, sm.content
       HAVING COUNT(*) >= $3`,
      [projectId, since, CONSOLIDATION_THRESHOLD]
    )

    let consolidated = 0
    for (const row of r.rows) {
      // 检查是否已经巩固过
      const existing = await this.pool.query(
        `SELECT id FROM project_memories WHERE project_id = $1 AND title = $2`,
        [projectId, row.content.slice(0, 100)]
      )
      if (existing.rows.length > 0) continue

      // 创建长期记忆
      const memResult = await this.pool.query(
        `INSERT INTO project_memories
           (project_id, memory_type, title, content, confidence)
         VALUES ($1, 'best_practice', $2, $3, 0.6)
         RETURNING id`,
        [projectId, row.content.slice(0, 100), row.content]
      )

      // 记录巩固日志
      await this.pool.query(
        `INSERT INTO consolidation_logs (project_id, source_session, target_memory_id)
         VALUES ($1, $2, $3)`,
        [projectId, row.session_id, memResult.rows[0].id]
      )
      consolidated++
    }

    console.log(`[Memory] 巩固完成: ${consolidated} 条记忆`)
    return consolidated
  }

  // ================================================================
  // 记忆衰减
  // 被评分系统打低分的记忆降权，连续 3 次低分从库中移除
  // ================================================================

  async applyDecay(projectId, taskId, score) {
    if (score >= LOW_SCORE_THRESHOLD) return  // 高分不处理

    // 找与此任务 spec 相关的记忆
    const r = await this.pool.query(
      `SELECT pm.id, pm.confidence
       FROM project_memories pm
       WHERE pm.project_id = $1
         AND pm.source_task = $2`,
      [projectId, taskId]
    )

    for (const mem of r.rows) {
      const newConf = Math.max(0, mem.confidence - 0.2)
      await this.pool.query(
        `UPDATE project_memories SET confidence = $1 WHERE id = $2`,
        [newConf, mem.id]
      )

      // 置信度极低时移除
      if (newConf <= 0.1) {
        await this.pool.query('DELETE FROM project_memories WHERE id = $1', [mem.id])
        console.log(`[Memory] 低质量记忆已移除: ${mem.id}`)
      }
    }
  }

  /**
   * 写入技能记忆（代码生成成功后调用）
   */
  async saveSkillMemory(projectId, { skillName, description, template, inputSchema, success = true }) {
    await this.pool.query(
      `INSERT INTO skill_memories
         (project_id, skill_name, description, template, input_schema,
          success_rate, use_count, last_used_at)
       VALUES ($1,$2,$3,$4,$5,$6,1,NOW())
       ON CONFLICT (project_id, skill_name) DO UPDATE
         SET description  = EXCLUDED.description,
             template     = EXCLUDED.template,
             success_rate = (skill_memories.success_rate * skill_memories.use_count + $6)
                            / (skill_memories.use_count + 1),
             use_count    = skill_memories.use_count + 1,
             last_used_at = NOW(),
             updated_at   = NOW()`,
      [projectId, skillName, description, template, JSON.stringify(inputSchema || {}), success ? 1.0 : 0.0]
    )
  }

  /**
   * 清理过期的会话记忆（定期调用）
   */
  async cleanupExpired() {
    const r = await this.pool.query(
      `DELETE FROM session_memories WHERE expires_at < NOW() RETURNING id`
    )
    if (r.rowCount > 0) {
      console.log(`[Memory] 清理过期会话记忆: ${r.rowCount} 条`)
    }
  }
}

module.exports = { MemoryService }
