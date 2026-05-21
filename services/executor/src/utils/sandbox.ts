import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { GeneratedFile } from '../schemas/types'
import { logger } from './logger'

const execFileAsync = promisify(execFile)

export interface Sandbox {
  dir: string        // 沙箱根目录
  goDir: string      // Go 模块根目录
  tsDir: string      // TS 项目根目录
  csharpDir: string  // C# 项目根目录（Phase 4.3）
  javaDir: string    // Java 项目根目录（Phase 4.3）
  pythonDir: string  // Python 项目根目录（Phase 4.3）
  cleanup: () => void
}

const SANDBOX_TIMEOUT = parseInt(process.env.SANDBOX_TIMEOUT_SECONDS || '60') * 1000

// ── 创建沙箱目录，写入文件，初始化项目 ─────────────────────
export async function createSandbox(
  taskId: string,
  files: GeneratedFile[]
): Promise<Sandbox> {
  const dir       = fs.mkdtempSync(path.join(os.tmpdir(), `awp-${taskId.slice(0, 8)}-`))
  const goDir     = path.join(dir, 'go')
  const tsDir     = path.join(dir, 'ts')
  const csharpDir = path.join(dir, 'csharp')
  const javaDir   = path.join(dir, 'java')
  const pythonDir = path.join(dir, 'python')

  // 创建所有必要的目录
  fs.mkdirSync(goDir, { recursive: true })
  fs.mkdirSync(tsDir, { recursive: true })
  fs.mkdirSync(csharpDir, { recursive: true })
  fs.mkdirSync(javaDir, { recursive: true })
  fs.mkdirSync(pythonDir, { recursive: true })

  logger.info({ taskId, dir }, '沙箱目录已创建')

  const goFiles = files.filter(f => f.language === 'go')
  const tsFiles = files.filter(f => f.language === 'typescript')
  const csharpFiles = files.filter(f => f.language === 'csharp')
  const javaFiles = files.filter(f => f.language === 'java')
  const pythonFiles = files.filter(f => f.language === 'python')

  // 写入 Go 文件
  for (const file of goFiles) {
    const dest = path.join(goDir, file.path)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, file.content, 'utf8')
  }

  // 写入 TS 文件
  for (const file of tsFiles) {
    const dest = path.join(tsDir, file.path)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, file.content, 'utf8')
  }

  // 写入 C# 文件（Phase 4.3）
  for (const file of csharpFiles) {
    const dest = path.join(csharpDir, file.path)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, file.content, 'utf8')
  }

  // 写入 Java 文件（Phase 4.3）
  for (const file of javaFiles) {
    const dest = path.join(javaDir, file.path)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, file.content, 'utf8')
  }

  // 写入 Python 文件（Phase 4.3）
  for (const file of pythonFiles) {
    const dest = path.join(pythonDir, file.path)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, file.content, 'utf8')
  }

  // 初始化 Go module（如果有 Go 文件）
  if (goFiles.length > 0) {
    await initGoModule(goDir, taskId, goFiles)
  }

  // 初始化 TS 项目（如果有 TS 文件）
  if (tsFiles.length > 0) {
    await initTSProject(tsDir, tsFiles)
  }

  logger.info({
    taskId,
    goFiles: goFiles.length,
    tsFiles: tsFiles.length,
    csharpFiles: csharpFiles.length,
    javaFiles: javaFiles.length,
    pythonFiles: pythonFiles.length
  }, '沙箱文件写入完成')

  return {
    dir, goDir, tsDir, csharpDir, javaDir, pythonDir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
        logger.info({ taskId, dir }, '沙箱已清理')
      } catch (e) {
        logger.warn({ e }, '沙箱清理失败')
      }
    }
  }
}

// ── 扫描 Go 文件提取第三方导入包 ────────────────────────────
function detectGoImports(files: GeneratedFile[]): string[] {
  const pkgs = new Set<string>()
  // 标准库前缀（不需要 go get）
  const stdPrefixes = ['fmt', 'os', 'io', 'net', 'http', 'context', 'sync', 'time',
    'math', 'sort', 'strings', 'strconv', 'bytes', 'bufio', 'log', 'errors',
    'encoding', 'regexp', 'path', 'runtime', 'reflect', 'unicode', 'testing']

  for (const file of files) {
    if (file.language !== 'go') continue
    // 匹配 import "..." 和 import ( "..." )
    const matches = [...file.content.matchAll(/^\s*"([\w./-]+)"/gm)]
    for (const m of matches) {
      const imp = m[1]
      const firstPart = imp.split('/')[0]
      if (stdPrefixes.includes(firstPart)) continue
      if (!imp.includes('.')) continue  // 纯标准库如 "fmt"
      // 取模块路径（前3段: github.com/org/repo 或 go.xxx.io/pkg）
      const parts = imp.split('/')
      const modPath = parts.length >= 3 ? parts.slice(0, 3).join('/') : imp
      pkgs.add(modPath)
    }
  }
  return Array.from(pkgs)
}

// ── 初始化 Go module ────────────────────────────────────────
async function initGoModule(goDir: string, taskId: string, files: GeneratedFile[]) {
  const modName = `awp-sandbox-${taskId.slice(0, 8)}`

  // 检测生成代码使用的第三方包
  const detectedPkgs = detectGoImports(files)
  logger.info({ taskId, detectedPkgs }, 'Go 检测到第三方包')

  // 已知包及版本（覆盖最常用的游戏/服务端库）
  const knownVersions: Record<string, string> = {
    'github.com/stretchr/testify': 'v1.8.4',
    'go.uber.org/zap':             'v1.26.0',
    'github.com/gin-gonic/gin':    'v1.9.1',
    'gorm.io/gorm':                'v1.25.5',
    'gorm.io/driver/postgres':     'v1.5.4',
    'gorm.io/driver/mysql':        'v1.5.4',
    'github.com/go-redis/redis':   'v6.15.9+incompatible',
    'github.com/redis/go-redis':   'v9.3.0',
    'github.com/google/uuid':      'v1.4.0',
    'github.com/pkg/errors':       'v0.9.1',
    'golang.org/x/crypto':         'v0.17.0',
    'github.com/spf13/viper':      'v1.18.2',
    'github.com/gorilla/websocket':'v1.5.1',
    'github.com/golang-jwt/jwt':   'v3.2.2+incompatible',
  }

  // 构建 require 列表（已知包 + 始终包含 testify/zap）
  const requires: Record<string, string> = {
    'github.com/stretchr/testify': 'v1.8.4',
    'go.uber.org/zap':             'v1.26.0',
  }
  for (const pkg of detectedPkgs) {
    if (knownVersions[pkg] && !requires[pkg]) {
      requires[pkg] = knownVersions[pkg]
    }
  }

  const requireLines = Object.entries(requires)
    .map(([k, v]) => `\t${k} ${v}`)
    .join('\n')

  fs.writeFileSync(path.join(goDir, 'go.mod'), `module ${modName}

go 1.21

require (
${requireLines}
)
`)
  fs.writeFileSync(path.join(goDir, 'go.sum'), '')

  // 尝试 go mod download（允许失败，失败时依赖 go test -mod=mod 在线下载）
  try {
    await execFileAsync('go', ['mod', 'download', '-x'], {
      cwd: goDir,
      timeout: 90000,
      env: {
        ...process.env,
        GONOSUMCHECK: '*',
        GONOSUMDB: '*',
        GOFLAGS: '-mod=mod',
        GOPROXY: process.env.GOPROXY || 'https://proxy.golang.org,direct',
      }
    })
    logger.info({ taskId }, 'go mod download 完成')
  } catch (err: any) {
    logger.warn({ taskId, err: err.message?.slice(0, 200) }, 'go mod download 失败，将在 go test 时重试')
  }
}

// ── 扫描 TS 文件提取外部 npm 包 ─────────────────────────────
function detectTSPackages(files: GeneratedFile[]): Record<string, string> {
  // 已知包及版本
  const versionMap: Record<string, string> = {
    'axios':               '^1.6.0',
    'ioredis':             '^5.3.2',
    'redis':               '^4.6.10',
    'express':             '^4.18.2',
    '@types/express':      '^4.17.21',
    'fastify':             '^4.24.3',
    'zod':                 '^3.22.4',
    'dayjs':               '^1.11.10',
    'uuid':                '^9.0.0',
    '@types/uuid':         '^9.0.7',
    'lodash':              '^4.17.21',
    '@types/lodash':       '^4.14.202',
    'ws':                  '^8.16.0',
    '@types/ws':           '^8.5.10',
    'protobufjs':          '^7.2.5',
    'pg':                  '^8.11.3',
    '@types/pg':           '^8.10.9',
    'mysql2':              '^3.6.5',
    'socket.io':           '^4.6.1',
    'socket.io-client':    '^4.6.1',
    '@nestjs/common':      '^10.0.0',
    'class-validator':     '^0.14.1',
    'class-transformer':   '^0.5.1',
    'reflect-metadata':    '^0.1.13',
    'typeorm':             '^0.3.17',
    'mongoose':            '^8.0.0',
    'bcrypt':              '^5.1.1',
    '@types/bcrypt':       '^5.0.2',
    'jsonwebtoken':        '^9.0.2',
    '@types/jsonwebtoken': '^9.0.5',
    'dotenv':              '^16.3.1',
    'joi':                 '^17.11.0',
  }

  const found: Record<string, string> = {}
  const builtins = new Set([
    'fs', 'path', 'http', 'https', 'crypto', 'os', 'util', 'stream', 'events',
    'net', 'url', 'querystring', 'zlib', 'assert', 'buffer', 'child_process',
    'readline', 'string_decoder', 'timers', 'tty', 'worker_threads', 'vm',
    'v8', 'module', 'domain', 'cluster', 'dgram', 'dns', 'perf_hooks',
  ])

  for (const file of files) {
    if (file.language !== 'typescript') continue
    // 匹配 import ... from '...' 和 require('...')
    const patterns = [
      /^import\s+.*?from\s+['"]([^.\/][^'"]*)['"]/gm,
      /require\s*\(\s*['"]([^.\/][^'"]*)['"]\s*\)/g,
    ]
    for (const pattern of patterns) {
      const matches = [...file.content.matchAll(pattern)]
      for (const m of matches) {
        const raw = m[1]
        const pkg = raw.startsWith('@')
          ? raw.split('/').slice(0, 2).join('/')
          : raw.split('/')[0]
        if (builtins.has(pkg)) continue
        if (versionMap[pkg] && !found[pkg]) {
          found[pkg] = versionMap[pkg]
        }
      }
    }
  }
  return found
}

// ── 初始化 TS 项目 ──────────────────────────────────────────
async function initTSProject(tsDir: string, files: GeneratedFile[]) {
  const detectedDeps = detectTSPackages(files)
  logger.info({ tsDir, deps: Object.keys(detectedDeps) }, 'TS 检测到外部依赖')

  // jest.config.json
  fs.writeFileSync(
    path.join(tsDir, 'jest.config.json'),
    JSON.stringify({
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['**/*.test.ts'],
      collectCoverage: true,
      coverageReporters: ['json-summary', 'text'],
      // 让 jest 能解析 @/* 路径别名
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/$1',
        '^~/(.*)$': '<rootDir>/$1',
      },
      // ts-jest 宽松模式，跳过类型检查提速
      globals: {
        'ts-jest': {
          diagnostics: false,
          tsconfig: { strict: false, esModuleInterop: true }
        }
      },
      // 自动 mock 数据库/Redis 调用，避免需要真实连接
      setupFiles: [],
    }, null, 2)
  )

  // tsconfig.json（宽松配置）
  fs.writeFileSync(
    path.join(tsDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2020',
        module: 'commonjs',
        strict: false,
        esModuleInterop: true,
        skipLibCheck: true,
        allowSyntheticDefaultImports: true,
        outDir: './dist',
        baseUrl: '.',
        paths: { '@/*': ['./*'], '~/*': ['./*'] }
      }
    }, null, 2)
  )

  // package.json（包含检测到的依赖 + 基础 devDeps）
  fs.writeFileSync(
    path.join(tsDir, 'package.json'),
    JSON.stringify({
      name: 'awp-sandbox',
      version: '1.0.0',
      scripts: { test: 'jest' },
      // 将检测到的业务依赖放在 dependencies（运行时需要）
      dependencies: detectedDeps,
      devDependencies: {
        'typescript':   '^5.3.2',
        'ts-jest':      '^29.1.1',
        'jest':         '^29.7.0',
        '@types/jest':  '^29.5.8',
        '@types/node':  '^20.10.0',
      }
    }, null, 2)
  )
}

// ── 更新沙箱中的文件（Auto-Fix 后替换） ─────────────────────
export function updateSandboxFiles(sandbox: Sandbox, files: GeneratedFile[]) {
  for (const file of files) {
    let baseDir: string
    switch (file.language) {
      case 'go':
        baseDir = sandbox.goDir
        break
      case 'typescript':
        baseDir = sandbox.tsDir
        break
      case 'csharp':
        baseDir = sandbox.csharpDir
        break
      case 'java':
        baseDir = sandbox.javaDir
        break
      case 'python':
        baseDir = sandbox.pythonDir
        break
      default:
        baseDir = sandbox.tsDir  // 默认 TypeScript
    }
    const dest = path.join(baseDir, file.path)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, file.content, 'utf8')
  }
}

export { SANDBOX_TIMEOUT }
