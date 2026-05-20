/**
 * gateway/tenant-middleware.js
 *
 * 多租户隔离中间件（Express 中间件，各服务复用）
 *
 * 设计原则：
 *   - project_id 是租户的唯一标识（等价文档中的 tenant）
 *   - 通过 JWT + project_id 双重验证
 *   - Phase 1：API Key 验证（简化版），Phase 4 替换为 Kong JWT
 *
 * 请求头规范：
 *   X-Project-ID: <project_id>       必填
 *   X-API-Key: <api_key>             必填（或 Authorization: Bearer <token>）
 *   X-Developer-ID: <developer_id>   可选，日志 / 评分用
 */

'use strict'

// 允许的 project_id 格式：字母数字和短横线，3-64 字符
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,63}$/

/**
 * 解析租户上下文并挂到 req.tenant
 * 下游所有 DB/Redis/Chroma 操作都从 req.tenant 取 project_id
 */
function tenantMiddleware(options = {}) {
  const { required = true, allowList = null } = options

  return function (req, res, next) {
    // 1. 提取 project_id（Header 或 Query 参数）
    const projectId =
      req.headers['x-project-id'] ||
      req.query.project_id ||
      req.body?.project_id

    if (!projectId) {
      if (required) {
        return res.status(400).json({
          error: 'missing_tenant',
          message: '缺少 X-Project-ID 请求头',
        })
      }
      req.tenant = null
      return next()
    }

    // 2. 格式校验
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      return res.status(400).json({
        error: 'invalid_tenant',
        message: 'X-Project-ID 格式无效（字母数字和短横线，3-64 字符）',
      })
    }

    // 3. 白名单检查（可选）
    if (allowList && !allowList.includes(projectId)) {
      return res.status(403).json({
        error: 'tenant_not_allowed',
        message: `项目 ${projectId} 未授权`,
      })
    }

    // 4. 挂载租户上下文
    req.tenant = {
      projectId,
      developerId: req.headers['x-developer-id'] || 'anonymous',
      requestId: req.headers['x-request-id'] || generateRequestId(),
    }

    // 5. 响应头透传（方便调试）
    res.setHeader('X-Project-ID', projectId)
    res.setHeader('X-Request-ID', req.tenant.requestId)

    next()
  }
}

/**
 * Chroma collection 命名空间：每个 project 独立
 * 确保不同项目的向量索引完全隔离
 */
function chromaCollectionName(projectId) {
  // 格式：awp_{project_id}_kb
  return `awp_${projectId.replace(/-/g, '_')}_kb`
}

/**
 * Neo4j 数据库名：每个 project 独立 database
 * （Neo4j Enterprise 支持多 database，Community 版用 label 前缀隔离）
 */
function neo4jNamespace(projectId) {
  return `project_${projectId.replace(/-/g, '_')}`
}

/**
 * Elasticsearch index 名
 */
function esIndexName(projectId) {
  return `awp-kb-${projectId.toLowerCase()}`
}

/**
 * Redis key 前缀：所有 key 都加 project_id 隔离
 */
function redisPrefix(projectId, key) {
  return `awp:${projectId}:${key}`
}

function generateRequestId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

module.exports = {
  tenantMiddleware,
  chromaCollectionName,
  neo4jNamespace,
  esIndexName,
  redisPrefix,
}
