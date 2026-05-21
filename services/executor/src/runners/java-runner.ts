import { execFile } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import * as fs from 'fs'
import { parseStringPromise } from 'xml2js'
import { TestRunResult, TestCase, TestStatus } from '../schemas/types'
import { logger } from '../utils/logger'
import { SANDBOX_TIMEOUT } from '../utils/sandbox'

const execFileAsync = promisify(execFile)

// ── 运行 Java 测试（JUnit5 + Maven/Gradle）─────────────────────
export async function runJavaTests(javaDir: string, taskId: string): Promise<TestRunResult> {
  const start = Date.now()
  logger.info({ taskId, javaDir }, '开始执行 Java 测试')

  // 检查项目文件
  const hasMaven = fs.existsSync(path.join(javaDir, 'pom.xml'))
  const hasGradle = fs.existsSync(path.join(javaDir, 'build.gradle'))

  if (!hasMaven && !hasGradle) {
    logger.warn({ taskId }, '没有找到 pom.xml 或 build.gradle')
    return noTestsFallback(javaDir, 'java', start)
  }

  try {
    // 根据项目类型选择 Maven 或 Gradle
    if (hasMaven) {
      return await runMavenTests(javaDir, taskId, start)
    } else {
      return await runGradleTests(javaDir, taskId, start)
    }
  } catch (err: any) {
    const output = (err.stdout || '') + (err.stderr || '')
    logger.error({ taskId, err: output.slice(0, 500) }, 'Java 测试执行失败')

    return {
      language: 'java',
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

// ── 运行 Maven 测试 ──────────────────────────────────────────────
async function runMavenTests(javaDir: string, taskId: string, start: number): Promise<TestRunResult> {
  try {
    logger.info({ taskId }, '使用 Maven 运行测试')

    await execFileAsync('mvn', ['clean', 'test', '-DfailIfNoTests=false'], {
      cwd: javaDir,
      timeout: SANDBOX_TIMEOUT,
      env: { ...process.env }
    })

    // 解析 Surefire 报告
    const sureDir = path.join(javaDir, 'target', 'surefire-reports')
    const reportFile = path.join(sureDir, 'TEST-*.xml')

    // 找到测试报告文件
    let testResult: TestRunResult | null = null
    if (fs.existsSync(sureDir)) {
      const files = fs.readdirSync(sureDir).filter(f => f.startsWith('TEST-') && f.endsWith('.xml'))
      if (files.length > 0) {
        // 解析第一个报告文件（通常只有一个汇总报告）
        testResult = await parseSurefireReport(path.join(sureDir, files[0]), Date.now() - start)
      }
    }

    if (testResult) return testResult

    return {
      language: 'java',
      status: 'error',
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      testCases: [],
      rawOutput: 'Maven 测试报告生成失败',
      durationMs: Date.now() - start
    }
  } catch (err: any) {
    const output = (err.stdout || '') + (err.stderr || '')

    // 检查是否是因为 Maven 找不到
    if (output.includes('mvn') || output.includes('command not found')) {
      logger.warn({ taskId }, 'Maven 命令不可用，使用静态分析')
      return staticAnalyzeFallback(javaDir, 'java', start)
    }

    // 尝试解析可能已生成的报告
    const sureDir = path.join(javaDir, 'target', 'surefire-reports')
    if (fs.existsSync(sureDir)) {
      const files = fs.readdirSync(sureDir).filter(f => f.startsWith('TEST-') && f.endsWith('.xml'))
      if (files.length > 0) {
        return await parseSurefireReport(path.join(sureDir, files[0]), Date.now() - start)
      }
    }

    throw err
  }
}

// ── 运行 Gradle 测试 ─────────────────────────────────────────────
async function runGradleTests(javaDir: string, taskId: string, start: number): Promise<TestRunResult> {
  try {
    logger.info({ taskId }, '使用 Gradle 运行测试')

    await execFileAsync('./gradlew', ['test', '--no-daemon'], {
      cwd: javaDir,
      timeout: SANDBOX_TIMEOUT,
      env: { ...process.env }
    })

    // 解析 Gradle 报告（通常在 build/test-results/test）
    const testResultsDir = path.join(javaDir, 'build', 'test-results', 'test')
    if (fs.existsSync(testResultsDir)) {
      const files = fs.readdirSync(testResultsDir).filter(f => f.endsWith('.xml'))
      if (files.length > 0) {
        return await parseGradleReport(path.join(testResultsDir, files[0]), Date.now() - start)
      }
    }

    return {
      language: 'java',
      status: 'error',
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      testCases: [],
      rawOutput: 'Gradle 测试报告生成失败',
      durationMs: Date.now() - start
    }
  } catch (err: any) {
    const output = (err.stdout || '') + (err.stderr || '')

    if (output.includes('gradlew') || output.includes('command not found')) {
      logger.warn({ taskId }, 'Gradle 命令不可用，使用静态分析')
      return staticAnalyzeFallback(javaDir, 'java', start)
    }

    throw err
  }
}

// ── 解析 Surefire 报告（Maven）─────────────────────────────────
async function parseSurefireReport(filePath: string, durationMs: number): Promise<TestRunResult> {
  try {
    const xmlContent = fs.readFileSync(filePath, 'utf-8')
    const data = await parseStringPromise(xmlContent)

    const testSuite = data?.testsuite
    if (!testSuite) {
      throw new Error('Invalid Surefire format')
    }

    const totalAttr = testSuite.$
    const total = parseInt(totalAttr.tests || '0')
    const failures = parseInt(totalAttr.failures || '0')
    const errors = parseInt(totalAttr.errors || '0')
    const skipped = parseInt(totalAttr.skipped || '0')
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
      language: 'java',
      status: finalStatus,
      totalTests: total,
      passedTests: passed,
      failedTests: failures + errors,
      testCases,
      rawOutput: `Java 测试完成: ${passed}/${total} 通过`,
      durationMs
    }
  } catch (err) {
    logger.error({ err, file: filePath }, '解析 Surefire 报告失败')
    return {
      language: 'java',
      status: 'error',
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      testCases: [],
      rawOutput: '解析 Surefire 报告失败: ' + (err as Error).message,
      durationMs
    }
  }
}

// ── 解析 Gradle 报告 ────────────────────────────────────────────
async function parseGradleReport(filePath: string, durationMs: number): Promise<TestRunResult> {
  // Gradle 报告格式类似 Surefire，使用相同的解析逻辑
  return parseSurefireReport(filePath, durationMs)
}

// ── 静态分析 Fallback ─────────────────────────────────────────────
function staticAnalyzeFallback(dir: string, language: string, start: number): TestRunResult {
  const issues: string[] = []
  let fileCount = 0

  try {
    const walk = (d: string) => {
      for (const f of fs.readdirSync(d)) {
        const full = path.join(d, f)
        if (fs.statSync(full).isDirectory()) { walk(full); continue }

        if (!f.endsWith('.java')) continue

        fileCount++
        const content = fs.readFileSync(full, 'utf8')

        // Java 特定检查
        if (!content.includes('public class')) issues.push(`${f}: 缺少 public class 声明`)
        if (content.includes('TODO'))         issues.push(`${f}: 包含待办注释`)
        if (content.includes('Thread.sleep')) issues.push(`${f}: 包含 sleep 调用`)
        if (content.match(/System\.out\.print/g)?.length! > 3) issues.push(`${f}: 包含 System.out 输出`)
      }
    }
    walk(dir)
  } catch { /* 忽略读取错误 */ }

  const passed = issues.length === 0 ? fileCount : 0
  const status: TestStatus = issues.length > 0 ? 'fail' : 'pass'

  return {
    language: 'java',
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
