#!/usr/bin/env node
/**
 * services/graph/src/build-graph.js
 *
 * 从 knowledge-base/seed-code 解析代码调用关系，写入 Neo4j
 *
 * 图模型：
 *   (:Function   { id, name, file, package, signature })
 *   (:Interface  { id, name, file, package })
 *   (:Struct     { id, name, file, package })
 *   (:Error      { id, name, file, package })
 *
 * 关系：
 *   (:Function)-[:CALLS]->(:Function)
 *   (:Function)-[:IMPLEMENTS]->(:Interface)
 *   (:Function)-[:RETURNS]->(:Struct|:Error)
 *   (:Struct)-[:IMPLEMENTS]->(:Interface)
 *
 * 用途：当 AI 生成代码需要调用某个功能时，
 *       查图谱获取真实调用链，防止幻觉。
 *
 * 运行：
 *   NEO4J_URL=bolt://localhost:7687 node build-graph.js
 *   NEO4J_URL=bolt://localhost:7687 node build-graph.js --dry-run
 */

'use strict'

const fs   = require('fs')
const path = require('path')
const http = require('http')

const NEO4J_URL  = process.env.NEO4J_URL  || 'bolt://localhost:7687'
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j'
const NEO4J_PASS = process.env.NEO4J_PASSWORD || 'awp_neo4j_2024'
const HTTP_PORT  = 7474  // Neo4j HTTP API（Bolt 解析复杂，用 HTTP API 替代）
const NEO4J_HOST = NEO4J_URL.replace('bolt://', '').split(':')[0]
const DRY_RUN    = process.argv.includes('--dry-run')

const SEED_DIR = path.resolve(__dirname, '../../../knowledge-base/seed-code')
const KB_JSON  = path.resolve(__dirname, '../../../knowledge-base/index/kb.json')

// ── Neo4j HTTP API 工具 ───────────────────────────────────────
function neo4jQuery(cypher, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      statements: [{ statement: cypher, parameters: params }]
    })
    const auth = Buffer.from(`${NEO4J_USER}:${NEO4J_PASS}`).toString('base64')
    const req = http.request({
      hostname: NEO4J_HOST,
      port: HTTP_PORT,
      path: '/db/neo4j/tx/commit',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let raw = ''
      res.on('data', d => raw += d)
      res.on('end', () => {
        try {
          const data = JSON.parse(raw)
          if (data.errors?.length > 0) reject(new Error(data.errors[0].message))
          else resolve(data)
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function checkNeo4j() {
  try {
    await neo4jQuery('RETURN 1')
    return true
  } catch { return false }
}

// ── 解析 Go 文件的调用关系 ────────────────────────────────────
function parseGoCallGraph(source, filePath) {
  const pkg    = (source.match(/^package\s+(\w+)/m) || [])[1] || 'unknown'
  const nodes  = []
  const edges  = []

  // 提取 interface
  const ifaceRe = /type\s+(\w+)\s+interface\s*\{([^}]*)\}/g
  let m
  while ((m = ifaceRe.exec(source)) !== null) {
    const name    = m[1]
    const methods = [...m[2].matchAll(/^\s{1,2}(\w+)\s*\(/gm)].map(x => x[1])
    nodes.push({ label: 'Interface', props: { id: `${pkg}.${name}`, name, file: filePath, package: pkg, methods: methods.join(',') } })
  }

  // 提取 struct
  const structRe = /type\s+(\w+)\s+struct\s*\{/g
  while ((m = structRe.exec(source)) !== null) {
    const name = m[1]
    nodes.push({ label: 'Struct', props: { id: `${pkg}.${name}`, name, file: filePath, package: pkg } })
  }

  // 提取函数 + 方法，分析调用
  const funcRe = /(?:\/\/[^\n]*\n)*func\s+(?:\(\w+\s+\*?(\w+)\)\s+)?(\w+)\s*\(([^)]*)\)[^{]*\{([\s\S]*?)^}/gm
  while ((m = funcRe.exec(source)) !== null) {
    const receiver = m[1]  // 方法接收者类型（如 SignInService）
    const funcName = m[2]
    const body     = m[4] || ''
    const fullName = receiver ? `${receiver}.${funcName}` : funcName

    if (!fullName[0].match(/[A-Z]/)) continue // 跳过私有函数

    const nodeId  = `${pkg}.${fullName}`
    const sig     = m[0].split('{')[0].trim().replace(/\s+/g, ' ')
    nodes.push({ label: 'Function', props: { id: nodeId, name: fullName, file: filePath, package: pkg, signature: sig.slice(0, 200) } })

    // 分析函数体内的调用
    const callRe = /(?:(\w+)\.)?(\w+)\s*\(/g
    let c
    while ((c = callRe.exec(body)) !== null) {
      const callee = c[1] ? `${c[1]}.${c[2]}` : c[2]
      if (callee === fullName) continue // 跳过自递归
      if (['fmt', 'errors', 'json', 'http', 'time', 'context', 'strings'].includes(c[1])) continue // 跳过标准库
      if (c[2][0] === c[2][0].toUpperCase() && !c[1]) continue // 跳过类型构造
      if (c[2].length < 3) continue // 太短的跳过

      edges.push({
        from: nodeId,
        to: `${pkg}.${callee}`,
        type: 'CALLS'
      })
    }

    // 检测接口实现
    if (receiver) {
      const iface = nodes.find(n => n.label === 'Interface' &&
        n.props.methods?.includes(funcName))
      if (iface) {
        edges.push({ from: `${pkg}.${receiver}`, to: iface.props.id, type: 'IMPLEMENTS' })
      }
    }
  }

  return { nodes, edges }
}

// ── 写入 Neo4j ────────────────────────────────────────────────
async function upsertNode(node) {
  await neo4jQuery(
    `MERGE (n:${node.label} {id: $id})
     SET n += $props`,
    { id: node.props.id, props: node.props }
  )
}

async function upsertEdge(edge) {
  // 只在两端节点都存在时才建关系
  await neo4jQuery(
    `MATCH (a {id: $from}), (b {id: $to})
     MERGE (a)-[:${edge.type}]->(b)`,
    { from: edge.from, to: edge.to }
  )
}

// ── 主流程 ────────────────────────────────────────────────────
async function main() {
  console.log(`🔍 Neo4j 图谱构建 ${DRY_RUN ? '[DRY RUN]' : ''}\n`)

  // 读取所有 Go 文件
  const goFiles = []
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f)
      if (fs.statSync(full).isDirectory()) walk(full)
      else if (f.endsWith('.go') && !f.includes('_test')) goFiles.push(full)
    }
  }
  walk(SEED_DIR)
  console.log(`📄 找到 ${goFiles.length} 个 Go 文件`)

  // 解析所有文件
  let totalNodes = 0, totalEdges = 0
  const allNodes = [], allEdges = []

  for (const file of goFiles) {
    const source  = fs.readFileSync(file, 'utf8')
    const relPath = path.relative(SEED_DIR, file)
    const { nodes, edges } = parseGoCallGraph(source, relPath)
    allNodes.push(...nodes)
    allEdges.push(...edges)
    console.log(`  ✅ ${relPath}  →  ${nodes.length} 节点 / ${edges.length} 边`)
  }

  console.log(`\n📊 共解析: ${allNodes.length} 节点, ${allEdges.length} 边`)

  if (DRY_RUN) {
    console.log('\n[DRY RUN] 节点预览：')
    allNodes.slice(0, 10).forEach(n => console.log(`  ${n.label}: ${n.props.id}`))
    console.log('\n[DRY RUN] 边预览：')
    allEdges.slice(0, 10).forEach(e => console.log(`  ${e.from} -[${e.type}]-> ${e.to}`))
    return
  }

  // 检查 Neo4j 可用性
  console.log(`\n🔌 连接 Neo4j (${NEO4J_HOST}:${HTTP_PORT})...`)
  const alive = await checkNeo4j()
  if (!alive) {
    console.error('❌ Neo4j 不可达，请先运行: docker-compose up -d neo4j')
    process.exit(1)
  }
  console.log('  ✅ Neo4j 已连接')

  // 建索引（首次运行）
  await neo4jQuery('CREATE INDEX IF NOT EXISTS FOR (n:Function) ON (n.id)')
  await neo4jQuery('CREATE INDEX IF NOT EXISTS FOR (n:Interface) ON (n.id)')
  await neo4jQuery('CREATE INDEX IF NOT EXISTS FOR (n:Struct) ON (n.id)')

  // 写入节点
  console.log('\n📥 写入节点...')
  for (const node of allNodes) {
    await upsertNode(node)
    totalNodes++
  }

  // 写入边
  console.log('📥 写入关系边...')
  for (const edge of allEdges) {
    try { await upsertEdge(edge); totalEdges++ } catch { /* 节点不存在时跳过 */ }
  }

  console.log(`\n✅ 图谱构建完成`)
  console.log(`   节点: ${totalNodes}  |  边: ${totalEdges}`)
  console.log(`   Neo4j Browser: http://${NEO4J_HOST}:${HTTP_PORT}`)
  console.log('\n💡 在 Neo4j Browser 验证：')
  console.log('   MATCH (n) RETURN n LIMIT 25')
  console.log('   MATCH (a)-[r:CALLS]->(b) RETURN a,r,b LIMIT 20')
}

main().catch(err => { console.error('❌', err.message); process.exit(1) })
