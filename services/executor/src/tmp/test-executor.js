// 内联所有被测逻辑，纯 Node.js 运行

// ── error-summarizer ──────────────────────────────────────────
function summarizeErrors(results) {
    const parts = []
    for (const result of results) {
        if (result.status === 'pass') continue
        parts.push(`=== ${result.language.toUpperCase()} 测试失败 ===`)
        const failed = result.testCases.filter(c => c.status === 'fail' || c.status === 'error')
        if (failed.length > 0) {
            parts.push(`失败用例 (${failed.length}个):`)
            for (const c of failed.slice(0, 5)) {
                parts.push(`  - ${c.name}`)
                if (c.errorMessage) parts.push(`    错误: ${c.errorMessage.split('\n')[0]}`)
            }
        }
        if ((result.status === 'error' || result.testCases.length === 0) && result.rawOutput) {
            const lines = result.rawOutput.split('\n').filter(l => l.match(/\.go:\d+/) || l.includes('Error:'))
            if (lines.length) parts.push(`编译错误:\n${lines.slice(0, 4).join('\n')}`)
        }
    }
    return parts.join('\n').slice(0, 2000)
}

function isFixable(results) {
    for (const r of results) {
        if (r.status === 'error' && r.rawOutput?.includes('no Go files')) return false
        if (r.status === 'timeout') return false
    }
    return true
}

function extractFilesFromOutput(raw) {
    const files = []
    const pattern = /###\s*FILE:\s*([^\n]+)\n```(\w+)\n([\s\S]*?)```/g
    let match
    while ((match = pattern.exec(raw)) !== null) {
        const [, filePath, lang, content] = match
        files.push({
            path: filePath.trim(),
            language: lang.toLowerCase().includes('go') ? 'go' : 'typescript',
            content: content.trim()
        })
    }
    return files
}

function allPassed(results) {
    return results.length > 0 && results.every(r => r.status === 'pass')
}

function parseGoTestJSON(lines) {
    const cases = new Map()
    for (const line of lines) {
        if (!line.trim().startsWith('{')) continue
        try {
            const e = JSON.parse(line)
            if (!e.Test) continue
            switch (e.Action) {
                case 'run': cases.set(e.Test, { name: e.Test, status: 'pass', durationMs: 0 }); break
                case 'pass': if (cases.has(e.Test)) { cases.get(e.Test).status = 'pass'; cases.get(e.Test).durationMs = (e.Elapsed || 0) * 1000 }; break
                case 'fail': if (cases.has(e.Test)) cases.get(e.Test).status = 'fail'; break
            }
        } catch { }
    }
    return Array.from(cases.values())
}

function calculateScore(testResults) {
    if (!testResults.length) return null
    const last = { go: null, ts: null }
    for (const r of testResults) {
        if (r.language === 'go') last.go = r
        else last.ts = r
    }
    const results = [last.go, last.ts].filter(Boolean)
    const total = results.reduce((s, r) => s + r.totalTests, 0)
    const passed = results.reduce((s, r) => s + r.passedTests, 0)
    const correctness = total > 0 ? (passed / total) * 100 : 0
    const coverages = results.map(r => r.coverage).filter(c => c !== undefined)
    const coverage = coverages.length ? coverages.reduce((s, c) => s + c, 0) / coverages.length : 0
    const quality = correctness >= 100 ? 80 : correctness * 0.8
    const score = Math.round(correctness * 0.35 + coverage * 0.25 + quality * 0.20)
    return { correctness, coverage, quality, total: score }
}

// ── 测试框架 ──────────────────────────────────────────────────
let passed = 0, failed = 0
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); passed++ }
    catch (e) { console.log(`  ❌ ${name}: ${e.message}`); failed++ }
}
function expect(val) {
    return {
        toBe: (e) => { if (val !== e) throw new Error(`期望 ${JSON.stringify(e)}，实际 ${JSON.stringify(val)}`) },
        toHaveLength: (n) => { if (val.length !== n) throw new Error(`期望长度 ${n}，实际 ${val.length}`) },
        toBeGreaterThan: (n) => { if (!(val > n)) throw new Error(`期望 > ${n}，实际 ${val}`) },
        toBeLessThanOrEqual: (n) => { if (val > n) throw new Error(`期望 <= ${n}，实际 ${val}`) },
        toContain: (s) => { if (!val.includes(s)) throw new Error(`期望包含 "${s}"`) },
        not: {
            toContain: (s) => { if (val.includes(s)) throw new Error(`期望不含 "${s}"，但找到了`) },
            toThrow: () => { }
        },
        toBeCloseTo: (n, d = 2) => { if (Math.abs(val - n) > Math.pow(10, -d) * 5) throw new Error(`期望约 ${n}，实际 ${val}`) },
        toBeNull: () => { if (val !== null) throw new Error(`期望 null，实际 ${val}`) },
        toBeDefined: () => { if (val === undefined) throw new Error('期望有值') },
    }
}
function describe(name, fn) { console.log(`\n🧪 ${name}`); fn() }

// ── 用例 ──────────────────────────────────────────────────────
describe('error-summarizer', () => {
    test('通过的测试结果不产生摘要', () => {
        const r = summarizeErrors([{ status: 'pass', language: 'go', testCases: [] }])
        expect(r).toBe('')
    })
    test('失败结果包含语言标识和用例名', () => {
        const r = summarizeErrors([{
            status: 'fail', language: 'go',
            testCases: [
                { name: 'TestClaim_Success', status: 'fail', errorMessage: 'expected 200, got 500' },
                { name: 'TestClaim_AlreadyClaimed', status: 'pass' }
            ]
        }])
        expect(r).toContain('GO')
        expect(r).toContain('TestClaim_Success')
        expect(r).not.toContain('TestClaim_AlreadyClaimed')
    })
    test('多语言失败结果都包含', () => {
        const r = summarizeErrors([
            { status: 'fail', language: 'go', testCases: [{ name: 'TestA', status: 'fail', errorMessage: 'e' }] },
            { status: 'fail', language: 'typescript', testCases: [{ name: 'testB', status: 'fail', errorMessage: 'e' }] }
        ])
        expect(r).toContain('GO')
        expect(r).toContain('TYPESCRIPT')
    })
    test('结果长度不超过 2000 字符', () => {
        const r = summarizeErrors([{
            status: 'fail', language: 'go',
            testCases: [{ name: 'T', status: 'fail', errorMessage: 'x'.repeat(5000) }]
        }])
        expect(r.length).toBeLessThanOrEqual(2000)
    })
})

describe('isFixable', () => {
    test('普通测试失败可以 fix', () => {
        expect(isFixable([{ status: 'fail', rawOutput: 'assertion failed', testCases: [] }])).toBe(true)
    })
    test('no Go files 不可 fix', () => {
        expect(isFixable([{ status: 'error', rawOutput: 'no Go files in /tmp', testCases: [] }])).toBe(false)
    })
    test('timeout 不可 fix', () => {
        expect(isFixable([{ status: 'timeout', rawOutput: '', testCases: [] }])).toBe(false)
    })
    test('全部通过返回 true', () => {
        expect(isFixable([{ status: 'pass', rawOutput: '', testCases: [] }])).toBe(true)
    })
})

describe('extractFilesFromOutput', () => {
    test('正确解析多个文件', () => {
        const raw = `
### FILE: server/signin/service.go
\`\`\`go
package signin
func (s *Service) Claim() error { return nil }
\`\`\`

### FILE: client/signin/api.ts
\`\`\`typescript
export async function claim() {}
\`\`\`
`
        const files = extractFilesFromOutput(raw)
        expect(files).toHaveLength(2)
        expect(files[0].language).toBe('go')
        expect(files[1].language).toBe('typescript')
        expect(files[0].path).toBe('server/signin/service.go')
    })
    test('无文件时返回空数组', () => {
        expect(extractFilesFromOutput('纯文字')).toHaveLength(0)
    })
})

describe('allPassed', () => {
    test('空数组返回 false', () => expect(allPassed([])).toBe(false))
    test('全部 pass 返回 true', () => expect(allPassed([{ status: 'pass' }, { status: 'pass' }])).toBe(true))
    test('有 fail 返回 false', () => expect(allPassed([{ status: 'pass' }, { status: 'fail' }])).toBe(false))
    test('有 error 返回 false', () => expect(allPassed([{ status: 'error' }])).toBe(false))
})

describe('parseGoTestJSON', () => {
    test('正确解析 pass 用例', () => {
        const cases = parseGoTestJSON([
            '{"Action":"run","Test":"TestClaim_Success"}',
            '{"Action":"pass","Test":"TestClaim_Success","Elapsed":0.05}'
        ])
        expect(cases).toHaveLength(1)
        expect(cases[0].status).toBe('pass')
        expect(cases[0].durationMs).toBeCloseTo(50, 0)
    })
    test('正确解析 fail 用例', () => {
        const cases = parseGoTestJSON([
            '{"Action":"run","Test":"TestA"}',
            '{"Action":"fail","Test":"TestA","Elapsed":0.01}'
        ])
        expect(cases[0].status).toBe('fail')
    })
    test('混合 pass + fail', () => {
        const cases = parseGoTestJSON([
            '{"Action":"run","Test":"TestA"}', '{"Action":"pass","Test":"TestA","Elapsed":0.01}',
            '{"Action":"run","Test":"TestB"}', '{"Action":"fail","Test":"TestB","Elapsed":0.02}'
        ])
        expect(cases.find(c => c.name === 'TestA')?.status).toBe('pass')
        expect(cases.find(c => c.name === 'TestB')?.status).toBe('fail')
    })
    test('非 JSON 行被跳过不报错', () => {
        let threw = false
        try { parseGoTestJSON(['not json', '{"Action":"run","Test":"T"}']) }
        catch { threw = true }
        expect(threw).toBe(false)
    })
})

describe('calculateScore', () => {
    test('全通过 + 有覆盖率时得高分', () => {
        const s = calculateScore([
            { language: 'go', totalTests: 4, passedTests: 4, failedTests: 0, coverage: 85, status: 'pass' },
            { language: 'typescript', totalTests: 3, passedTests: 3, failedTests: 0, coverage: 90, status: 'pass' }
        ])
        expect(s.total).toBeGreaterThan(50)
        expect(s.correctness).toBe(100)
    })
    test('空数组返回 null', () => {
        expect(calculateScore([])).toBeNull()
    })
    test('部分失败时总分降低', () => {
        const pass = calculateScore([{ language: 'go', totalTests: 4, passedTests: 4, failedTests: 0, coverage: 85, status: 'pass' }])
        const fail = calculateScore([{ language: 'go', totalTests: 4, passedTests: 2, failedTests: 2, coverage: 40, status: 'fail' }])
        expect(pass.total).toBeGreaterThan(fail.total)
    })
})

console.log(`\n${'━'.repeat(40)}`)
console.log(`结果: ${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)