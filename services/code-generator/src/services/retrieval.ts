import * as fs from 'fs'
import * as path from 'path'
import { FeatureSpec, RetrievalContext } from '../schemas/types'
import { logger } from '../utils/logger'

// ── 知识库 chunk 类型 ────────────────────────────────────────
interface KBChunk {
  id: string
  type: 'interface' | 'struct' | 'function_signature' | 'class_signature' | 'error_definition'
  language: 'go' | 'typescript'
  file: string
  package?: string
  content: string
  symbols: string[]
  semantic: string
}

interface KnowledgeBase {
  version: string
  builtAt: string
  totalChunks: number
  chunks: KBChunk[]
}

// ── 单例：启动时加载一次，常驻内存 ─────────────────────────
let _kb: KnowledgeBase | null = null

function loadKB(): KnowledgeBase {
  if (_kb) return _kb

  // 路径：相对于服务根目录，往上找知识库
  const candidates = [
    path.resolve(__dirname, '../../../../knowledge-base/index/kb.json'),
    path.resolve(process.cwd(), 'knowledge-base/index/kb.json'),
    '/app/knowledge-base/index/kb.json', // Docker 容器内路径
  ]

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      logger.info({ path: p }, '加载知识库索引')
      _kb = JSON.parse(fs.readFileSync(p, 'utf8'))
      logger.info({ chunks: _kb!.totalChunks, builtAt: _kb!.builtAt }, '知识库加载完成')
      return _kb!
    }
  }

  // 找不到时降级为空库（不崩溃，只是召回为空）
  logger.warn('未找到 kb.json，知识库为空，代码生成将使用通用规范')
  _kb = { version: '0', builtAt: '', totalChunks: 0, chunks: [] }
  return _kb
}

// ── 主检索入口 ───────────────────────────────────────────────
export async function retrieveContext(spec: FeatureSpec, projectId?: string): Promise<RetrievalContext> {
  const kb = loadKB()

  if (kb.totalChunks === 0) {
    logger.warn('知识库为空，返回通用规范')
    return buildFallbackContext(spec)
  }

  // 构造检索查询词（实体名 + API 名 + 规则关键词）
  const querySymbols = buildQuerySymbols(spec)
  const queryText    = buildQueryText(spec)

  logger.info({ specTitle: spec.title, querySymbols }, '开始检索知识库')

  // 1. BM25 关键词匹配（精确匹配符号名）
  const symbolMatches = searchBySymbols(kb.chunks, querySymbols)

  // 2. 文本相似度匹配（关键词覆盖率）
  const textMatches   = searchByText(kb.chunks, queryText)

  // 3. 向量检索（需设置 ENABLE_VECTOR_SEARCH=true 且 Chroma 可用）
  const vectorMatches = await searchByVector(spec, projectId)

  // 4. 合并去重，按语言分类
  const allMatches  = dedupeAndRank([...symbolMatches, ...textMatches, ...vectorMatches])
  const goChunks    = allMatches.filter(c => c.language === 'go').slice(0, 8)
  const tsChunks    = allMatches.filter(c => c.language === 'typescript').slice(0, 6)

  // 5. Neo4j 图谱增强（获取真实调用链，防止 AI 幻觉）
  let graphCallChains: string[] = []
  try {
    const { graphService } = require('../../../graph/src/graph-query')
    const enriched = await graphService.enrichContext(spec)
    if (enriched.callGraph.length > 0) {
      graphCallChains = enriched.callGraph
      logger.info({ chains: graphCallChains.length }, 'Neo4j 图谱调用链已加载')
    }
  } catch {
    logger.debug('Neo4j 不可用，使用静态调用链规范')
  }

  logger.info({
    goChunks: goChunks.length,
    tsChunks: tsChunks.length,
    totalMatched: allMatches.length,
    graphEnriched: graphCallChains.length > 0
  }, '检索完成')

  // 6. 加载项目历史最佳实践（记忆系统）
  let projectMemories: string[] = []
  if (projectId) {
    try {
      const { MemoryService } = require('../../../../services/memory/src/memory-service')
      const mem = new MemoryService({
        postgresUrl: process.env.POSTGRES_URL,
        redisUrl:    process.env.REDIS_URL
      })
      const memories = await mem.retrieveProjectMemory(
        projectId,
        [...spec.entities, spec.title],
        ['best_practice', 'pattern', 'convention']
      )
      projectMemories = memories.map((m: any) => m.content)
      if (projectMemories.length > 0) {
        logger.info({ count: projectMemories.length }, '已注入项目历史记忆')
      }
    } catch {
      logger.debug('记忆系统不可用，跳过项目记忆注入')
    }
  }

  // 7. 构造 RetrievalContext（只返回接口契约，不暴露实现）
  return buildContext(spec, goChunks, tsChunks, graphCallChains, projectMemories)
}

// ── BM25 简化版：符号名精确匹配 ─────────────────────────────
function searchBySymbols(chunks: KBChunk[], querySymbols: string[]): KBChunk[] {
  if (querySymbols.length === 0) return []

  return chunks
    .map(chunk => {
      const hits = querySymbols.filter(sym =>
        chunk.symbols.some(s => s.toLowerCase() === sym.toLowerCase()) ||
        chunk.content.includes(sym)
      ).length
      return { chunk, score: hits }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ chunk }) => chunk)
}

// ── 文本相似度：关键词覆盖率 ────────────────────────────────
function searchByText(chunks: KBChunk[], queryText: string): KBChunk[] {
  const queryWords = tokenize(queryText)
  if (queryWords.length === 0) return []

  return chunks
    .map(chunk => {
      const chunkWords = tokenize(chunk.content + ' ' + chunk.semantic)
      const hits = queryWords.filter(w => chunkWords.includes(w)).length
      const score = hits / queryWords.length
      return { chunk, score }
    })
    .filter(({ score }) => score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15)
    .map(({ chunk }) => chunk)
}

// ── 去重 + 接口优先排序 ─────────────────────────────────────
function dedupeAndRank(chunks: KBChunk[]): KBChunk[] {
  const seen = new Set<string>()
  const unique = chunks.filter(c => {
    if (seen.has(c.id)) return false
    seen.add(c.id)
    return true
  })

  // 接口和 struct 优先（它们是最重要的契约）
  const priority: Record<string, number> = {
    interface: 0, struct: 1, function_signature: 2, class_signature: 3, error_definition: 4
  }
  return unique.sort((a, b) => (priority[a.type] ?? 5) - (priority[b.type] ?? 5))
}

// ── 构建 RetrievalContext ────────────────────────────────────
function buildContext(
  spec: FeatureSpec,
  goChunks: KBChunk[],
  tsChunks: KBChunk[],
  graphCallChains: string[] = [],
  projectMemories: string[] = []
): RetrievalContext {
  // 接口定义（供代码生成参考）
  const relatedInterfaces = [
    ...goChunks
      .filter(c => c.type === 'interface' || c.type === 'function_signature')
      .map(c => `// [${c.file}]\n${c.content}`),
    ...tsChunks
      .filter(c => c.type === 'interface' || c.type === 'function_signature')
      .map(c => `// [${c.file}]\n${c.content}`)
  ]

  // 数据模型
  const relatedModels = [
    ...goChunks.filter(c => c.type === 'struct').map(c => c.content),
    ...tsChunks.filter(c => c.type === 'interface').map(c => c.content)
  ]

  // 调用链（图谱优先，降级为静态规范）
  const callGraph = graphCallChains.length > 0
    ? graphCallChains
    : buildCallGraphHints(goChunks)

  // 代码规范（固定 + 从 chunk 中提取）
  const conventions = buildConventions(goChunks, tsChunks)

  // 记录实际使用的 chunks（供追溯）
  const usedChunks = [
    ...goChunks.map(c => ({ id: c.id, type: c.type, language: c.language, file: c.file, symbols: c.symbols })),
    ...tsChunks.map(c => ({ id: c.id, type: c.type, language: c.language, file: c.file, symbols: c.symbols }))
  ]

  return { relatedInterfaces, relatedModels, callGraph, conventions, usedChunks, projectMemories }
}

function buildCallGraphHints(goChunks: KBChunk[]): string[] {
  const hints = ['Handler → Service → Repository（严格分层，禁止跨层调用）']

  // 如果找到了 Repository 接口，提示 AI 必须通过它访问数据
  if (goChunks.some(c => c.content.includes('Repository'))) {
    hints.push('数据访问必须通过 Repository interface，禁止直接操作数据库')
  }
  // 如果找到了 Service 接口，提示依赖注入
  if (goChunks.some(c => c.content.includes('Servicer'))) {
    hints.push('跨模块调用通过 interface 注入，不直接引用具体实现')
  }

  return hints
}

function buildConventions(goChunks: KBChunk[], tsChunks: KBChunk[]): string[] {
  const base = [
    '错误处理：使用 fmt.Errorf("operation: %w", err) 包装错误链',
    '日志：使用 zap.Logger，禁止 fmt.Println',
    'Context：所有 DB 操作第一个参数必须是 context.Context',
    '测试：使用 testify/assert + testify/mock',
    '响应格式：{ "code": 0, "data": {}, "msg": "ok" }',
  ]

  // 从错误定义中提取约定
  const errChunks = goChunks.filter(c => c.type === 'error_definition')
  if (errChunks.length > 0) {
    base.push('自定义错误：使用具名错误变量（var ErrXxx = ...），并提供 IsXxx 判断函数')
  }

  return base
}

// ── 查询构造 ─────────────────────────────────────────────────
function buildQuerySymbols(spec: FeatureSpec): string[] {
  return [
    ...spec.entities,
    ...spec.api_contract.map((a: { name: string; type: string }) => a.name),
    ...Object.keys(spec.rules)
  ]
}

function buildQueryText(spec: FeatureSpec): string {
  return [
    spec.title,
    spec.goal,
    ...spec.entities,
    ...Object.values(spec.rules)
  ].join(' ')
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
}

// ── Chroma 向量检索（⑥⑦ 多租户隔离 + 语义检索） ───────────
// 由 ENABLE_VECTOR_SEARCH=true 环境变量启用，未设置时直接返回空数组。
// 按 projectId 隔离 collection（awp_{projectId}_kb），回落到默认集合。
async function searchByVector(spec: FeatureSpec, projectId?: string): Promise<KBChunk[]> {
  if (!process.env.ENABLE_VECTOR_SEARCH) return []

  const host  = process.env.CHROMA_HOST  || 'localhost'
  const port  = process.env.CHROMA_PORT  || '8001'
  const token = process.env.CHROMA_TOKEN || 'awp_chroma_token_2024'

  // 按项目隔离 collection 名，回落到共享默认集合
  const collection = projectId
    ? `awp_${projectId.replace(/-/g, '_')}_kb`
    : 'awp_knowledge_base'

  try {
    // 1. 获取 collection ID（名称 → ID）
    const colRes = await chromaHttp('GET', host, port, token, `/collections/${collection}`)
    if (colRes.status !== 200 || !colRes.body?.id) return []
    const collId = colRes.body.id

    // 2. 生成查询向量
    const queryText = [spec.title, spec.goal, ...spec.entities].join(' ')
    const queryVec  = await buildQueryVector(queryText)

    // 3. 向量检索
    const qRes = await chromaHttp('POST', host, port, token, `/collections/${collId}/query`, {
      query_embeddings: [queryVec],
      n_results: 10,
      include: ['documents', 'metadatas', 'distances'],
    })
    if (qRes.status !== 200) return []

    // 4. 转换为 KBChunk 格式
    const ids       = (qRes.body?.ids?.[0]       || []) as string[]
    const metas     = (qRes.body?.metadatas?.[0] || []) as Record<string, string>[]
    const docs      = (qRes.body?.documents?.[0] || []) as string[]

    return ids.map((id, i) => ({
      id,
      type: (metas[i]?.type as KBChunk['type']) || 'function_signature',
      language: (metas[i]?.language as KBChunk['language']) || 'go',
      file: metas[i]?.file || '',
      package: metas[i]?.package || undefined,
      content: metas[i]?.content || docs[i] || '',
      symbols: (metas[i]?.symbols || '').split(',').filter(Boolean),
      semantic: docs[i] || '',
    }))
  } catch {
    return []  // Chroma 不可用时静默降级
  }
}

// Chroma HTTP 请求工具（避免引入 axios 依赖）
function chromaHttp(
  method: string, host: string, port: string, token: string,
  urlPath: string, body?: unknown
): Promise<{ status: number; body: any }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const http = require('http')
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const req  = http.request(
      {
        hostname: host,
        port: parseInt(port),
        path: `/api/v1${urlPath}`,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res: any) => {
        let raw = ''
        res.on('data', (d: Buffer) => { raw += d })
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }) }
          catch { resolve({ status: res.statusCode, body: raw }) }
        })
      }
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

// 查询向量生成：优先使用 OpenAI Embeddings API，降级为确定性哈希向量
async function buildQueryVector(text: string): Promise<number[]> {
  if (process.env.OPENAI_API_KEY) {
    try { return await openaiEmbedding(text) } catch { /* fallthrough */ }
  }
  return deterministicVector(text, 1536)
}

function openaiEmbedding(text: string): Promise<number[]> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const https = require('https')
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ input: text, model: 'text-embedding-3-small' })
    const req  = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/embeddings',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res: any) => {
        let raw = ''
        res.on('data', (d: Buffer) => { raw += d })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw)
            resolve(parsed.data[0].embedding)
          } catch (e) { reject(e) }
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// 无 API Key 时的确定性占位向量（相同文本得到相同向量，用于开发测试）
function deterministicVector(text: string, dim: number): number[] {
  const vec = new Array(dim).fill(0) as number[]
  for (let i = 0; i < text.length; i++) {
    vec[i % dim] += text.charCodeAt(i) * Math.sin(i + 1)
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
  return vec.map(v => v / norm)
}

// ── 降级：知识库为空时的通用规范 ────────────────────────────
function buildFallbackContext(spec: FeatureSpec): RetrievalContext {
  return {
    relatedInterfaces: [
      'PlayerRepository.GetByID(ctx context.Context, playerID string) (*Player, error)',
      'RewardService.Grant(ctx context.Context, playerID string, reward Reward) error',
    ],
    relatedModels: spec.entities.map((e: string) =>
      `type ${e} struct { ID string \`json:"id"\`; CreatedAt time.Time \`json:"created_at"\` }`
    ),
    callGraph: ['Handler → Service → Repository（严格分层）'],
    conventions: [
      '遵循 Clean Code 原则，函数不超过 50 行',
      '所有错误必须显式处理',
      '禁止使用 Magic Number',
    ],
    usedChunks: [],
    projectMemories: []
  }
}
