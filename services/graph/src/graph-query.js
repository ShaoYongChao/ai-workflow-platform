/**
 * services/graph/src/graph-query.js
 *
 * 图谱查询服务 - 给 code-generator retrieval.ts 提供：
 *   1. 根据实体名查真实调用链
 *   2. 根据接口名查实现者
 *   3. 查某函数被哪些函数调用（反向依赖）
 */

'use strict'

const http = require('http')

class GraphQueryService {
  constructor({ host = 'localhost', port = 7474, user = 'neo4j', password = 'awp_neo4j_2024' } = {}) {
    this.host     = host
    this.port     = port
    this.authB64  = Buffer.from(`${user}:${password}`).toString('base64')
    this.available = null  // null = 未检查，true/false = 检查结果
  }

  // ── 可用性检查（带缓存，不重复探测） ─────────────────────
  async isAvailable() {
    if (this.available !== null) return this.available
    try {
      await this._query('RETURN 1', {}, 2000)
      this.available = true
    } catch {
      this.available = false
    }
    return this.available
  }

  // ── 根据 spec 实体/API 名查调用链 ────────────────────────
  // 返回：["Handler.Claim → Service.Claim → Repository.Save", ...]
  async getCallChains(symbols) {
    if (!(await this.isAvailable())) return []

    const chains = []
    for (const sym of symbols.slice(0, 5)) {  // 最多查5个
      try {
        const result = await this._query(
          `MATCH path = (a:Function)-[:CALLS*1..3]->(b:Function)
           WHERE a.name CONTAINS $sym OR b.name CONTAINS $sym
           RETURN [n IN nodes(path) | n.signature] AS chain
           LIMIT 5`,
          { sym }
        )
        for (const row of result) {
          const chain = row.chain.filter(Boolean).join(' → ')
          if (chain) chains.push(chain)
        }
      } catch { /* 忽略单个查询失败 */ }
    }
    return [...new Set(chains)].slice(0, 8)
  }

  // ── 根据接口名查实现者 ────────────────────────────────────
  async getImplementors(interfaceName) {
    if (!(await this.isAvailable())) return []

    try {
      const result = await this._query(
        `MATCH (s:Struct)-[:IMPLEMENTS]->(i:Interface)
         WHERE i.name = $name
         RETURN s.name AS struct, i.name AS iface, s.file AS file`,
        { name: interfaceName }
      )
      return result.map(r => `${r.struct} implements ${r.iface} (${r.file})`)
    } catch { return [] }
  }

  // ── 查函数签名（精确匹配） ────────────────────────────────
  async getFunctionSignature(funcName) {
    if (!(await this.isAvailable())) return null

    try {
      const result = await this._query(
        `MATCH (f:Function) WHERE f.name = $name OR f.name ENDS WITH $name
         RETURN f.signature AS sig, f.file AS file LIMIT 3`,
        { name: funcName }
      )
      return result.map(r => `// [${r.file}]\n${r.sig}`)
    } catch { return [] }
  }

  // ── 图谱增强检索上下文（供 retrieval.ts 调用） ───────────
  async enrichContext(spec) {
    const symbols = [
      ...spec.entities,
      ...spec.api_contract.map(a => a.name),
    ]

    const [callChains, implementors] = await Promise.all([
      this.getCallChains(symbols),
      ...spec.entities.map(e => this.getImplementors(e + 'Repository'))
        .concat(spec.entities.map(e => this.getImplementors(e + 'Service')))
    ].flat().reduce((acc, p, i) => {
      if (i === 0) acc.push(p)  // callChains
      else acc[1] = (acc[1] || []).concat  // flatten implementors
      return acc
    }, []))

    return {
      callGraph: callChains.length > 0
        ? callChains
        : ['Handler → Service → Repository（严格分层，禁止跨层调用）'],
      implementors: implementors || []
    }
  }

  // ── 内部：执行 Cypher 查询 ────────────────────────────────
  _query(cypher, params = {}, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Neo4j 查询超时')), timeoutMs)

      const body = JSON.stringify({
        statements: [{ statement: cypher, parameters: params }]
      })

      const req = http.request({
        hostname: this.host,
        port: this.port,
        path: '/db/neo4j/tx/commit',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${this.authB64}`,
          'Content-Length': Buffer.byteLength(body)
        }
      }, res => {
        let raw = ''
        res.on('data', d => raw += d)
        res.on('end', () => {
          clearTimeout(timer)
          try {
            const data = JSON.parse(raw)
            if (data.errors?.length > 0) {
              reject(new Error(data.errors[0].message))
              return
            }
            // 展平 Neo4j 响应格式
            const cols   = data.results?.[0]?.columns || []
            const rows   = data.results?.[0]?.data || []
            const result = rows.map(r => {
              const obj = {}
              cols.forEach((c, i) => { obj[c] = r.row[i] })
              return obj
            })
            resolve(result)
          } catch (e) { reject(e) }
        })
      })

      req.on('error', (e) => { clearTimeout(timer); reject(e) })
      req.write(body)
      req.end()
    })
  }
}

// 单例
const graphService = new GraphQueryService({
  host:     process.env.NEO4J_HOST     || 'localhost',
  port:     parseInt(process.env.NEO4J_HTTP_PORT || '7474'),
  user:     process.env.NEO4J_USER     || 'neo4j',
  password: process.env.NEO4J_PASSWORD || 'awp_neo4j_2024',
})

module.exports = { GraphQueryService, graphService }
