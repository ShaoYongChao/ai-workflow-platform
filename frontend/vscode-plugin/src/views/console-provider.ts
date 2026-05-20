import * as vscode from 'vscode'
import { WSClient } from '../api/ws-client'
import { WSMessage } from '../api/types'

// ============================================================
// 执行控制台 WebView
//   左侧 Activity Bar 的第三个视图，展示：
//   - 任务统计（运行中 / 待 Review / 已通过 / 已拒绝）
//   - 实时执行日志（WebSocket 推送的 stage 事件）
//   - 当前连接状态
//
//   消息流：
//   WebView ←→ extension host
//     'request_stats'  → 拉统计 → postMessage('stats', data)
//     extension 收到 ws task_log → postMessage('log', detail)
// ============================================================

const STAGE_LABELS: Record<string, string> = {
  // ── 代码生成阶段（code-generator 广播） ──────────────────
  gen_start:           '🚀 开始代码生成',
  kb_searching:        '🔍 检索知识库与记忆',
  kb_retrieved:        '📚 知识库检索完成',
  generating_server:   '⚙️  生成服务端 Go 代码',
  generating_client:   '⚙️  生成客户端 TS 代码',
  code_ready:          '✅ 代码生成完成，转交测试',
  gen_failed:          '❌ 代码生成失败',
  // ── 执行测试阶段（executor 广播） ────────────────────────
  sandbox_creating:    '🏗  创建沙箱',
  sandbox_ready:       '✅ 沙箱就绪',
  test_running:        '🧪 运行测试',
  test_output:         '📊 测试输出',
  test_pass:           '✅ 测试全部通过',
  auto_fix_running:    '🔧 Auto-Fix 修复中',
  auto_fix_detail:     '📝 修复详情',
  auto_fix_skipped:    '⏭  跳过本次修复',
  auto_fix_failed:     '❌ 修复后测试仍失败',
  manual_review:       '⚠️  转人工审查',
}

export class ConsoleViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly ws: WSClient
  ) {}

  // ── VS Code API：构造 WebView ─────────────────────────────
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    }
    view.webview.html = this.buildHTML(view.webview)

    // ── 监听 WebView 消息 ───────────────────────────────────
    view.webview.onDidReceiveMessage((msg: { type: string; payload?: any }) => {
      if (msg.type === 'clear_logs') {
        // 由 WebView 自己处理，extension 端不存储
      } else if (msg.type === 'open_task' && msg.payload?.taskId) {
        vscode.commands.executeCommand('awp.openTask', msg.payload.taskId)
      }
    })

    // ── WebSocket 消息转发到 WebView ────────────────────────
    const sub = this.ws.onMessage(this.handleWSMessage.bind(this))
    view.onDidDispose(() => {
      sub.dispose()
    })

    // 主动告知连接状态
    this.postMessage({ type: 'connection', payload: { connected: this.ws.isConnected() } })
  }

  // ── 处理 WebSocket 消息 ───────────────────────────────────
  private handleWSMessage(msg: WSMessage): void {
    if (msg.type === 'task_log') {
      this.postMessage({
        type: 'log',
        payload: {
          taskId: msg.taskId,
          stage:  msg.stage,
          label:  STAGE_LABELS[msg.stage] || msg.stage,
          detail: msg.detail,
          timestamp: msg.timestamp
        }
      })
    } else if (msg.type === 'task_update') {
      this.postMessage({
        type: 'task_update',
        payload: msg
      })
    } else if (msg.type === 'hello') {
      this.postMessage({ type: 'connection', payload: { connected: true } })
    }
  }

  // ── 外部调用：聚焦到某个任务（生成触发后调用） ───────────
  focusTask(taskId: string, specTitle: string): void {
    this.postMessage({
      type: 'focus_task',
      payload: { taskId, specTitle }
    })
  }

  private postMessage(msg: any): void {
    if (this.view) this.view.webview.postMessage(msg)
  }

  // ── WebView HTML（暗色主题，对齐 VS Code 视觉） ───────────
  private buildHTML(webview: vscode.Webview): string {
    const nonce = makeNonce()
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    margin: 0; padding: 0;
  }
  .section { padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
  .section h3 {
    margin: 0 0 8px 0;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground);
  }
  .conn-indicator { display: flex; align-items: center; gap: 6px; font-size: 11px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; }
  .dot.on  { background: var(--vscode-charts-green); }
  .dot.off { background: var(--vscode-charts-red); }

  .logs {
    max-height: 320px;
    overflow-y: auto;
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
    border-radius: 3px;
  }
  .log-row {
    padding: 4px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
    display: flex; gap: 6px; align-items: center;
  }
  .log-row:last-child { border-bottom: none; }
  .log-time {
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
    min-width: 56px;
  }
  .log-stage { flex: 1; }
  .log-task  { color: var(--vscode-descriptionForeground); font-size: 10px; font-family: monospace; }
  .log-detail {
    padding: 4px 8px;
    margin: 4px 0;
    background: rgba(0,0,0,0.2);
    border-left: 2px solid var(--vscode-charts-yellow);
    border-radius: 2px;
    font-family: monospace;
    font-size: 10px;
    line-height: 1.4;
  }
  .log-detail.error { border-left-color: var(--vscode-charts-red); }
  .log-detail.pass  { border-left-color: var(--vscode-charts-green); }
  .log-detail.title { font-weight: bold; margin-top: 6px; }

  .empty {
    padding: 20px 12px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    text-align: center;
  }
  button.clear-btn {
    background: transparent;
    border: 1px solid var(--vscode-input-border);
    color: var(--vscode-foreground);
    font-size: 11px;
    padding: 3px 9px;
    cursor: pointer;
    border-radius: 3px;
  }
  button.clear-btn:hover { background: var(--vscode-list-hoverBackground); }
  .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
</style>
</head>
<body>

<div class="section">
  <div class="header-row">
    <h3>连接状态</h3>
    <div id="conn" class="conn-indicator">
      <span class="dot off"></span>
      <span>未连接</span>
    </div>
  </div>
</div>

<div class="section">
  <div class="header-row">
    <h3>实时执行日志</h3>
    <div style="display:flex;gap:4px">
      <button class="clear-btn" id="filter-toggle" title="仅显示当前任务">全部</button>
      <button class="clear-btn" id="clear">清空</button>
    </div>
  </div>
  <div id="active-task" style="display:none;padding:4px 8px;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:3px;font-size:11px;margin-bottom:6px;">
    <span style="color:var(--vscode-charts-green)">●</span> <span id="active-task-title">-</span>
    <span style="color:var(--vscode-descriptionForeground);font-family:monospace;margin-left:6px" id="active-task-id"></span>
  </div>
  <div id="logs" class="logs">
    <div class="empty">等待 executor 推送...</div>
  </div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi()
const MAX_LOGS = 200

const $ = (id) => document.getElementById(id)

let logs = []
let activeTaskId = null
let filterByTask = false

function renderLogs() {
  const el = $('logs')
  const visible = filterByTask && activeTaskId
    ? logs.filter(l => l.taskId === activeTaskId)
    : logs
  if (visible.length === 0) {
    el.innerHTML = '<div class="empty">等待 executor 推送...</div>'
    return
  }
  el.innerHTML = visible.map(l => {
    const t = new Date(l.timestamp)
    const ts = String(t.getHours()).padStart(2,'0') + ':' + String(t.getMinutes()).padStart(2,'0') + ':' + String(t.getSeconds()).padStart(2,'0')
    const taskShort = (l.taskId || '').slice(0, 8)
    let html = \`<div class="log-row">
      <span class="log-time">\${ts}</span>
      <span class="log-stage">\${escapeHTML(l.label || l.stage)}</span>
      <span class="log-task" title="\${l.taskId}">\${taskShort}</span>
    </div>\`

    // 显示测试输出详情
    if (l.stage === 'test_output' && l.detail) {
      const detail = l.detail
      const status = detail.status === 'pass' ? '✅' : '❌'
      html += \`<div class="log-detail \${detail.status}">
        <div class="title">\${status} \${detail.language.toUpperCase()}: \${detail.passedTests}/\${detail.totalTests} 测试通过</div>\`
      if (detail.failedTestNames && detail.failedTestNames.length > 0) {
        html += \`<div>❌ 失败: \${detail.failedTestNames.join(', ')}</div>\`
      }
      html += \`<div>⏱ \${detail.durationMs}ms</div></div>\`
    }

    // 显示 Auto-Fix 详情
    if (l.stage === 'auto_fix_detail' && l.detail) {
      const detail = l.detail
      const files = detail.modifiedFiles || []
      html += \`<div class="log-detail">
        <div class="title">🔧 修改 \${files.length} 个文件</div>\`
      for (const f of files) {
        html += \`<div>  • \${escapeHTML(f.path)} (\${f.language})</div>\`
      }
      html += \`</div>\`
    }

    return html
  }).join('')
  // 自动滚到底
  el.scrollTop = el.scrollHeight
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}

function updateConnection(connected) {
  const dot = $('conn').querySelector('.dot')
  const txt = $('conn').querySelector('span:last-child')
  if (connected) {
    dot.className = 'dot on'
    txt.textContent = '已连接 executor'
  } else {
    dot.className = 'dot off'
    txt.textContent = '未连接'
  }
}

window.addEventListener('message', (e) => {
  const { type, payload } = e.data
  switch (type) {
    case 'log':
      logs.push(payload)
      if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS)
      renderLogs()
      break

    case 'connection':
      updateConnection(payload.connected)
      break

    case 'focus_task':
      activeTaskId = payload.taskId
      filterByTask = true
      $('active-task').style.display = 'block'
      $('active-task-title').textContent = payload.specTitle || payload.taskId
      $('active-task-id').textContent = (payload.taskId || '').slice(0, 8) + '...'
      $('filter-toggle').textContent = '当前任务'
      $('filter-toggle').style.color = 'var(--vscode-charts-green)'
      renderLogs()
      break
  }
})

$('clear').addEventListener('click', () => {
  logs = []
  renderLogs()
})

$('filter-toggle').addEventListener('click', () => {
  filterByTask = !filterByTask
  $('filter-toggle').textContent = filterByTask ? '当前任务' : '全部'
  $('filter-toggle').style.color = filterByTask ? 'var(--vscode-charts-green)' : ''
  renderLogs()
})

</script>
</body>
</html>`
  }
}

// ── CSP nonce 生成 ──────────────────────────────────────────
function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length))
  return s
}
