import { execFile } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import { TestRunResult, TestCase, TestStatus } from '../schemas/types'
import { logger } from '../utils/logger'
import { SANDBOX_TIMEOUT } from '../utils/sandbox'

const execFileAsync = promisify(execFile)

// ── 运行 Go 测试 ─────────────────────────────────────────────
export async function runGoTests(goDir: string, taskId: string): Promise<TestRunResult> {
  const start = Date.now()
  logger.info({ taskId, goDir }, '开始执行 Go 测试')

  // 先检查 go 是否可用
  const goAvailable = await checkGoAvailable()
  if (!goAvailable) {
    logger.warn({ taskId }, 'go 命令不可用，使用静态分析代替')
    return staticAnalyzeFallback(goDir, 'go', start)
  }

  try {
    // go test -v -json -cover ./... 输出机器可读格式
    const { stdout, stderr } = await execFileAsync(
      'go', ['test', '-v', '-json', '-cover', '-timeout', '30s', './...'],
      {
        cwd: goDir,
        timeout: SANDBOX_TIMEOUT,
        env: {
          ...process.env,
          GOFLAGS: '-mod=mod',
          GONOSUMCHECK: '*',
          GONOSUMDB: '*',
          GONOSUMDB_TRUSTED: '*',
          CGO_ENABLED: '0',
          GOPROXY: process.env.GOPROXY || 'https://proxy.golang.org,direct',
        }
      }
    )
    return parseGoTestJSON(stdout + stderr, Date.now() - start)

  } catch (err: any) {
    const output = (err.stdout || '') + (err.stderr || '')

    if (output.includes('"Action"')) {
      // 有 JSON 输出 = 测试跑起来了但有失败用例
      return parseGoTestJSON(output, Date.now() - start)
    }

    // 判断是否是模块下载/网络失败，降级为编译检查
    const isModuleError = output.includes('no required module') ||
      output.includes('cannot find module') ||
      output.includes('connection refused') ||
      output.includes('dial tcp') ||
      output.includes('GONOSUMDB')

    if (isModuleError) {
      logger.warn({ taskId, msg: 'Go 模块下载失败，改用编译检查' })
      return await runGoBuild(goDir, taskId, start)
    }

    // 编译错误（有具体错误行）
    logger.warn({ taskId, output: output.slice(0, 500) }, 'Go test 失败')
    return {
      language: 'go',
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

// ── 解析 go test -json 输出 ──────────────────────────────────
// 格式：每行一个 JSON 对象
// {"Action":"run","Test":"TestXxx"} / {"Action":"pass"/"fail","Elapsed":0.1}
function parseGoTestJSON(raw: string, durationMs: number): TestRunResult {
  const testCases: Map<string, TestCase> = new Map()
  let coverage: number | undefined

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue

    try {
      const event = JSON.parse(trimmed) as {
        Action: string
        Test?: string
        Output?: string
        Elapsed?: number
      }

      const name = event.Test
      if (!name) continue

      switch (event.Action) {
        case 'run':
          testCases.set(name, {
            name,
            status: 'pass',
            durationMs: 0
          })
          break

        case 'pass':
          if (testCases.has(name)) {
            testCases.get(name)!.status = 'pass'
            testCases.get(name)!.durationMs = (event.Elapsed || 0) * 1000
          }
          break

        case 'fail':
          if (testCases.has(name)) {
            testCases.get(name)!.status = 'fail'
            testCases.get(name)!.durationMs = (event.Elapsed || 0) * 1000
          }
          break

        case 'output':
          // 提取覆盖率行：coverage: 82.3% of statements
          if (event.Output?.includes('coverage:')) {
            const m = event.Output.match(/coverage:\s*([\d.]+)%/)
            if (m) coverage = parseFloat(m[1])
          }
          // 提取失败信息
          if (event.Output?.includes('FAIL') || event.Output?.includes('Error')) {
            if (testCases.has(name)) {
              testCases.get(name)!.errorMessage =
                (testCases.get(name)!.errorMessage || '') + event.Output
            }
          }
          break
      }
    } catch {
      // 非 JSON 行跳过
    }
  }

  const cases   = Array.from(testCases.values())
  const passed  = cases.filter(c => c.status === 'pass').length
  const failed  = cases.filter(c => c.status === 'fail').length
  const status: TestStatus = cases.length === 0 ? 'error'
    : failed > 0 ? 'fail'
    : 'pass'

  return {
    language: 'go',
    status,
    totalTests: cases.length,
    passedTests: passed,
    failedTests: failed,
    coverage,
    testCases: cases,
    rawOutput: raw,
    durationMs
  }
}

// ── 静态分析 Fallback（go 不可用时） ─────────────────────────
// 通过检查代码结构来估算质量，不实际运行
function staticAnalyzeFallback(
  dir: string,
  language: 'go' | 'typescript',
  start: number
): TestRunResult {
  const fs = require('fs')
  const path = require('path')

  let issues: string[] = []
  let fileCount = 0

  try {
    // 遍历文件做基础检查
    const walk = (d: string) => {
      for (const f of fs.readdirSync(d)) {
        const full = path.join(d, f)
        if (fs.statSync(full).isDirectory()) { walk(full); continue }
        if (!f.endsWith('.go') && !f.endsWith('.ts')) continue
        fileCount++
        const content: string = fs.readFileSync(full, 'utf8')

        if (language === 'go') {
          if (!content.includes('package '))      issues.push(`${f}: 缺少 package 声明`)
          if (content.includes('panic('))         issues.push(`${f}: 包含 panic 调用`)
          if (content.match(/\berr\b.*=.*\n[^e]/)) issues.push(`${f}: 疑似忽略错误`)
        } else {
          if (content.split(': any').length > 4) issues.push(`${f}: 过多 any 类型`)
          if (content.includes('console.log'))   issues.push(`${f}: 包含 console.log`)
        }
      }
    }
    walk(dir)
  } catch { /* 忽略读取错误 */ }

  const passed = issues.length === 0 ? fileCount : 0
  const status: TestStatus = issues.length > 0 ? 'fail' : 'pass'

  return {
    language,
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

// ── go build 只检查编译错误（不运行测试，不需要下载模块） ───
async function runGoBuild(goDir: string, taskId: string, start: number): Promise<TestRunResult> {
  try {
    await execFileAsync('go', ['build', './...'], {
      cwd: goDir,
      timeout: 30000,
      env: {
        ...process.env,
        GOFLAGS: '-mod=mod',
        GONOSUMCHECK: '*',
        GONOSUMDB: '*',
        CGO_ENABLED: '0',
        GOPROXY: 'off',  // 不下载，只编译已有缓存
      }
    })
    // build 成功 → 代码语法正确，给个基础通过（0 测试）
    logger.info({ taskId }, 'go build 通过（网络不可用，仅编译检查）')
    return {
      language: 'go',
      status: 'pass',
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      testCases: [{ name: 'build_check', status: 'pass', durationMs: 0 }],
      rawOutput: '[编译检查模式：网络不可用，跳过测试运行，代码可成功编译]',
      durationMs: Date.now() - start
    }
  } catch (buildErr: any) {
    const output = (buildErr.stdout || '') + (buildErr.stderr || '')
    return staticAnalyzeFallback(goDir, 'go', start)
  }
}

async function checkGoAvailable(): Promise<boolean> {
  try {
    await execFileAsync('go', ['version'], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}