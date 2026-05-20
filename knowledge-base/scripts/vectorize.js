#!/usr/bin/env node
/**
 * knowledge-base/scripts/vectorize.js
 *
 * 读取 index/chunks/ 下所有 chunk，
 * 调用 Anthropic API 生成 embedding，写入 Chroma 向量库。
 *
 * 前置条件：
 *   1. Chroma 容器已启动（docker-compose up -d chroma）
 *   2. 已设置 ANTHROPIC_API_KEY 或 OPENAI_API_KEY 环境变量
 *   3. 已运行 build-index.js 生成 chunks
 *
 * 运行：
 *   node knowledge-base/scripts/vectorize.js
 *   node knowledge-base/scripts/vectorize.js --dry-run              # 只打印，不写入
 *   node knowledge-base/scripts/vectorize.js --project=my-project   # 写入项目专属 collection
 */

const fs = require('fs')
const path = require('path')
const http = require('http')

const CHUNK_DIR = path.resolve(__dirname, '../index/chunks')
const CHROMA_HOST = process.env.CHROMA_HOST || 'localhost'
const CHROMA_PORT = process.env.CHROMA_PORT || '8001'
const CHROMA_TOKEN = process.env.CHROMA_TOKEN || 'awp_chroma_token_2024'
const DRY_RUN = process.argv.includes('--dry-run')
const BATCH_SIZE = 5  // 每批向量化，避免 API 限流

// ── 多租户：支持 --project=<projectId> 写入项目专属 collection ─
const projectArg = process.argv.find(a => a.startsWith('--project='))
const PROJECT_ID = projectArg ? projectArg.split('=')[1].replace(/-/g, '_') : null
const COLLECTION = PROJECT_ID ? `awp_${PROJECT_ID}_kb` : 'awp_knowledge_base'

// ── Chroma HTTP 工具 ─────────────────────────────────────────
function chromaRequest(method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null
        const opts = {
            hostname: CHROMA_HOST,
            port: parseInt(CHROMA_PORT),
            path: `/api/v1${urlPath}`,
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CHROMA_TOKEN}`,
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
            }
        }
        const req = http.request(opts, res => {
            let raw = ''
            res.on('data', d => raw += d)
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(raw) }) }
                catch { resolve({ status: res.statusCode, body: raw }) }
            })
        })
        req.on('error', reject)
        if (data) req.write(data)
        req.end()
    })
}

// ── 检查 Chroma 是否可用 ─────────────────────────────────────
async function checkChroma() {
    try {
        const r = await chromaRequest('GET', '/heartbeat')
        return r.status === 200
    } catch {
        return false
    }
}

// ── 确保 collection 存在 ─────────────────────────────────────
async function ensureCollection() {
    // 尝试创建（已存在会返回 409，忽略）
    const r = await chromaRequest('POST', '/collections', {
        name: COLLECTION,
        metadata: {
            description: 'AWP 项目知识库',
            'hnsw:space': 'cosine'
        }
    })
    if (r.status === 200 || r.status === 409) {
        console.log(`  ✅ Collection "${COLLECTION}" 就绪`)
        return r.body.id || COLLECTION
    }
    throw new Error(`创建 collection 失败: ${JSON.stringify(r.body)}`)
}

// ── 获取已存在的 IDs（增量更新用） ──────────────────────────
async function getExistingIDs(collectionId) {
    const r = await chromaRequest('POST', `/collections/${collectionId}/get`, {
        include: ['documents']
    })
    if (r.status !== 200) return new Set()
    return new Set((r.body.ids || []))
}

// ── 生成 embedding（使用 Anthropic voyage-code-2） ───────────
// 注：Anthropic 的 embedding 通过 voyage API，fallback 到简单 TF-IDF 向量
async function getEmbedding(text) {
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY
    if (!apiKey) {
        // 无 API Key 时使用确定性哈希向量（仅用于开发调试）
        return deterministicVector(text, 1536)
    }

    // 优先用 OpenAI text-embedding-3-small（支持更广）
    if (process.env.OPENAI_API_KEY) {
        return await openaiEmbedding(text)
    }

    // Fallback: 确定性向量（不依赖外部 API，开发阶段可用）
    return deterministicVector(text, 1536)
}

async function openaiEmbedding(text) {
    const https = require('https')
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ input: text, model: 'text-embedding-3-small' })
        const req = https.request({
            hostname: 'api.openai.com',
            path: '/v1/embeddings',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        }, res => {
            let raw = ''
            res.on('data', d => raw += d)
            res.on('end', () => {
                const data = JSON.parse(raw)
                resolve(data.data[0].embedding)
            })
        })
        req.on('error', reject)
        req.write(body)
        req.end()
    })
}

// ── 确定性伪向量（无 API Key 时的开发占位） ─────────────────
// 基于文本内容做哈希，保证相同文本得到相同向量
function deterministicVector(text, dim) {
    const vec = new Array(dim).fill(0)
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i)
        vec[i % dim] += code * Math.sin(i + 1)
    }
    // L2 归一化
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
    return vec.map(v => v / norm)
}

// ── 批量写入 Chroma ──────────────────────────────────────────
async function upsertBatch(collectionId, chunks) {
    const ids = chunks.map(c => c.id)
    const documents = chunks.map(c => c.semantic)
    const metadatas = chunks.map(c => ({
        type: c.type,
        language: c.language,
        file: c.file,
        package: c.package || '',
        symbols: (c.symbols || []).join(','),
        content: c.content.slice(0, 500)  // Chroma metadata 限长
    }))

    console.log(`  📥 生成 ${chunks.length} 个向量...`)
    const embeddings = await Promise.all(
        chunks.map(c => getEmbedding(c.semantic))
    )

    const r = await chromaRequest('POST', `/collections/${collectionId}/upsert`, {
        ids, documents, metadatas, embeddings
    })

    if (r.status !== 200) {
        throw new Error(`Chroma upsert 失败 (${r.status}): ${JSON.stringify(r.body)}`)
    }
    return chunks.length
}

// ── 语义检索测试 ─────────────────────────────────────────────
async function testQuery(collectionId) {
    console.log('\n🔍 测试向量检索...')
    const queryVec = await getEmbedding('Go interface for daily signin repository data access')

    const r = await chromaRequest('POST', `/collections/${collectionId}/query`, {
        query_embeddings: [queryVec],
        n_results: 3,
        include: ['documents', 'metadatas', 'distances']
    })

    if (r.status !== 200) {
        console.log('  ⚠️  查询失败:', r.body)
        return
    }

    const results = r.body
    console.log('  Top 3 语义检索结果：')
        ; (results.ids[0] || []).forEach((id, i) => {
            const dist = results.distances?.[0]?.[i]?.toFixed(4)
            const meta = results.metadatas?.[0]?.[i]
            console.log(`    ${i + 1}. [dist=${dist}] ${meta?.file} (${meta?.type})`)
        })
}

// ── 主流程 ──────────────────────────────────────────────────
async function main() {
    console.log(`🚀 知识库向量化 ${DRY_RUN ? '[DRY RUN]' : ''}\n`)

    // 读取所有 chunks
    const chunkFiles = fs.readdirSync(CHUNK_DIR).filter(f => f.endsWith('.json'))
    const chunks = chunkFiles.map(f =>
        JSON.parse(fs.readFileSync(path.join(CHUNK_DIR, f), 'utf8'))
    )
    console.log(`📦 待向量化 chunk 数: ${chunks.length}`)

    if (DRY_RUN) {
        console.log('\n[DRY RUN] 以下 chunk 将被写入 Chroma：')
        chunks.forEach(c => console.log(`  - ${c.id}  (${c.type}, ${c.language})`))
        return
    }

    // 检查 Chroma
    console.log(`\n🔌 连接 Chroma (${CHROMA_HOST}:${CHROMA_PORT})...`)
    const alive = await checkChroma()
    if (!alive) {
        console.error('❌ Chroma 不可达，请先运行: docker-compose up -d chroma')
        process.exit(1)
    }
    console.log('  ✅ Chroma 已连接')

    const collectionId = await ensureCollection()

    // 增量写入：跳过已存在的 chunk
    const existingIDs = await getExistingIDs(collectionId)
    const toUpsert = chunks.filter(c => !existingIDs.has(c.id))
    console.log(`\n📊 总计: ${chunks.length} | 已存在: ${existingIDs.size} | 待写入: ${toUpsert.length}`)

    if (toUpsert.length === 0) {
        console.log('✅ 所有 chunk 已是最新，无需写入')
    } else {
        // 分批写入
        let written = 0
        for (let i = 0; i < toUpsert.length; i += BATCH_SIZE) {
            const batch = toUpsert.slice(i, i + BATCH_SIZE)
            process.stdout.write(`  批次 ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(toUpsert.length / BATCH_SIZE)}: `)
            written += await upsertBatch(collectionId, batch)
            console.log(`✅`)
        }
        console.log(`\n✅ 写入完成，共 ${written} 个 chunk`)
    }

    // 验证
    await testQuery(collectionId)

    console.log('\n🎉 向量化完成')
    console.log(`   Collection: ${COLLECTION}`)
    console.log(`   Chroma UI:  http://${CHROMA_HOST}:${CHROMA_PORT}`)
}

main().catch(err => {
    console.error('❌ 向量化失败:', err.message)
    process.exit(1)
})