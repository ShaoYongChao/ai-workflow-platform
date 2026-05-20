import * as http from 'http'
import * as https from 'https'
import { URL } from 'url'
import * as vscode from 'vscode'
import { TaskSummary, TaskResult, TaskStats, SpecItem, TriggerGenerationResult } from './types'

export class ExecutorClient {
  constructor(private getBaseUrl: () => string) {}

  // ── 任务列表 ─────────────────────────────────────────────
  async listTasks(filters: { status?: string; limit?: number } = {}): Promise<{ total: number; items: TaskSummary[] }> {
    const qs = new URLSearchParams()
    if (filters.status) qs.set('status', filters.status)
    if (filters.limit)  qs.set('limit',  String(filters.limit))
    const qsStr = qs.toString()
    return this.request<{ total: number; items: TaskSummary[] }>(`/api/v1/tasks${qsStr ? '?' + qsStr : ''}`)
  }

  // ── 任务详情 ─────────────────────────────────────────────
  async getResult(taskId: string): Promise<TaskResult> {
    return this.request<TaskResult>(`/api/v1/tasks/${taskId}/result`)
  }

  // ── 任务文件 ─────────────────────────────────────────────
  async getFiles(taskId: string) {
    return this.request<{ taskId: string; status: string; files: any[] }>(`/api/v1/tasks/${taskId}/files`)
  }

  // ── 提交决策 ─────────────────────────────────────────────
  async submitDecision(
    taskId: string,
    decision: 'accept' | 'reject' | 'partial_accept',
    extra: { feedback?: string; humanScore?: number; acceptedFiles?: string[] } = {}
  ) {
    const developerId = vscode.workspace.getConfiguration('awp').get<string>('developerId')
      || process.env.USER
      || 'anonymous'

    return this.request<{ success: boolean; status: string }>(`/api/v1/tasks/${taskId}/decision`, {
      method: 'POST',
      body: { decision, developerId, ...extra }
    })
  }

  // ── 统计 ─────────────────────────────────────────────────
  async getStats(): Promise<TaskStats> {
    return this.request<TaskStats>('/api/v1/tasks/stats/summary')
  }

  // ── Spec 列表（手动触发生成用） ──────────────────────────
  async listSpecs(filters: { status?: string; projectId?: string; limit?: number } = {}): Promise<{ total: number; items: SpecItem[] }> {
    const qs = new URLSearchParams()
    if (filters.status)    qs.set('status',     filters.status)
    if (filters.projectId) qs.set('project_id', filters.projectId)
    if (filters.limit)     qs.set('limit',      String(filters.limit))
    const qsStr = qs.toString()
    return this.request<{ total: number; items: SpecItem[] }>(`/api/v1/specs${qsStr ? '?' + qsStr : ''}`)
  }

  // ── 手动触发某个 Spec 的代码生成 ─────────────────────────
  async triggerGeneration(specId: string): Promise<TriggerGenerationResult> {
    return this.request<TriggerGenerationResult>(`/api/v1/specs/${specId}/generate`, { method: 'POST', body: {} })
  }

  // ── 健康检查 ─────────────────────────────────────────────
  async ping(): Promise<boolean> {
    try {
      await this.request('/health', { timeout: 3000 })
      return true
    } catch {
      return false
    }
  }

  // ── 通用请求 ─────────────────────────────────────────────
  private request<T = any>(
    path: string,
    opts: { method?: string; body?: any; timeout?: number } = {}
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const url    = new URL(path, this.getBaseUrl())
      const isHttps = url.protocol === 'https:'
      const lib    = isHttps ? https : http
      const body   = opts.body ? JSON.stringify(opts.body) : undefined

      const req = lib.request({
        hostname: url.hostname,
        port:     url.port || (isHttps ? 443 : 80),
        path:     url.pathname + url.search,
        method:   opts.method || 'GET',
        timeout:  opts.timeout || 10000,
        headers: {
          'Content-Type': 'application/json',
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
        }
      }, (res: import('http').IncomingMessage) => {
        let raw = ''
        res.on('data', (d: Buffer) => raw += d)
        res.on('end', () => {
          if ((res.statusCode || 0) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`))
            return
          }
          try {
            resolve(raw ? JSON.parse(raw) : ({} as T))
          } catch (err) {
            reject(new Error(`响应解析失败: ${(err as Error).message}`))
          }
        })
      })

      req.on('error',   reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')) })
      if (body) req.write(body)
      req.end()
    })
  }
}
