import { execFile } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import * as fs from 'fs'
import { TestRunResult, TestCase, TestStatus } from '../schemas/types'
import { logger } from '../utils/logger'
import { SANDBOX_TIMEOUT } from '../utils/sandbox'

const execFileAsync = promisify(execFile)

export async function runTSTests(tsDir: string, taskId: string): Promise<TestRunResult> {
  const start = Date.now()
  logger.info({ taskId, tsDir }, '开始执行 TypeScript 测试')

  // 检查是否有测试文件
  const hasTestFiles = findTestFiles(tsDir).length > 0
  if (!hasTestFiles) {
    logger.warn({ taskId }, '没有找到 TypeScript 测试文件')
    return noTestsFallback(tsDir, start)
  }

  const nodeAvailable = await checkNodeAvailable()
  if (!nodeAvailable) {
    return staticAnalyzeFallback(tsDir, start)
  }

  try {
    // 安装依赖（如果 node_modules 不存在）
    await ensureNodeModules(tsDir)

    // 运行 jest --json 输出机器可读格式
    const { stdout } = await execFileAsync(
      'npx', ['jest', '--json', '--coverage', '--forceExit', '--testTimeout=10000'],
      {
        cwd: tsDir,
        timeout: SANDBOX_TIMEOUT,
        env: { ...process.env, CI: 'true', NODE_ENV: 'test' }
      }
    )

    return parseJestJSON(stdout, Date.now() - start)

  } catch (err: any) {
    const output = err.stdout || err.stderr || ''

    // Jest 有输出但有失败用例
    if (output.startsWith('{') || output.includes('"testResults"')) {
      return parseJestJSON(output, Date.now() - start)
    }

    // 完全无法运行
    return {
      language: 'typescript',
      status: 'error',
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      testCases: [],
      rawOutput: output.slice(0, 3000),
      durationMs: Date.now() - start
    }
  }
}

// ── 解析 jest --json 输出 ────────────────────────────────────
function parseJestJSON(raw: string, durationMs: number): TestRunResult {
  try {
    // Jest JSON 可能有前缀文字，找到第一个 {
    const jsonStart = raw.indexOf('{')
    if (jsonStart === -1) throw new Error('no json')

    const data = JSON.parse(raw.slice(jsonStart)) as {
      success: boolean
      numTotalTests: number
      numPassedTests: number
      numFailedTests: number
      coverageMap?: Record<string, { s: Record<string, number> }>
      testResults: Array<{
        testFilePath: string
        testResults: Array<{
          fullName: string
          status: 'passed' | 'failed' | 'pending'
          duration: number | null
          failureMessages: string[]
        }>
      }>
    }

    const testCases: TestCase[] = []
    for (const suite of data.testResults) {
      for (const t of suite.testResults) {
        testCases.push({
          name: t.fullName,
          status: t.status === 'passed' ? 'pass'
            : t.status === 'failed' ? 'fail' : 'error',
          durationMs: t.duration || 0,
          errorMessage: t.failureMessages.join('\n').slice(0, 500)
        })
      }
    }

    // 计算覆盖率（从 coverageMap 简单估算）
    let coverage: number | undefined
    if (data.coverageMap) {
      const files = Object.values(data.coverageMap)
      if (files.length > 0) {
        let total = 0, covered = 0
        for (const f of files) {
          const stmts = Object.values(f.s || {})
          total   += stmts.length
          covered += stmts.filter(v => v > 0).length
        }
        coverage = total > 0 ? Math.round((covered / total) * 100) : 0
      }
    }

    return {
      language: 'typescript',
      status: data.success ? 'pass' : 'fail',
      totalTests: data.numTotalTests,
      passedTests: data.numPassedTests,
      failedTests: data.numFailedTests,
      coverage,
      testCases,
      rawOutput: raw.slice(0, 5000),
      durationMs
    }

  } catch {
    // JSON 解析失败，尝试文本解析
    return parseJestText(raw, durationMs)
  }
}

// ── Jest 文本输出 fallback 解析 ──────────────────────────────
function parseJestText(raw: string, durationMs: number): TestRunResult {
  const passed = (raw.match(/✓|✔|PASS|passed/g) || []).length
  const failed = (raw.match(/✕|✗|FAIL|failed/gi) || []).length

  return {
    language: 'typescript',
    status: failed > 0 ? 'fail' : passed > 0 ? 'pass' : 'error',
    totalTests: passed + failed,
    passedTests: passed,
    failedTests: failed,
    testCases: [],
    rawOutput: raw.slice(0, 3000),
    durationMs
  }
}

// ── 确保 node_modules 存在 ───────────────────────────────────
async function ensureNodeModules(tsDir: string) {
  const nmPath = path.join(tsDir, 'node_modules')
  if (fs.existsSync(nmPath)) return

  logger.info({ tsDir }, '安装 node_modules...')
  try {
    // 先尝试 prefer-offline（利用本地缓存）
    await execFileAsync('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund'], {
      cwd: tsDir,
      timeout: 120000
    })
  } catch (err: any) {
    // 若部分包安装失败，尝试 --legacy-peer-deps 忽略冲突
    logger.warn({ tsDir, err: err.message?.slice(0, 200) }, 'npm install 首次失败，用 legacy-peer-deps 重试')
    await execFileAsync('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund', '--legacy-peer-deps'], {
      cwd: tsDir,
      timeout: 120000
    })
  }
}

// ── 静态分析 fallback ────────────────────────────────────────
function staticAnalyzeFallback(tsDir: string, start: number): TestRunResult {
  const issues: string[] = []
  let fileCount = 0

  for (const file of findAllTSFiles(tsDir)) {
    fileCount++
    const content = fs.readFileSync(file, 'utf8')
    if (content.split(': any').length > 4) issues.push(`${path.basename(file)}: 过多 any 类型`)
    if (content.includes('console.log'))   issues.push(`${path.basename(file)}: 包含 console.log`)
    if (content.includes('TODO'))          issues.push(`${path.basename(file)}: 包含 TODO`)
  }

  return {
    language: 'typescript',
    status: issues.length === 0 ? 'pass' : 'fail',
    totalTests: fileCount,
    passedTests: issues.length === 0 ? fileCount : 0,
    failedTests: issues.length,
    testCases: issues.map(msg => ({
      name: 'static_analysis', status: 'fail' as TestStatus,
      durationMs: 0, errorMessage: msg
    })),
    rawOutput: `[静态分析] ${issues.join('\n')}`,
    durationMs: Date.now() - start
  }
}

function noTestsFallback(tsDir: string, start: number): TestRunResult {
  return {
    language: 'typescript',
    status: 'error',
    totalTests: 0, passedTests: 0, failedTests: 0,
    testCases: [{ name: 'no_tests', status: 'error', durationMs: 0, errorMessage: '未生成测试文件' }],
    rawOutput: '未找到 .test.ts 文件',
    durationMs: Date.now() - start
  }
}

function findTestFiles(dir: string): string[] {
  return findAllTSFiles(dir).filter(f => f.includes('.test.'))
}

function findAllTSFiles(dir: string): string[] {
  const results: string[] = []
  if (!fs.existsSync(dir)) return results
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name)
    if (f.isDirectory() && f.name !== 'node_modules' && f.name !== 'dist') {
      results.push(...findAllTSFiles(full))
    } else if (f.name.endsWith('.ts')) {
      results.push(full)
    }
  }
  return results
}

async function checkNodeAvailable(): Promise<boolean> {
  try {
    await execFileAsync('node', ['--version'], { timeout: 3000 })
    return true
  } catch { return false }
}