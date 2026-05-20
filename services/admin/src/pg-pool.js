'use strict'
// PostgreSQL 连接池适配器 — 使用官方 pg 驱动
// API 与原有 pg-client.js 兼容，无需修改 server.js

const { Pool } = require('pg')

class PGPool {
  constructor(connectionString) {
    this.pool = new Pool({
      connectionString: connectionString || process.env.POSTGRES_URL || 'postgresql://awp:awp_secret_2024@localhost:5432/ai_workflow'
    })
    this.pool.on('error', (err) => {
      console.error('[PGPool Error]', err.message)
    })
  }

  // 兼容原 API：返回 { rows, rowCount, fields }
  async query(sql, params = []) {
    try {
      const result = await this.pool.query(sql, params)
      return {
        rows: result.rows,
        rowCount: result.rowCount,
        fields: result.fields ? result.fields.map(f => f.name) : []
      }
    } catch (err) {
      throw err
    }
  }

  async end() {
    await this.pool.end()
  }
}

module.exports = { PGPool }
