#!/usr/bin/env node
/**
 * services/scorer/src/sonarqube-scanner.js
 *
 * SonarQube 质量扫描：
 *   1. 把生成的代码写到临时目录
 *   2. 运行 sonar-scanner CLI
 *   3. 轮询结果直到分析完成
 *   4. 返回标准化质量指标
 *
 * 环境变量：
 *   SONARQUBE_URL=http://localhost:9000
 *   SONARQUBE_TOKEN=sqa_xxx
 */

'use strict'

const fs     = require('fs')
const path   = require('path')
const os     = require('os')
const http   = require('http')
const https  = require('https')
const cp     = require('child_process')

const SONAR_URL   = process.env.SONARQUBE_URL   || 'http://localhost:9000'
const SONAR_TOKEN = process.env.SONARQUBE_TOKEN || ''
const ENABLED     = !!SONAR_TOKEN && process.env.ENABLE_SONARQUBE === 'true'

// ── SonarQube HTTP 请求 ───────────────────────────────────────
function sonarRequest(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const url    = new URL(urlPath, SONAR_URL)
    const isHttps = url.protocol === 'https:'
    const lib    = isHttps ? https : http

    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname + url.search,
      method:   opts.method || 'GET',
      headers: {
        'Authorization': `Bearer ${SONAR_TOKEN}`,
        'Content-Type': 'application/json',
      }
    }, res => {
      let raw = ''
      res.on('data', d => raw += d)
      res.on('end', () => {
        try { resolve(JSON.parse(raw)) }
        catch { resolve({ raw }) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// ── 主扫描流程 ────────────────────────────────────────────────
async function scanCode(taskId, files) {
  if (!ENABLED) {
    console.log('[SonarQube] 未启用，跳过质量扫描（设置 ENABLE_SONARQUBE=true + SONARQUBE_TOKEN 启用）')
    return buildDefaultScore()
  }

  const projectKey = `awp-task-${taskId}`
  const scanDir    = fs.mkdtempSync(path.join(os.tmpdir(), `sonar-${taskId.slice(0,8)}-`))

  try {
    // 1. 写入代码文件
    for (const file of files) {
      const dest = path.join(scanDir, file.path)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, file.content, 'utf8')
    }

    // 2. 写 sonar-project.properties
    const goFiles = files.filter(f => f.language === 'go')
    const tsFiles = files.filter(f => f.language === 'typescript')
    const sources = [...new Set(files.map(f => path.dirname(f.path)))].join(',')

    fs.writeFileSync(path.join(scanDir, 'sonar-project.properties'), [
      `sonar.projectKey=${projectKey}`,
      `sonar.projectName=AWP Task ${taskId.slice(0, 8)}`,
      `sonar.sources=${sources || '.'}`,
      `sonar.host.url=${SONAR_URL}`,
      `sonar.login=${SONAR_TOKEN}`,
      goFiles.length > 0 ? 'sonar.language=go' : '',
      tsFiles.length > 0 ? 'sonar.typescript.tsconfigPath=tsconfig.json' : '',
      'sonar.scm.disabled=true',
      'sonar.sourceEncoding=UTF-8',
    ].filter(Boolean).join('\n'))

    // 3. 运行扫描（如果 sonar-scanner CLI 可用）
    const hasCli = cp.spawnSync('which', ['sonar-scanner']).status === 0
    if (!hasCli) {
      console.warn('[SonarQube] sonar-scanner CLI 未安装，使用 API 估算')
      return await estimateFromAPI(projectKey)
    }

    await new Promise((resolve, reject) => {
      const proc = cp.spawn('sonar-scanner', [], { cwd: scanDir, stdio: 'pipe' })
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`sonar-scanner 退出码: ${code}`)))
      proc.on('error', reject)
    })

    // 4. 等待分析完成并获取结果
    return await pollResults(projectKey)

  } finally {
    try { fs.rmSync(scanDir, { recursive: true, force: true }) } catch {}
  }
}

// ── 轮询等待 SonarQube 分析完成（最多 60s） ──────────────────
async function pollResults(projectKey, maxWaitMs = 60000) {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    await sleep(3000)
    try {
      const status = await sonarRequest(
        `/api/ce/component?component=${encodeURIComponent(projectKey)}`
      )
      if (status.current?.status === 'SUCCESS') {
        return await fetchMetrics(projectKey)
      }
      if (status.current?.status === 'FAILED') {
        console.warn('[SonarQube] 分析失败')
        return buildDefaultScore()
      }
    } catch { /* 继续轮询 */ }
  }
  console.warn('[SonarQube] 等待超时')
  return buildDefaultScore()
}

async function fetchMetrics(projectKey) {
  const metrics = 'bugs,vulnerabilities,code_smells,coverage,duplicated_lines_density,sqale_index,cognitive_complexity'
  const result  = await sonarRequest(
    `/api/measures/component?component=${encodeURIComponent(projectKey)}&metricKeys=${metrics}`
  )

  const measures = {}
  for (const m of result.component?.measures || []) {
    measures[m.metric] = parseFloat(m.value) || 0
  }

  // 归一化为 0-100 质量分
  const bugs        = measures.bugs || 0
  const smells      = measures.code_smells || 0
  const coverage    = measures.coverage || 0
  const duplicates  = measures.duplicated_lines_density || 0
  const complexity  = measures.cognitive_complexity || 0

  // 质量分公式：基础 100，按缺陷数量扣分
  const quality = Math.max(0, Math.min(100,
    100
    - bugs * 10
    - Math.min(smells, 20) * 2
    - Math.max(0, duplicates - 5) * 1.5
    - Math.max(0, complexity - 20) * 0.5
  ))

  return {
    quality:      Math.round(quality),
    coverage:     Math.round(coverage),
    bugs,
    codeSmells:   smells,
    duplications: Math.round(duplicates),
    complexity:   Math.round(complexity),
    source:       'sonarqube'
  }
}

async function estimateFromAPI(projectKey) {
  // SonarQube 已有历史数据时，直接读取（不重新扫描）
  try {
    return await fetchMetrics(projectKey)
  } catch {
    return buildDefaultScore()
  }
}

function buildDefaultScore() {
  return { quality: 70, coverage: 0, bugs: 0, codeSmells: 0, duplications: 0, complexity: 0, source: 'default' }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

module.exports = { scanCode }
