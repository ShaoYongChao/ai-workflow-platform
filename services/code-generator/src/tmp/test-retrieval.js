/**
 * 用真实 spec 测试检索结果
 * 模拟 code-engine 调用 retrieval 的过程
 */

const fs = require('fs')
const path = require('path')

// ── 加载知识库 ───────────────────────────────────────────────
const kbPath = '/Users/ShaoYongChao/Desktop/ai-workflow-platform/knowledge-base/index/kb.json'
const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'))

// ── 模拟检索逻辑 ─────────────────────────────────────────────
function tokenize(text) {
    return text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 2)
}

function searchBySymbols(chunks, querySymbols) {
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

function searchByText(chunks, queryText) {
    const queryWords = tokenize(queryText)
    return chunks
        .map(chunk => {
            const chunkWords = tokenize(chunk.content + ' ' + chunk.semantic)
            const hits = queryWords.filter(w => chunkWords.includes(w)).length
            return { chunk, score: hits / queryWords.length }
        })
        .filter(({ score }) => score > 0.05)
        .sort((a, b) => b.score - a.score)
        .slice(0, 15)
        .map(({ chunk }) => chunk)
}

function dedupeAndRank(chunks) {
    const seen = new Set()
    const priority = { interface: 0, struct: 1, function_signature: 2, class_signature: 3, error_definition: 4 }
    return chunks
        .filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true })
        .sort((a, b) => (priority[a.type] ?? 5) - (priority[b.type] ?? 5))
}

// ── 测试用 Spec（每日签到） ──────────────────────────────────
const spec = {
    title: "每日签到领奖功能",
    goal: "玩家每日登录可领取奖励，连续签到获得额外奖励",
    platform: ["client", "server"],
    rules: {
        daily_reward: "每日只能领取一次",
        continuous_bonus: "连续签到7天可领取稀有道具箱",
        reset: "断签重置计数，不可补签"
    },
    entities: ["Player", "SignIn", "Reward"],
    api_contract: [
        { name: "getStatus", type: "GET" },
        { name: "claim", type: "POST" }
    ],
    acceptance: ["每日只能领取一次", "连续签到正确触发额外奖励"],
    priority: "high"
}

const querySymbols = [...spec.entities, ...spec.api_contract.map(a => a.name), ...Object.keys(spec.rules)]
const queryText = [spec.title, spec.goal, ...spec.entities, ...Object.values(spec.rules)].join(' ')

const symbolMatches = searchBySymbols(kb.chunks, querySymbols)
const textMatches = searchByText(kb.chunks, queryText)
const allMatches = dedupeAndRank([...symbolMatches, ...textMatches])
const goChunks = allMatches.filter(c => c.language === 'go').slice(0, 8)
const tsChunks = allMatches.filter(c => c.language === 'typescript').slice(0, 6)

// ── 输出结果 ─────────────────────────────────────────────────
console.log('=== 检索结果统计 ===')
console.log(`  总匹配: ${allMatches.length} | Go: ${goChunks.length} | TS: ${tsChunks.length}`)

console.log('\n=== 命中的 Go chunk（类型 + 文件）===')
goChunks.forEach(c => console.log(`  [${c.type.padEnd(20)}] ${c.file}`))

console.log('\n=== 命中的 TS chunk ===')
tsChunks.forEach(c => console.log(`  [${c.type.padEnd(20)}] ${c.file}`))

console.log('\n=== 送给 LLM 的 relatedInterfaces 片段（前2条）===')
const goInterfaces = goChunks
    .filter(c => c.type === 'interface' || c.type === 'function_signature')
    .slice(0, 2)
    .map(c => `// [${c.file}]\n${c.content}`)

goInterfaces.forEach(i => {
    console.log('---')
    console.log(i)
})

// ── 断言关键内容被召回 ───────────────────────────────────────
console.log('\n=== 关键内容召回验证 ===')
const allContent = allMatches.map(c => c.content).join('\n')

const checks = [
    ['SignInRepository 接口被召回', allContent.includes('SignInRepository')],
    ['SignInServicer 接口被召回', allContent.includes('SignInServicer')],
    ['GetTodayRecord 方法被召回', allContent.includes('GetTodayRecord')],
    ['Claim 方法被召回', allContent.includes('Claim')],
    ['TS types 被召回', allContent.includes('ClaimResponse') || allContent.includes('SignInStatus')],
    ['错误定义被召回', allContent.includes('ErrAlreadyClaimed')],
]

let passed = 0
checks.forEach(([label, ok]) => {
    console.log(`  ${ok ? '✅' : '❌'} ${label}`)
    if (ok) passed++
})

console.log(`\n结果: ${passed}/${checks.length} 通过`)
if (passed < checks.length) process.exit(1)