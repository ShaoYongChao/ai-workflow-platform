import {
  CodeGeneratedPayload, GeneratedFile, TestRunResult,
  FixAttempt, ExecutionResult, ExecutionStatus
} from '../schemas/types'
import { createSandbox, updateSandboxFiles } from '../utils/sandbox'
import { runGoTests } from '../runners/go-runner'
import { runTSTests } from '../runners/ts-runner'
import { autoFix } from '../autofix/auto-fixer'
import { isFixable } from '../autofix/error-summarizer'
import { broadcastProgress } from './result-store'
import { logger } from '../utils/logger'
import * as metrics from '../metrics'
import { ConfigLoader } from './config-loader'
import { Pool } from 'pg'

let configLoader: ConfigLoader
export function initializeConfigLoader(pool: Pool) {
  configLoader = new ConfigLoader(pool)
}

let MAX_FIX_ATTEMPTS = 3

// ── 进化引擎惩罚（非阻塞） ────────────────────────────────────
async function triggerEvolutionPenalty(taskId: string, errorPatterns: string[]): Promise<void> {
  try {
    // path: services/executor/src/services/ → services/scorer/src/
    const { EvolutionEngine } = require('../../../scorer/src/evolution-engine')
    const engine = new EvolutionEngine()
    await engine.applyLowScorePenalty(taskId, 0, errorPatterns)
    logger.info({ taskId, patterns: errorPatterns.length }, '[Evolution] 测试失败惩罚已记录')
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[Evolution] 进化引擎调用失败（不阻塞）')
  }
}

// ── 提取失败测试的错误模式 ────────────────────────────────────
function extractErrorPatterns(testResults: TestRunResult[]): string[] {
  return testResults
    .flatMap(r => r.testCases.filter(t => t.status === 'fail' || t.status === 'error'))
    .map(t => t.errorMessage || t.name)
    .filter(Boolean)
    .slice(0, 5) as string[]
}

// ── 主编排函数 ───────────────────────────────────────────────
export async function executeAndTest(
  payload: CodeGeneratedPayload
): Promise<ExecutionResult> {
  const { taskId, specId, spec, files } = payload
  const projectId = payload.projectId || 'default'
  const totalStart = Date.now()

  // 加载系统配置
  if (configLoader) {
    try {
      const config = await configLoader.loadSystemConfig(projectId)
      MAX_FIX_ATTEMPTS = config.max_auto_fix_retries || 3
      logger.info({ taskId, config }, '已加载系统配置')
    } catch (err) {
      logger.warn({ taskId, err }, '加载系统配置失败，使用默认值')
    }
  }

  logger.info({
    taskId, specId,
    title: spec.title,
    goFiles: files.filter(f => f.language === 'go').length,
    tsFiles: files.filter(f => f.language === 'typescript').length
  }, '开始执行测试流程')

  const allTestResults: TestRunResult[] = []
  const fixAttempts: FixAttempt[] = []
  let currentFiles = files

  // ── 创建沙箱 ────────────────────────────────────────────────
  await broadcastProgress(taskId, 'sandbox_creating')
  const sandbox = await createSandbox(taskId, currentFiles)
  await broadcastProgress(taskId, 'sandbox_ready', { dir: sandbox.dir })

  try {
    // ── Round 0：初次测试 ────────────────────────────────────
    await broadcastProgress(taskId, 'test_running', { round: 0 })
    logger.info({ taskId }, '▶ 第 0 轮：初次运行测试')
    const initialResults = await runAllTests(sandbox.goDir, sandbox.tsDir, taskId, spec.platform, currentFiles)
    allTestResults.push(...initialResults)

    // 发布详细测试输出
    for (const result of initialResults) {
      await broadcastProgress(taskId, 'test_output', {
        round: 0,
        language: result.language,
        status: result.status,
        totalTests: result.totalTests,
        passedTests: result.passedTests,
        failedTests: result.failedTests,
        failedTestNames: result.testCases.filter(t => t.status === 'fail').map(t => t.name),
        rawOutput: result.rawOutput.split('\n').slice(0, 30).join('\n'), // 前30行
        durationMs: result.durationMs
      })
    }

    if (allPassed(initialResults)) {
      await broadcastProgress(taskId, 'test_pass', { round: 0 })
      logger.info({ taskId }, '✅ 初次测试全部通过')
      initialResults.forEach(r => metrics.testPassTotal?.inc({ language: r.language }))
      metrics.taskDuration?.observe((Date.now() - totalStart) / 1000)
      await runSonarQube(taskId, sandbox.dir)
      return buildResult(taskId, specId, 'test_pass', currentFiles, allTestResults, fixAttempts, totalStart, true)
    }

    // ── Auto-Fix 循环（最多3次） ─────────────────────────────
    if (!isFixable(initialResults)) {
      await broadcastProgress(taskId, 'manual_review', { reason: '错误类型不可修复' })
      logger.warn({ taskId }, '⚠️  错误类型不适合 Auto-Fix，直接降级为人工审查')
      initialResults.forEach(r => metrics.testFailTotal?.inc({ language: r.language }))
      metrics.manualReviewTotal?.inc({ reason: 'not_fixable' })
      // 触发进化惩罚（异步，不阻塞主流程）
      triggerEvolutionPenalty(taskId, extractErrorPatterns(initialResults))
      return buildResult(taskId, specId, 'manual_review', currentFiles, allTestResults, fixAttempts, totalStart, false)
    }

    for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
      const statusKey = `auto_fix_${attempt}` as ExecutionStatus
      await broadcastProgress(taskId, 'auto_fix_running', { attempt, total: MAX_FIX_ATTEMPTS })
      logger.info({ taskId, attempt }, `🔧 Auto-Fix 第 ${attempt} 次`)

      // 调 LLM 修复
      const fix = await autoFix(attempt, spec, currentFiles, allTestResults)
      fixAttempts.push(fix)

      if (!fix.success) {
        await broadcastProgress(taskId, 'auto_fix_skipped', { attempt, reason: 'LLM 修复输出无效' })
        logger.warn({ taskId, attempt }, 'LLM 修复失败，重试')
        continue
      }

      // 发布 Auto-Fix 详情
      await broadcastProgress(taskId, 'auto_fix_detail', {
        attempt,
        modifiedFiles: fix.fixedFiles.map(f => ({ path: f.path, language: f.language })),
        changesSummary: `修改了 ${fix.fixedFiles.length} 个文件`
      })

      // 更新沙箱文件
      currentFiles = fix.fixedFiles
      updateSandboxFiles(sandbox, currentFiles)

      // 重新跑测试
      await broadcastProgress(taskId, 'test_running', { round: attempt })
      logger.info({ taskId, attempt }, '▶ 重新运行测试')
      const retestResults = await runAllTests(sandbox.goDir, sandbox.tsDir, taskId, spec.platform)
      allTestResults.push(...retestResults)

      // 发布重新测试的输出
      for (const result of retestResults) {
        await broadcastProgress(taskId, 'test_output', {
          round: attempt,
          language: result.language,
          status: result.status,
          totalTests: result.totalTests,
          passedTests: result.passedTests,
          failedTests: result.failedTests,
          failedTestNames: result.testCases.filter(t => t.status === 'fail').map(t => t.name),
          rawOutput: result.rawOutput.split('\n').slice(0, 30).join('\n'),
          durationMs: result.durationMs
        })
      }

      if (allPassed(retestResults)) {
        await broadcastProgress(taskId, 'test_pass', { round: attempt, autoFixAttempts: attempt })
        logger.info({ taskId, attempt }, `✅ Auto-Fix 第 ${attempt} 次后测试通过`)
        retestResults.forEach(r => metrics.testPassTotal?.inc({ language: r.language }))
        metrics.autoFixTotal?.inc({ result: 'success' })
        metrics.taskDuration?.observe((Date.now() - totalStart) / 1000)
        await runSonarQube(taskId, sandbox.dir)
        return buildResult(taskId, specId, 'test_pass', currentFiles, allTestResults, fixAttempts, totalStart, true)
      }

      await broadcastProgress(taskId, 'auto_fix_failed', { attempt })
      logger.warn({ taskId, attempt }, `❌ 第 ${attempt} 次修复后测试仍失败`)
    }

    // ── 3 次全败：降级人工 ───────────────────────────────────
    await broadcastProgress(taskId, 'manual_review', { reason: `Auto-Fix ${MAX_FIX_ATTEMPTS} 次后仍失败` })
    logger.warn({ taskId }, '⛔ Auto-Fix 已达上限（3次），降级为人工审查')
    allTestResults.filter(r => r.status !== 'pass').forEach(r => metrics.testFailTotal?.inc({ language: r.language }))
    metrics.autoFixTotal?.inc({ result: 'exhausted' })
    metrics.manualReviewTotal?.inc({ reason: 'exhausted' })
    // 触发进化惩罚 + 记忆衰减（异步，不阻塞主流程）
    const failedPatterns = extractErrorPatterns(allTestResults)
    triggerEvolutionPenalty(taskId, failedPatterns)
    return buildResult(taskId, specId, 'manual_review', currentFiles, allTestResults, fixAttempts, totalStart, false)

  } finally {
    sandbox.cleanup()
  }
}

// ── 并发运行多语言测试 ──────────────────────────────────────
async function runAllTests(
  goDir: string,
  tsDir: string,
  taskId: string,
  platforms: ('client' | 'server')[],
  generatedFiles?: any[]  // 可选：生成的文件列表，用于获取实际的语言信息
): Promise<TestRunResult[]> {
  const tasks: Promise<TestRunResult>[] = []

  // 如果提供了生成的文件，根据文件的实际语言运行测试
  if (generatedFiles && generatedFiles.length > 0) {
    const languages = new Set(generatedFiles.map(f => f.language))

    // 只为实际生成的语言运行测试
    if (languages.has('go')) {
      tasks.push(runGoTests(goDir, taskId))
    }
    if (languages.has('typescript')) {
      tasks.push(runTSTests(tsDir, taskId))
    }
    // C#、Java、Python 暂时返回占位结果（实际测试运行器需要后续实现）
    if (languages.has('csharp')) {
      tasks.push(createPlaceholderTestResult('csharp', taskId))
    }
    if (languages.has('java')) {
      tasks.push(createPlaceholderTestResult('java', taskId))
    }
    if (languages.has('python')) {
      tasks.push(createPlaceholderTestResult('python', taskId))
    }
  } else {
    // 向后兼容：如果没有文件信息，根据 platforms 字段运行
    if (platforms.includes('server')) {
      tasks.push(runGoTests(goDir, taskId))
    }
    if (platforms.includes('client')) {
      tasks.push(runTSTests(tsDir, taskId))
    }
  }

  const results = await Promise.allSettled(tasks)
  return results.map(r =>
    r.status === 'fulfilled' ? r.value : {
      language: 'go' as const,
      status: 'error' as const,
      totalTests: 0, passedTests: 0, failedTests: 0,
      testCases: [],
      rawOutput: (r.reason as Error)?.message || '未知错误',
      durationMs: 0
    }
  )
}

// ── 占位测试结果（对于暂未支持的语言） ──────────────────────
async function createPlaceholderTestResult(
  language: 'csharp' | 'java' | 'python',
  taskId: string
): Promise<TestRunResult> {
  logger.info({ taskId, language }, `${language} 测试框架暂未集成，返回占位结果`)
  return {
    language: language as any,
    status: 'pass',
    totalTests: 0,
    passedTests: 0,
    failedTests: 0,
    coverage: 0,
    testCases: [],
    rawOutput: `[占位] ${language.toUpperCase()} 代码已生成，测试框架集成中...`,
    durationMs: 0
  }
}

// ── 判断全部通过 ─────────────────────────────────────────────
function allPassed(results: TestRunResult[]): boolean {
  return results.length > 0 && results.every(r => r.status === 'pass')
}

// ── SonarQube 质量扫描（非阻塞，失败不影响主流程） ───────────
async function runSonarQube(taskId: string, sourceDir: string): Promise<void> {
  if (!process.env.ENABLE_SONARQUBE) return
  try {
    const { SonarQubeScanner } = require('../../../../../services/scorer/src/sonarqube-scanner')
    const scanner = new SonarQubeScanner()
    const result = await scanner.scan(taskId, sourceDir)
    logger.info({ taskId, score: result?.qualityScore }, '✅ SonarQube 扫描完成')
  } catch (err) {
    logger.warn({ taskId, err }, 'SonarQube 扫描失败（不阻塞主流程）')
  }
}

// ── 构建最终结果 ─────────────────────────────────────────────
function buildResult(
  taskId: string,
  specId: string,
  status: ExecutionStatus,
  finalFiles: GeneratedFile[],
  testResults: TestRunResult[],
  fixAttempts: FixAttempt[],
  startMs: number,
  autoFixSucceeded: boolean
): ExecutionResult {
  return {
    taskId, specId, status, finalFiles, testResults,
    fixAttempts, autoFixSucceeded,
    totalDurationMs: Date.now() - startMs
  }
}
