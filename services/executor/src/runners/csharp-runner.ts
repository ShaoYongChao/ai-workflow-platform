import { execFile } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import * as fs from 'fs'
import { parseStringPromise } from 'xml2js'
import { TestRunResult, TestCase, TestStatus } from '../schemas/types'
import { logger } from '../utils/logger'
import { SANDBOX_TIMEOUT } from '../utils/sandbox'

const execFileAsync = promisify(execFile)

// ── 运行 C# 测试（xUnit）─────────────────────────────────────
export async function runCSharpTests(csharpDir: string, taskId: string): Promise<TestRunResult> {
  const start = Date.now()
  logger.info({ taskId, csharpDir }, '开始执行 C# 测试')

  // 检查是否有 .csproj 文件
  const csprojFiles = findCsprojFiles(csharpDir)
  if (csprojFiles.length === 0) {
    logger.warn({ taskId }, '没有找到 C# 项目文件 (.csproj)')
    return noTestsFallback(csharpDir, 'csharp', start)
  }

  // 检查 dotnet 是否可用
  const dotnetAvailable = await checkDotnetAvailable()
  if (!dotnetAvailable) {
    logger.warn({ taskId }, 'dotnet 命令不可用，使用静态分析')
    return staticAnalyzeFallback(csharpDir, 'csharp', start)
  }

  try {
    // 1. dotnet restore（下载依赖）
    logger.info({ taskId }, '正在恢复依赖...')
    await execFileAsync('dotnet', ['restore'], {
      cwd: csharpDir,
      timeout: 120000,  // restore 可能比较慢
      env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: 'true' }
    })

    // 2. 运行 dotnet test 生成 TRX 报告
    const trxDir = path.join(csharpDir, 'TestResults')
    if (!fs.existsSync(trxDir)) {
      fs.mkdirSync(trxDir, { recursive: true })
    }

    logger.info({ taskId }, '正在运行测试...')
    await execFileAsync('dotnet', [
      'test',
      '--logger', `trx;LogFileName=${path.join(trxDir, 'test-results.trx')}`,
      '--collect:"XPlat Code Coverage"',
      '--configuration', 'Release'
    ], {
      cwd: csharpDir,
      timeout: SANDBOX_TIMEOUT,
      env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: 'true' }
    })

    // 3. 解析 TRX 文件
    const trxFile = path.join(trxDir, 'test-results.trx')
    if (fs.existsSync(trxFile)) {
      return await parseTrxFile(trxFile, Date.now() - start)
    } else {
      logger.warn({ taskId }, 'TRX 报告文件未生成')
      return {
        language: 'csharp',
        status: 'error',
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        testCases: [],
        rawOutput: '测试报告生成失败',
        durationMs: Date.now() - start
      }
    }

  } catch (err: any) {
    const output = (err.stdout || '') + (err.stderr || '')

    // 检查是否是因为 dotnet 找不到
    if (output.includes('dotnet') || output.includes('command not found')) {
      logger.warn({ taskId }, 'dotnet 命令执行失败')
      return staticAnalyzeFallback(csharpDir, 'csharp', start)
    }

    // 可能是测试失败但有 TRX 报告
    const trxDir = path.join(csharpDir, 'TestResults')
    const trxFile = path.join(trxDir, 'test-results.trx')
    if (fs.existsSync(trxFile)) {
      return await parseTrxFile(trxFile, Date.now() - start)
    }

    logger.warn({ taskId, err: output.slice(0, 500) }, 'C# 测试执行失败')
    return {
      language: 'csharp',
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

// ── 解析 TRX 文件（xUnit 测试报告 XML 格式）──────────────────
async function parseTrxFile(filePath: string, durationMs: number): Promise<TestRunResult> {
  try {
    const xmlContent = fs.readFileSync(filePath, 'utf-8')
    const data = await parseStringPromise(xmlContent)

    const testCases: TestCase[] = []
    let passedCount = 0
    let failedCount = 0
    let totalCount = 0

    // TRX 格式: <TestRun><Results><UnitTestResult ... />
    const results = data?.TestRun?.Results?.[0]?.UnitTestResult || []

    for (const result of (Array.isArray(results) ? results : [results])) {
      if (!result || !result.$.testName) continue

      totalCount++
      const testName = result.$.testName[0] || 'Unknown'
      const outcome = result.$.outcome?.[0]?.toLowerCase() || 'unknown'
      const durationStr = result.$.duration?.[0] || '0:0:0'
      const testDurationMs = parseTimespan(durationStr)

      let status: TestStatus = 'error'
      if (outcome === 'passed') {
        status = 'pass'
        passedCount++
      } else if (outcome === 'failed') {
        status = 'fail'
        failedCount++
      }

      const errorMessage = result.Output?.[0]?.ErrorInfo?.[0]?.Message?.[0] || ''

      testCases.push({
        name: testName,
        status,
        durationMs: testDurationMs,
        errorMessage: errorMessage ? errorMessage.substring(0, 500) : undefined
      })
    }

    const finalStatus: TestStatus = failedCount === 0 ? 'pass' : 'fail'

    return {
      language: 'csharp',
      status: finalStatus,
      totalTests: totalCount,
      passedTests: passedCount,
      failedTests: failedCount,
      testCases,
      rawOutput: `C# 测试完成: ${passedCount}/${totalCount} 通过`,
      durationMs
    }
  } catch (err) {
    logger.error({ err, file: filePath }, '解析 TRX 文件失败')
    return {
      language: 'csharp',
      status: 'error',
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      testCases: [],
      rawOutput: '解析 TRX 报告失败: ' + (err as Error).message,
      durationMs
    }
  }
}

// ── 时间跨度转毫秒 ──────────────────────────────────────────────
function parseTimespan(timestr: string): number {
  // 格式: HH:MM:SS.mmm
  const match = timestr.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!match) return 0
  const hours = parseInt(match[1])
  const minutes = parseInt(match[2])
  const seconds = parseFloat(match[3])
  return (hours * 3600 + minutes * 60 + seconds) * 1000
}

// ── 查找 .csproj 文件 ────────────────────────────────────────
function findCsprojFiles(dir: string): string[] {
  const files: string[] = []
  try {
    const entries = fs.readdirSync(dir)
    for (const entry of entries) {
      if (entry.endsWith('.csproj')) {
        files.push(path.join(dir, entry))
      }
    }
  } catch { /* 忽略读取错误 */ }
  return files
}

// ── 检查 dotnet 是否可用 ────────────────────────────────────────
async function checkDotnetAvailable(): Promise<boolean> {
  try {
    await execFileAsync('dotnet', ['--version'], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

// ── 静态分析 Fallback（dotnet 不可用时）────────────────────────
function staticAnalyzeFallback(dir: string, language: string, start: number): TestRunResult {
  const issues: string[] = []
  let fileCount = 0

  try {
    const walk = (d: string) => {
      for (const f of fs.readdirSync(d)) {
        const full = path.join(d, f)
        if (fs.statSync(full).isDirectory()) { walk(full); continue }

        if (!f.endsWith('.cs')) continue

        fileCount++
        const content = fs.readFileSync(full, 'utf8')

        // C# 特定检查
        if (!content.includes('namespace '))      issues.push(`${f}: 缺少 namespace 声明`)
        if (content.includes('TODO'))              issues.push(`${f}: 包含待办注释`)
        if (content.match(/\bvar\b.*=.*new /g)?.length! > 5) issues.push(`${f}: 过多 var 声明`)
        if (content.includes('Thread.Sleep'))      issues.push(`${f}: 包含硬性 Sleep 调用`)
      }
    }
    walk(dir)
  } catch { /* 忽略读取错误 */ }

  const passed = issues.length === 0 ? fileCount : 0
  const status: TestStatus = issues.length > 0 ? 'fail' : 'pass'

  return {
    language: 'csharp',
    status,
    totalTests: fileCount,
    passedTests: passed,
    failedTests: issues.length > 0 ? 1 : 0,
    testCases: issues.map(msg => ({
      name: 'static_analysis',
      status: 'fail' as TestStatus,
      durationMs: 0,
      errorMessage: msg
    })),
    rawOutput: `[静态分析模式] ${issues.length} 个问题\n${issues.join('\n')}`,
    durationMs: Date.now() - start
  }
}

// ── 没有测试文件的 Fallback ──────────────────────────────────────
function noTestsFallback(dir: string, language: string, start: number): TestRunResult {
  return {
    language: language as any,
    status: 'pass',
    totalTests: 0,
    passedTests: 0,
    failedTests: 0,
    testCases: [],
    rawOutput: '未找到测试文件',
    durationMs: Date.now() - start
  }
}
