/**
 * 测试范围：
 * 1. error-summarizer：错误提取逻辑
 * 2. file-extractor：文件解析逻辑
 * 3. go-runner：parseGoTestJSON 解析
 * 4. 执行状态机：allPassed 逻辑
 */

// ── 内联被测逻辑（不依赖外部包） ────────────────────────────

function summarizeErrors(results: any[]): string {
  const parts: string[] = []
  for (const result of results) {
    if (result.status === 'pass') continue
    parts.push(`=== ${result.language.toUpperCase()} 测试失败 ===`)
    const failed = result.testCases.filter((c: any) => c.status === 'fail' || c.status === 'error')
    if (failed.length > 0) {
      parts.push(`失败用例 (${failed.length}个):`)
      for (const c of failed.slice(0, 5)) {
        parts.push(`  - ${c.name}`)
        if (c.errorMessage) parts.push(`    错误: ${c.errorMessage.split('\n')[0]}`)
      }
    }
  }
  return parts.join('\n').slice(0, 2000)
}

function isFixable(results: any[]): boolean {
  for (const r of results) {
    if (r.status === 'error' && r.rawOutput?.includes('no Go files')) return false
    if (r.status === 'timeout') return false
  }
  return true
}

function extractFilesFromOutput(raw: string): any[] {
  const files: any[] = []
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

function allPassed(results: any[]): boolean {
  return results.length > 0 && results.every(r => r.status === 'pass')
}

function parseGoTestJSONLine(lines: string[]): any[] {
  const cases: Map<string, any> = new Map()
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue
    try {
      const e = JSON.parse(line)
      if (!e.Test) continue
      switch (e.Action) {
        case 'run':  cases.set(e.Test, { name: e.Test, status: 'pass', durationMs: 0 }); break
        case 'pass': if (cases.has(e.Test)) { cases.get(e.Test).status = 'pass'; cases.get(e.Test).durationMs = (e.Elapsed||0)*1000 }; break
        case 'fail': if (cases.has(e.Test)) cases.get(e.Test).status = 'fail'; break
      }
    } catch { /* skip */ }
  }
  return Array.from(cases.values())
}

// ── 测试套件 ─────────────────────────────────────────────────

describe('error-summarizer', () => {
  it('通过的测试结果不产生摘要', () => {
    const r = summarizeErrors([{ status: 'pass', language: 'go', testCases: [] }])
    expect(r).toBe('')
  })

  it('失败结果包含语言标识和用例名', () => {
    const r = summarizeErrors([{
      status: 'fail', language: 'go',
      testCases: [
        { name: 'TestClaim_Success', status: 'fail', errorMessage: 'expected 200, got 500' },
        { name: 'TestClaim_AlreadyClaimed', status: 'pass' }
      ]
    }])
    expect(r).toContain('GO')
    expect(r).toContain('TestClaim_Success')
    expect(r).not.toContain('TestClaim_AlreadyClaimed') // 通过的不展示
  })

  it('多语言失败结果都包含', () => {
    const r = summarizeErrors([
      { status: 'fail', language: 'go',         testCases: [{ name: 'TestA', status: 'fail', errorMessage: 'err' }] },
      { status: 'fail', language: 'typescript', testCases: [{ name: 'test B', status: 'fail', errorMessage: 'err' }] }
    ])
    expect(r).toContain('GO')
    expect(r).toContain('TYPESCRIPT')
  })

  it('结果长度不超过 2000 字符', () => {
    const longErr = 'x'.repeat(5000)
    const r = summarizeErrors([{
      status: 'fail', language: 'go',
      testCases: [{ name: 'T', status: 'fail', errorMessage: longErr }]
    }])
    expect(r.length).toBeLessThanOrEqual(2000)
  })
})

describe('isFixable', () => {
  it('普通测试失败可以 fix', () => {
    expect(isFixable([{ status: 'fail', rawOutput: 'assertion failed', testCases: [] }])).toBe(true)
  })

  it('no Go files 不可 fix', () => {
    expect(isFixable([{ status: 'error', rawOutput: 'no Go files in /tmp/xxx', testCases: [] }])).toBe(false)
  })

  it('timeout 不可 fix', () => {
    expect(isFixable([{ status: 'timeout', rawOutput: '', testCases: [] }])).toBe(false)
  })

  it('全部通过返回 true（不应调用 fix）', () => {
    expect(isFixable([{ status: 'pass', rawOutput: '', testCases: [] }])).toBe(true)
  })
})

describe('extractFilesFromOutput', () => {
  it('正确解析多个文件', () => {
    const raw = `
修复结果：

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

  it('无文件时返回空数组', () => {
    expect(extractFilesFromOutput('纯文字，没有代码块')).toHaveLength(0)
  })
})

describe('allPassed', () => {
  it('空数组返回 false', () => {
    expect(allPassed([])).toBe(false)
  })

  it('全部 pass 返回 true', () => {
    expect(allPassed([{ status: 'pass' }, { status: 'pass' }])).toBe(true)
  })

  it('有一个 fail 返回 false', () => {
    expect(allPassed([{ status: 'pass' }, { status: 'fail' }])).toBe(false)
  })

  it('有 error 返回 false', () => {
    expect(allPassed([{ status: 'error' }])).toBe(false)
  })
})

describe('parseGoTestJSON', () => {
  it('正确解析 pass 用例', () => {
    const lines = [
      '{"Action":"run","Test":"TestClaim_Success"}',
      '{"Action":"pass","Test":"TestClaim_Success","Elapsed":0.05}'
    ]
    const cases = parseGoTestJSONLine(lines)
    expect(cases).toHaveLength(1)
    expect(cases[0].status).toBe('pass')
    expect(cases[0].durationMs).toBeCloseTo(50, 0)
  })

  it('正确解析 fail 用例', () => {
    const lines = [
      '{"Action":"run","Test":"TestClaim_AlreadyClaimed"}',
      '{"Action":"fail","Test":"TestClaim_AlreadyClaimed","Elapsed":0.01}'
    ]
    const cases = parseGoTestJSONLine(lines)
    expect(cases[0].status).toBe('fail')
  })

  it('混合结果：pass + fail', () => {
    const lines = [
      '{"Action":"run","Test":"TestA"}',
      '{"Action":"pass","Test":"TestA","Elapsed":0.01}',
      '{"Action":"run","Test":"TestB"}',
      '{"Action":"fail","Test":"TestB","Elapsed":0.02}'
    ]
    const cases = parseGoTestJSONLine(lines)
    expect(cases.find(c => c.name === 'TestA')?.status).toBe('pass')
    expect(cases.find(c => c.name === 'TestB')?.status).toBe('fail')
  })

  it('非 JSON 行被跳过不报错', () => {
    const lines = ['not json', '{"Action":"run","Test":"TestC"}', 'also not json']
    expect(() => parseGoTestJSONLine(lines)).not.toThrow()
  })
})