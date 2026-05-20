import * as vscode from 'vscode'
import WebSocket from 'ws'
// 类型引用：ws 包导出的 RawData 类型
import type { RawData as WSRawData } from 'ws'
import { WSMessage } from './types'

// ============================================================
// WebSocket 客户端
//   - 自动重连（指数退避，1s → 30s 上限）
//   - 心跳保活（30s ping/pong）
//   - 任务订阅管理（断线重连后自动重订阅）
//   - 消息分发（onMessage / onTaskUpdate 等）
// ============================================================

type Listener = (msg: WSMessage) => void

const HEARTBEAT_INTERVAL_MS  = 30_000
const RECONNECT_INITIAL_MS   = 1_000
const RECONNECT_MAX_MS       = 30_000
const CONNECT_TIMEOUT_MS     = 10_000

interface FullMessage {
  type: string
  taskId?: string
  [key: string]: any
}

export class WSClient {
  private ws: WebSocket | null = null
  private listeners: Listener[] = []
  private globalListeners: Array<(msg: FullMessage) => void> = []
  private subscribedTaskIds = new Set<string>()
  private reconnectDelay   = RECONNECT_INITIAL_MS
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout>  | null = null
  private intentionallyClosed = false
  private outputChannel: vscode.OutputChannel

  constructor(private readonly getBaseUrl: () => string) {
    this.outputChannel = vscode.window.createOutputChannel('AWP WebSocket')
  }

  // ── 连接 ──────────────────────────────────────────────────
  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }
    this.intentionallyClosed = false

    const httpUrl = this.getBaseUrl()
    const wsUrl   = httpUrl.replace(/^http/, 'ws') + '/ws/tasks'
    this.log(`连接 ${wsUrl}`)

    try {
      this.ws = new WebSocket(wsUrl, {
        handshakeTimeout: CONNECT_TIMEOUT_MS,
        headers: { 'x-client-id': `vscode-${process.env.USER || 'anon'}` }
      })
    } catch (err) {
      this.log(`创建 WebSocket 失败: ${(err as Error).message}`)
      this.scheduleReconnect()
      return
    }

    this.ws.on('open', () => {
      this.log('✅ 已连接')
      this.reconnectDelay = RECONNECT_INITIAL_MS
      this.startHeartbeat()
      // 重连后重新订阅之前订阅的任务
      for (const taskId of this.subscribedTaskIds) {
        this.sendRaw({ type: 'subscribe', taskId })
      }
    })

    this.ws.on('message', (data: WSRawData) => this.handleMessage(data.toString()))

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.log(`连接关闭 code=${code} reason=${reason?.toString() || '(none)'}`)
      this.stopHeartbeat()
      this.ws = null
      if (!this.intentionallyClosed) this.scheduleReconnect()
    })

    this.ws.on('error', (err: Error) => {
      this.log(`错误: ${err.message}`)
      // close 会随后触发，不在这里重连
    })
  }

  // ── 主动断开 ──────────────────────────────────────────────
  disconnect(): void {
    this.intentionallyClosed = true
    this.stopHeartbeat()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.ws) {
      try { this.ws.close(1000, 'client disconnect') } catch { /* ignore */ }
      this.ws = null
    }
    this.log('已断开')
  }

  // ── 订阅特定任务的状态更新 ────────────────────────────────
  subscribe(taskId: string): void {
    this.subscribedTaskIds.add(taskId)
    this.sendRaw({ type: 'subscribe', taskId })
  }

  unsubscribe(taskId: string): void {
    this.subscribedTaskIds.delete(taskId)
    this.sendRaw({ type: 'unsubscribe', taskId })
  }

  // ── 注册消息监听器（返回取消订阅函数） ────────────────────
  onMessage(listener: Listener): vscode.Disposable {
    this.listeners.push(listener)
    return {
      dispose: () => { this.listeners = this.listeners.filter(l => l !== listener) }
    }
  }

  // ── 注册全局消息监听器（所有消息，不过滤） ─────────────────
  onGlobalMessage(listener: (msg: FullMessage) => void): vscode.Disposable {
    this.globalListeners.push(listener)
    return {
      dispose: () => { this.globalListeners = this.globalListeners.filter(l => l !== listener) }
    }
  }

  // ── 连接状态查询 ──────────────────────────────────────────
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  // ── 内部：消息分发 ────────────────────────────────────────
  private handleMessage(raw: string): void {
    let msg: FullMessage
    try {
      msg = JSON.parse(raw) as FullMessage
    } catch {
      this.log(`忽略无效消息: ${raw.slice(0, 100)}`)
      return
    }

    // 分发给全局监听器
    for (const l of this.globalListeners) {
      try { l(msg) } catch (err) {
        this.log(`全局监听器异常: ${(err as Error).message}`)
      }
    }

    // 分发给订阅特定任务的监听器
    for (const l of this.listeners) {
      try { l(msg as WSMessage) } catch (err) {
        this.log(`监听器异常: ${(err as Error).message}`)
      }
    }
  }

  // ── 内部：发送（连接未就绪时静默丢弃） ────────────────────
  private sendRaw(obj: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(obj)) } catch (err) {
        this.log(`发送失败: ${(err as Error).message}`)
      }
    }
  }

  // ── 心跳保活 ──────────────────────────────────────────────
  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.sendRaw({ type: 'ping' })
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  // ── 指数退避重连 ──────────────────────────────────────────
  private scheduleReconnect(): void {
    if (this.intentionallyClosed) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)

    const delay = this.reconnectDelay
    this.log(`${delay}ms 后重连...`)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)

    // 下次重连延迟翻倍，上限 30s
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
  }

  // ── 内部日志 ──────────────────────────────────────────────
  private log(msg: string): void {
    const ts = new Date().toISOString().slice(11, 23)
    this.outputChannel.appendLine(`[${ts}] ${msg}`)
  }
}
