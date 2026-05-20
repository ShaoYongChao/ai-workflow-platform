/**
 * services/memory/src/scheduler.js
 *
 * 每日凌晨定时任务：
 *   00:00 - 清理过期会话记忆
 *   00:05 - 对每个活跃项目运行 Consolidation
 */

'use strict'

const { MemoryService } = require('./memory-service')
const { Pool }          = require('pg')

const pool = new Pool({ connectionString: process.env.POSTGRES_URL })
const mem  = new MemoryService({
  postgresUrl: process.env.POSTGRES_URL,
  redisUrl:    process.env.REDIS_URL,
})

async function getActiveProjects() {
  const r = await pool.query(
    `SELECT DISTINCT project_id FROM feature_specs
     WHERE created_at > NOW() - INTERVAL '30 days'
       AND project_id IS NOT NULL`
  )
  return r.rows.map(r => r.project_id)
}

async function runDailyJobs() {
  console.log(`[Scheduler] 开始每日记忆维护 ${new Date().toISOString()}`)

  // 1. 清理过期记忆
  await mem.cleanupExpired()

  // 2. 对每个活跃项目运行巩固
  const projects = await getActiveProjects()
  console.log(`[Scheduler] 活跃项目: ${projects.length} 个`)

  for (const projectId of projects) {
    try {
      await mem.runConsolidation(projectId)
    } catch (err) {
      console.error(`[Scheduler] 项目 ${projectId} 巩固失败: ${err.message}`)
    }
  }

  console.log(`[Scheduler] 每日维护完成`)
}

// ── 启动调度 ──────────────────────────────────────────────────
function msUntilMidnight() {
  const now  = new Date()
  const next = new Date(now)
  next.setHours(0, 0, 0, 0)
  next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

// 启动时延迟 30s 先跑一次（处理遗留过期数据，无需等到凌晨）
setTimeout(() => {
  console.log('[Scheduler] 启动巩固（容器初始化后 30s 触发）')
  runDailyJobs().catch(err => console.error('[Scheduler] 启动巩固失败:', err.message))
}, 30 * 1000)

// 之后每日凌晨 00:00 再跑
const firstDelay = msUntilMidnight()
console.log(`[Scheduler] 记忆调度器启动，每日定时运行在 ${Math.round(firstDelay / 60000)} 分钟后`)

setTimeout(() => {
  runDailyJobs()
  // 之后每 24h 运行一次
  setInterval(runDailyJobs, 24 * 60 * 60 * 1000)
}, firstDelay)

// 同时暴露手动触发接口（开发调试用）
module.exports = { runDailyJobs, getActiveProjects }
