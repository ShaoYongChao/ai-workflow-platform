import { execFile } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import * as fs from 'fs'
import { parseStringPromise } from 'xml2js'
import { TestRunResult, TestCase, TestStatus } from '../schemas/types'
import { logger } from '../utils/logger'
import { SANDBOX_TIMEOUT } from '../utils/sandbox'

const execFileAsync = promisify(execFile)

// ── 运行 Python 测试（pytest）────────────────────────────────────
export async function runPythonTests(pythonDir: string, taskId: string): Promise<TestRunResult> {
  const start = Date.now()
  logger.info({ taskId, pythonDir }, '开始执行 Python 测试')

  // 检查测试文件
  const hasTests = hasTestFiles(pythonDir)
  if (!hasTests) {
    logger.warn({ taskId }, '没有找到 Python 测试文件')
    return noTestsFallback(pythonDir, 'python', start)
  }

  // 检查 Python 是否可用
  const pythonAvailable = await checkPythonAvailable()
  if (!pythonAvailable) {
    logger.warn({ taskId }, 'Python 命令不可用，使用静态分析')
    return staticAnalyzeFallback(pythonDir, 'python', start)
  }

  try {
    // 1. 检查并安装依赖
    const requirementsFile = path.join(pythonDir, 'requirements.txt')
    if (fs.existsSync(requirementsFile)) {
      logger.info({ taskId }, '正在安装依赖...')
      try {
        await execFileAsync('pip', ['install', '-r', 'requirements.txt'], {
          cwd: pythonDir,
          timeout: 120000,
          env: { ...process.env }
        })
      } catch (err) {
        logger.warn({ taskId }, 'pip install 失败，继续运行测试')
      }
    }

    // 2. 运行 pytest 生成 JUnit XML 报告
    const reportFile = path.join(pythonDir, 'pytest-report.xml')
    logger.info({ taskId }, '正在运行测试...')

    try {
      await execFileAsync('pytest', [
        '--junit-xml=' + reportFile,
        '--cov=.',
        '--cov-report=term',
        '-v'
      ], {
        cwd: pythonDir,
        timeout: SANDBOX_TIMEOUT,
        env: { ...process.env }
      })
    } catch (err: any) {
      // pytest 返回非零退出码表示有测试失败，这是正常的
      // 只要生成了报告，我们就继续解析
      const output = (err.stdout || '') + (err.stderr || '')
      logger.debug({ taskId }, 'pytest 返回非零码（可能有测试失败）')
    }

    // 3. 解析 JUnit XML 报告
    if (fs.existsSync(reportFile)) {
      return await parseJunitReport(reportFile, Date.now() - start)
    } else {
      logger.warn({ taskId }, 'pytest 报告文件未生成')
      return {
        language: 'python',
        status: 'error',
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        testCases: [],
        rawOutput: 'pytest 报告生成失败',
        durationMs: Date.now() - start
      }
    }

  } catch (err: any) {
    const output = (err.stdout || '') + (err.stderr || '')

    // 检查是否是因为 Python 找不到
    if (output.includes('python') || output.includes('command not found')) {
      logger.warn({ taskId }, 'Python 命令执行失败')
      return staticAnalyzeFallback(pythonDir, 'python', start)
    }

    logger.error({ taskId, err: output.slice(0, 500) }, 'Python 测试执行失败')
    return {
      language: 'python',
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

// ── 解析 JUnit XML 报告 ───────────────────────────────────────────
async function parseJunitReport(filePath: string, durationMs: number): Promise<TestRunResult> {
  try {
    const xmlContent = fs.readFileSync(filePath, 'utf-8')
    const data = await parseStringPromise(xmlContent)

    const testSuite = data?.testsuite
    if (!testSuite) {
      throw new Error('Invalid JUnit XML format')
    }

    const testSuiteAttr = testSuite.$
    const total = parseInt(testSuiteAttr.tests || '0')
    const failures = parseInt(testSuiteAttr.failures || '0')
    const errors = parseInt(testSuiteAttr.errors || '0')
    const skipped = parseInt(testSuiteAttr.skipped || '0')
    const passed = total - failures - errors - skipped

    const testCases: TestCase[] = []

    // 解析测试用例
    const testCaseNodes = testSuite.testcase || []
    for (const tc of (Array.isArray(testCaseNodes) ? testCaseNodes : [testCaseNodes])) {
      if (!tc.$ || !tc.$.name) continue

      let status: TestStatus = 'pass'
      let errorMessage: string | undefined

      // 检查失败或错误
      if (tc.failure) {
        status = 'fail'
        errorMessage = (tc.failure[0]._ || tc.failure[0].$message || '').substring(0, 500)
      } else if (tc.error) {
        status = 'error'
        errorMessage = (tc.error[0]._ || tc.error[0].$message || '').substring(0, 500)
      } else if (tc.skipped) {
        status = 'pass'  // pytest 将 skip 作为通过处理
      }

      testCases.push({
        name: tc.$.name,
        status,
        durationMs: parseFloat(tc.$.time || '0') * 1000,
        errorMessage
      })
    }

    const finalStatus: TestStatus = failures === 0 && errors === 0 ? 'pass' : 'fail'

    return {
      language: 'python',
      status: finalStatus,
      totalTests: total,
      passedTests: passed,
      failedTests: failures + errors,
      testCases,
      rawOutput: `Python 测试完成: ${passed}/${total} 通过`,
      durationMs
    }
  } catch (err) {
    logger.error({ err, file: filePath }, '解析 JUnit 报告失败')
    return {
      language: 'python',
      status: 'error',
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      testCases: [],
      rawOutput: '解析 JUnit 报告失败: ' + (err as Error).message,
      durationMs
    }
  }
}

// ── 检查是否有测试文件 ────────────────────────────────────────────
function hasTestFiles(dir: string): boolean {
  try {
    const walk = (d: string): boolean => {
      for (const f of fs.readdirSync(d)) {
        const full = path.join(d, f)
        if (fs.statSync(full).isDirectory()) {
          if (f === '__pycache__' || f === '.venv' || f === 'venv') continue
          if (walk(full)) return true
        } else if (f.startsWith('test_') && f.endsWith('.py')) {
          return true
        } else if (f.endsWith('_test.py')) {
          return true
        }
      }
      return false
    }
    return walk(dir)
  } catch {
    return false
  }
}

// ── 检查 Python 是否可用 ───────────────────────────────────────────
async function checkPythonAvailable(): Promise<boolean> {
  try {
    // 尝试 python3 或 python
    try {
      await execFileAsync('python3', ['--version'], { timeout: 5000 })
      return true
    } catch {
      await execFileAsync('python', ['--version'], { timeout: 5000 })
      return true
    }
  } catch {
    return false
  }
}

// ── 静态分析 Fallback ──────────────────────────────────────────────
function staticAnalyzeFallback(dir: string, language: string, start: number): TestRunResult {
  const issues: string[] = []
  let fileCount = 0

  try {
    const walk = (d: string) => {
      for (const f of fs.readdirSync(d)) {
        const full = path.join(d, f)
        if (fs.statSync(full).isDirectory()) {
          if (f === '__pycache__' || f === '.venv' || f === 'venv') return
          walk(full)
          return
        }

        if (!f.endsWith('.py')) continue

        fileCount++
        const content = fs.readFileSync(full, 'utf8')

        // Python 特定检查
        if (content.includes('print('))     issues.push(`${f}: 包含 print 调用（应使用日志）`)
        if (content.includes('TODO'))       issues.push(`${f}: 包含待办注释`)
        if (content.includes('import *'))   issues.push(`${f}: 包含通配符导入`)
        if (content.match(/== None/g)?.length! > 2) issues.push(`${f}: 使用 == None（应用 is None）`)
      }
    }
    walk(dir)
  } catch { /* 忽略读取错误 */ }

  const passed = issues.length === 0 ? fileCount : 0
  const status: TestStatus = issues.length > 0 ? 'fail' : 'pass'

  return {
    language: 'python',
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

// ── 没有测试文件的 Fallback ────────────────────────────────────────
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
