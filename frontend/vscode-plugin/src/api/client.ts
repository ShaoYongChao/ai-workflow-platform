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

  // ── 提交决策（关键操作，启用自动重试） ─────────────────
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
      body: { decision, developerId, ...extra },
      retries: 3,     // P0: 关键操作自动重试 3 次
      retryDelay: 500 // 指数退避的初始延迟（ms）
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

  // ── 通用请求（支持自动重试） ───────────────────────────
  private request<T = any>(
    path: string,
    opts: { method?: string; body?: any; timeout?: number; retries?: number; retryDelay?: number } = {}
  ): Promise<T> {
    const { retries = 0, retryDelay = 500 } = opts

    const doRequest = async (attempt: number): Promise<T> => {
      try {
        return await new Promise<T>((resolve, reject) => {
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
                const err = new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`)
                reject(err)
                return
              }
              try {
                resolve(raw ? JSON.parse(raw) : ({} as T))
              } catch (err) {
                reject(new Error(`响应解析失败: ${(err as Error).message}`))
              }
            })
          })

          req.on('error', (err) => reject(err))
          req.on('timeout', () => {
            req.destroy()
            reject(new Error('请求超时'))
          })
          if (body) req.write(body)
          req.end()
        })
      } catch (err) {
        // 重试逻辑：遇到网络错误或超时时重试
        const errMsg = (err as Error).message
        const isRetryable = errMsg.includes('超时') ||
                           errMsg.includes('ECONNREFUSED') ||
                           errMsg.includes('ECONNRESET') ||
                           errMsg.includes('EHOSTUNREACH') ||
                           errMsg.includes('ETIMEDOUT')

        if (isRetryable && attempt < retries) {
          // 指数退避：delay * 2^(attempt-1)
          const backoffMs = retryDelay * Math.pow(2, attempt - 1)
          await new Promise(resolve => setTimeout(resolve, backoffMs))
          return doRequest(attempt + 1)
        }
        throw err
      }
    }

    return doRequest(0)
  }
}
