/**
 * services/scorer/src/evolution-engine.js
 *
 * 评分进化闭环（文档 §9.2）：
 *   1. 低分惩罚：失败策略在 Prompt 中降权
 *   2. 样本学习：高分样本用于微调检索和 Prompt
 *   3. Prompt 进化：根据人工负面反馈自动优化约束条件
 */

'use strict'

const { Pool } = require('pg')
const fs       = require('fs')
const path     = require('path')

const pool = new Pool({ connectionString: process.env.POSTGRES_URL })

// Prompt 约束条件存储路径（动态约束，会被进化系统修改）
const DYNAMIC_CONSTRAINTS_PATH = path.resolve(
  __dirname, '../../../shared/prompts/dynamic-constraints.json'
)

// ── 读写动态约束 ──────────────────────────────────────────────
function loadConstraints() {
  if (!fs.existsSync(DYNAMIC_CONSTRAINTS_PATH)) {
    return { penalized: {}, enforced: [], version: 0 }
  }
  try {
    return JSON.parse(fs.readFileSync(DYNAMIC_CONSTRAINTS_PATH, 'utf8'))
  } catch {
    return { penalized: {}, enforced: [], version: 0 }
  }
}

function saveConstraints(constraints) {
  fs.mkdirSync(path.dirname(DYNAMIC_CONSTRAINTS_PATH), { recursive: true })
  fs.writeFileSync(DYNAMIC_CONSTRAINTS_PATH, JSON.stringify(constraints, null, 2))
}

// ── 进化引擎主类 ──────────────────────────────────────────────
class EvolutionEngine {

  // ── 低分惩罚 ────────────────────────────────────────────────
  // 对于导致测试失败的生成策略，降低其在 Prompt 中的权重
  async applyLowScorePenalty(taskId, score, errorPatterns = []) {
    if (score >= 60) return  // 只惩罚明显低分

    const constraints = loadConstraints()

    for (const pattern of errorPatterns) {
      const key = normalizePattern(pattern)
      constraints.penalized[key] = (constraints.penalized[key] || 0) + 1

      console.log(`[Evolution] 低分惩罚: "${key}" 出现 ${constraints.penalized[key]} 次`)

      // 出现 3 次以上 → 加入强制约束
      if (constraints.penalized[key] >= 3) {
        const constraint = errorPatternToConstraint(pattern)
        if (constraint && !constraints.enforced.includes(constraint)) {
          constraints.enforced.push(constraint)
          console.log(`[Evolution] 新增强制约束: ${constraint}`)
        }
      }
    }

    constraints.version++
    saveConstraints(constraints)

    // 记录到 DB
    await pool.query(
      `UPDATE generation_tasks
       SET error_log = COALESCE(error_log, '') || $1
       WHERE id = $2`,
      [`\n[Evolution] 低分惩罚已记录 score=${score}`, taskId]
    )
  }

  // ── 高分样本学习 ─────────────────────────────────────────────
  // 收集高分 + 被接受的样本，提升未来检索精准度
  async learnFromHighScore(taskId, projectId, score) {
    if (score < 80) return

    // 标记为高质量样本（供未来 Rerank 微调）
    await pool.query(
      `INSERT INTO score_records (task_id, total_score)
       VALUES ($1, $2)
       ON CONFLICT (task_id) DO UPDATE
         SET total_score = GREATEST(score_records.total_score, EXCLUDED.total_score)`,
      [taskId, score]
    ).catch(() => {/* 已存在则忽略 */})

    console.log(`[Evolution] 高分样本记录 task=${taskId} score=${score}`)
  }

  // ── Prompt 进化 ──────────────────────────────────────────────
  // 根据人工负面反馈，自动优化 System Prompt 约束条件
  async evolveFromFeedback(taskId, feedback, score) {
    if (score > 40 && !feedback) return  // 无需进化

    const constraints = loadConstraints()
    const patterns    = extractIssuePatterns(feedback || '')

    for (const pattern of patterns) {
      const constraint = feedbackToConstraint(pattern)
      if (constraint && !constraints.enforced.includes(constraint)) {
        constraints.enforced.push(constraint)
        console.log(`[Evolution] 从反馈新增约束: ${constraint}`)
      }
    }

    // 限制约束数量，避免 Prompt 过长（最多 20 条）
    if (constraints.enforced.length > 20) {
      // 保留最新的 20 条
      constraints.enforced = constraints.enforced.slice(-20)
    }

    constraints.version++
    saveConstraints(constraints)
  }

  // ── 获取当前动态约束（供 go-generator.ts 使用） ───────────
  getDynamicConstraints() {
    return loadConstraints()
  }

  // ── 统计报告 ─────────────────────────────────────────────────
  async getEvolutionStats(projectId) {
    const r = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE sr.total_score >= 80) AS high_score_count,
         COUNT(*) FILTER (WHERE sr.total_score < 40)  AS low_score_count,
         AVG(sr.total_score)                          AS avg_score,
         COUNT(*)                                      AS total
       FROM score_records sr
       JOIN generation_tasks gt ON sr.task_id = gt.id
       JOIN feature_specs fs    ON gt.spec_id = fs.id
       WHERE fs.project_id = $1`,
      [projectId]
    )
    const constraints = loadConstraints()
    return {
      ...r.rows[0],
      constraintVersion:   constraints.version,
      enforcedConstraints: constraints.enforced.length,
    }
  }
}

// ── 辅助函数 ──────────────────────────────────────────────────

function normalizePattern(pattern) {
  return pattern.toLowerCase().replace(/[^a-z0-9_\s]/g, '').trim().slice(0, 80)
}

function errorPatternToConstraint(pattern) {
  const p = pattern.toLowerCase()
  if (p.includes('error') && p.includes('ignor'))
    return '所有 error 返回值必须显式处理，禁止使用 _ 忽略'
  if (p.includes('magic') || p.includes('hardcode'))
    return '禁止 Magic Number，所有业务数值使用具名常量或从配置表读取'
  if (p.includes('test') && p.includes('miss'))
    return '每个验收标准必须有对应的测试用例'
  if (p.includes('package') && p.includes('miss'))
    return 'Go 文件必须有 package 声明'
  if (p.includes('any') && p.includes('type'))
    return 'TypeScript 禁止使用 any 类型，必须定义明确的类型'
  return null
}

function extractIssuePatterns(feedback) {
  const patterns = []
  if (feedback.includes('错误处理'))   patterns.push('error handling missing')
  if (feedback.includes('测试不足'))   patterns.push('test coverage insufficient')
  if (feedback.includes('逻辑错误'))   patterns.push('logic error in implementation')
  if (feedback.includes('类型'))       patterns.push('type definition incomplete')
  if (feedback.includes('性能'))       patterns.push('performance issue detected')
  if (feedback.includes('并发'))       patterns.push('concurrency safety missing')
  if (feedback.includes('注释'))       patterns.push('documentation missing')
  return patterns
}

function feedbackToConstraint(pattern) {
  const map = {
    'error handling missing':        '所有函数必须有完整的错误处理，特别是数据库和 API 调用',
    'test coverage insufficient':    '测试覆盖率必须 ≥ 80%，每个 public 函数至少一个测试',
    'logic error in implementation': '实现前必须仔细检查业务规则，逐条对照 Spec 验收标准',
    'type definition incomplete':    'TypeScript 所有接口和类型必须完整定义，包括可选字段',
    'concurrency safety missing':    '涉及共享状态的操作必须使用 mutex 或 atomic 保证并发安全',
    'documentation missing':         '所有 public 函数/方法必须有注释说明其用途和参数',
  }
  return map[pattern] || null
}

module.exports = { EvolutionEngine }
