import { TestRunResult } from '../schemas/types'

// ── 从测试结果提取关键错误信息（控制在 2000 字符以内） ───────
export function summarizeErrors(results: TestRunResult[]): string {
  const parts: string[] = []

  for (const result of results) {
    if (result.status === 'pass') continue

    parts.push(`=== ${result.language.toUpperCase()} 测试失败 ===`)

    // 1. 失败的测试用例
    const failedCases = result.testCases.filter(c => c.status === 'fail' || c.status === 'error')
    if (failedCases.length > 0) {
      parts.push(`失败用例 (${failedCases.length}个):`)
      for (const c of failedCases.slice(0, 5)) {  // 最多展示5个
        parts.push(`  - ${c.name}`)
        if (c.errorMessage) {
          // 提取最关键的错误行（去掉长堆栈）
          const keyLines = extractKeyLines(c.errorMessage)
          parts.push(`    错误: ${keyLines}`)
        }
      }
    }

    // 2. 编译/运行时错误（从 rawOutput 提取）
    if (result.status === 'error' || result.testCases.length === 0) {
      const keyError = extractCompileError(result.rawOutput, result.language)
      if (keyError) {
        parts.push(`编译/运行错误:\n${keyError}`)
      }
    }
  }

  return parts.join('\n').slice(0, 2000)
}

// ── 提取关键错误行（去掉无关堆栈） ──────────────────────────
function extractKeyLines(errorMsg: string): string {
  const lines = errorMsg.split('\n').filter(l => l.trim())

  // Go 错误：找 .go: 行
  const goLines = lines.filter(l => l.match(/\.go:\d+/) || l.includes('Error:') || l.includes('expected'))
  if (goLines.length > 0) return goLines.slice(0, 3).join(' | ')

  // TS 错误：找 Error: / expect() / received
  const tsLines = lines.filter(l =>
    l.includes('Error:') || l.includes('Expected') || l.includes('Received') ||
    l.includes('Cannot') || l.includes('undefined') || l.includes('TypeError')
  )
  if (tsLines.length > 0) return tsLines.slice(0, 3).join(' | ')

  return lines.slice(0, 2).join(' | ')
}

// ── 提取编译错误 ────────────────────────────────────────────
function extractCompileError(
  rawOutput: string,
  lang: 'go' | 'typescript' | 'csharp' | 'java' | 'python'
): string {
  if (!rawOutput) return ''
  const lines = rawOutput.split('\n')

  if (lang === 'go') {
    // Go 编译错误格式: ./file.go:12:5: undefined: xxx
    const errLines = lines.filter(l => l.match(/\.\/.+\.go:\d+:\d+:/))
    return errLines.slice(0, 6).join('\n')
  } else if (lang === 'typescript') {
    // TS 错误
    const errLines = lines.filter(l =>
      l.includes('error TS') || l.includes('SyntaxError') ||
      l.includes('Cannot find') || l.match(/\.ts\(\d+,\d+\)/)
    )
    return errLines.slice(0, 6).join('\n')
  } else if (lang === 'csharp') {
    // C# 错误格式: error CS1234:
    const errLines = lines.filter(l =>
      l.match(/error CS\d+/) || l.includes('error:') ||
      l.match(/\.cs\(\d+,\d+\)/)
    )
    return errLines.slice(0, 6).join('\n')
  } else if (lang === 'java') {
    // Java 错误格式: error: [location]
    const errLines = lines.filter(l =>
      l.includes('error:') || l.includes('Exception') ||
      l.match(/\.java:\d+/)
    )
    return errLines.slice(0, 6).join('\n')
  } else {
    // Python 错误格式: Error: / File ... line
    const errLines = lines.filter(l =>
      l.includes('Error:') || l.includes('Traceback') ||
      l.match(/File ".*", line \d+/) || l.includes('FAILED')
    )
    return errLines.slice(0, 6).join('\n')
  }
}

// ── 判断是否值得 Auto-Fix ────────────────────────────────────
export function isFixable(results: TestRunResult[]): boolean {
  for (const r of results) {
    if (r.status === 'error' && r.rawOutput.includes('no Go files')) return false
    if (r.status === 'error' && r.rawOutput.includes('module not found')) return false
    if (r.status === 'timeout') return false
  }
  return true
}