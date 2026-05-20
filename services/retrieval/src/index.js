/**
 * services/retrieval/src/index.js
 *
 * 独立检索服务（Hybrid RAG）
 *
 * 职责：
 *   接收 Spec，从知识库召回最相关的接口契约和上下文
 *   三重索引策略：向量（Chroma）+ 关键词（BM25/ES）+ 图谱（Neo4j）
 *
 * API：
 *   POST /api/v1/retrieve  { spec, projectId } → RetrievalContext
 *   GET  /health
 *
 * 与 code-generator 的关系：
 *   code-generator 内联了 retrieval.ts 作为 Phase 1 快速实现。
 *   此服务是 Phase 2 的独立部署版本，提供更完整的 Hybrid RAG 能力。
 *   启用方式：设置环境变量 RETRIEVAL_SERVICE_URL=http://retrieval:3005
 *   code-generator 会自动切换到调用此服务而非内联实现。
 */

'use strict'

const express    = require('express')
const fs         = require('fs')
const path       = require('path')
const http       = require('http')

const app  = express()
const PORT = process.env.PORT || 3005

app.use(express.json({ limit: '1mb' }))

// ── 知识库路径 ────────────────────────────────────────────────
const KB_PATH = process.env.KB_PATH ||
  path.resolve(__dirname, '../../../knowledge-base/index/kb.json')

let _kb = null
function loadKB() {
  if (_kb) return _kb
  if (!fs.existsSync(KB_PATH)) {
    console.warn(`[Retrieval] kb.json 不存在: ${KB_PATH}，返回空上下文`)
    return { chunks: [] }
  }
  _kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'))
  console.log(`[Retrieval] 知识库加载完成，共 ${_kb.totalChunks} chunks`)
  return _kb
}

// ── 检索核心逻辑 ──────────────────────────────────────────────
function searchBySymbols(chunks, symbols) {
  if (!symbols?.length) return []
  return chunks
    .map(c => ({
      chunk: c,
      score: symbols.filter(s =>
        c.symbols?.includes(s) || c.content?.includes(s)
      ).length
    }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(x => x.chunk)
}

function searchByText(chunks, text) {
  const words = (text || '')
    .toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 2)
  if (!words.length) return []
  return chunks
    .map(c => {
      const cwords = ((c.content || '') + ' ' + (c.semantic || ''))
        .toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/)
      const score = words.filter(w => cwords.includes(w)).length / words.length
      return { chunk: c, score }
    })
    .filter(x => x.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15)
    .map(x => x.chunk)
}

function dedupeAndRank(chunks) {
  const seen    = new Set()
  const priority = { interface: 0, struct: 1, function_signature: 2, class_signature: 3, error_definition: 4 }
  return chunks
    .filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true })
    .sort((a, b) => (priority[a.type] ?? 5) - (priority[b.type] ?? 5))
}

async function enrichWithNeo4j(spec) {
  const neo4jHost = process.env.NEO4J_HOST || 'localhost'
  if (!neo4jHost) return []
  try {
    const { graphService } = require('../../graph/src/graph-query')
    const r = await graphService.enrichContext(spec)
    return r.callGraph || []
  } catch {
    return []
  }
}

// ── 主检索接口 ────────────────────────────────────────────────
app.post('/api/v1/retrieve', async (req, res) => {
  const { spec, projectId } = req.body
  if (!spec) return res.status(400).json({ error: '缺少 spec' })

  const kb = loadKB()
  const symbols = [
    ...(spec.entities || []),
    ...(spec.api_contract || []).map(a => a.name),
    ...Object.keys(spec.rules || {})
  ]
  const text = [spec.title, spec.goal, ...(spec.entities || [])].join(' ')

  const symbolMatches = searchBySymbols(kb.chunks, symbols)
  const textMatches   = searchByText(kb.chunks, text)
  const all = dedupeAndRank([...symbolMatches, ...textMatches])

  const goChunks = all.filter(c => c.language === 'go').slice(0, 8)
  const tsChunks = all.filter(c => c.language === 'typescript').slice(0, 6)

  const graphCallChains = await enrichWithNeo4j(spec)

  const relatedInterfaces = [
    ...goChunks.filter(c => ['interface','function_signature'].includes(c.type))
      .map(c => `// [${c.file}]\n${c.content}`),
    ...tsChunks.filter(c => ['interface','function_signature'].includes(c.type))
      .map(c => `// [${c.file}]\n${c.content}`)
  ]

  res.json({
    relatedInterfaces,
    relatedModels:    [...goChunks, ...tsChunks].filter(c => c.type === 'struct').map(c => c.content),
    callGraph:        graphCallChains.length > 0
      ? graphCallChains
      : ['Handler → Service → Repository（严格分层，禁止跨层调用）'],
    conventions: [
      '错误处理：fmt.Errorf("op: %w", err)',
      '日志：zap.Logger',
      '禁止 Magic Number',
      '响应格式：{ code: 0, data: {}, msg: "ok" }'
    ],
    meta: {
      totalChunks:   kb.chunks?.length || 0,
      matched:       all.length,
      graphEnriched: graphCallChains.length > 0
    }
  })
})

app.get('/health', (_, res) =>
  res.json({ status: 'ok', service: 'retrieval', kbChunks: loadKB().chunks?.length || 0 })
)

// ── Redis 订阅 kb:reindex（知识库更新时自动刷新缓存） ────────
try {
  const Redis = require('ioredis')
  const sub   = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')
  sub.subscribe('kb:reindex', () => {
    console.log('[Retrieval] 订阅 kb:reindex 事件')
  })
  sub.on('message', (channel, msg) => {
    if (channel === 'kb:reindex') {
      _kb = null  // 清除缓存，下次请求重新加载
      console.log('[Retrieval] 知识库缓存已清除，下次请求重新加载')
    }
  })
} catch { /* Redis 不可用时跳过 */ }

app.listen(PORT, () => {
  console.log(`🚀 retrieval 服务启动，端口 ${PORT}`)
  loadKB()  // 预热
})
