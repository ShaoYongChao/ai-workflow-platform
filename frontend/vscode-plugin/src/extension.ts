import * as vscode from 'vscode'
import { ExecutorClient } from './api/client'
import { WSClient } from './api/ws-client'
import { TasksProvider } from './views/tasks-provider'
import { KnowledgeProvider } from './views/knowledge-provider'
import { ConsoleViewProvider } from './views/console-provider'
import { GeneratedContentProvider, registerCommands } from './commands'

export function activate(context: vscode.ExtensionContext) {
  console.log('AWP 插件已激活')

  // ── 读取配置 ────────────────────────────────────────────
  const getServerUrl = () => vscode.workspace.getConfiguration('awp').get<string>('serverUrl') || 'http://localhost:3004'

  // ── 实例化客户端 ────────────────────────────────────────
  const client = new ExecutorClient(getServerUrl)
  const ws     = new WSClient(getServerUrl)

  // ── TreeView providers ──────────────────────────────────
  const tasksProvider     = new TasksProvider(client, context)
  const knowledgeProvider = new KnowledgeProvider()

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('awpTasksView',     tasksProvider),
    vscode.window.registerTreeDataProvider('awpKnowledgeView', knowledgeProvider),
  )

  // ── 虚拟文档（Diff View 使用） ──────────────────────────
  const contentProvider = new GeneratedContentProvider()
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('awp-generated', contentProvider)
  )

  // ── 执行控制台 WebView ──────────────────────────────────
  const consoleProvider = new ConsoleViewProvider(context, ws)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('awpConsoleView', consoleProvider, {
      // 切换窗口/标签时保留 WebView 上下文，防止日志清空
      webviewOptions: { retainContextWhenHidden: true }
    })
  )

  // ── 注册命令（传入 consoleProvider 用于触发后聚焦日志） ──
  registerCommands(context, client, tasksProvider, contentProvider, consoleProvider)

  // ── awp._subscribeTask: 订阅特定任务的 WS 更新（内部命令） ─
  context.subscriptions.push(
    vscode.commands.registerCommand('awp._subscribeTask', (taskId: string) => {
      if (taskId) ws.subscribe(taskId)
    })
  )

  // ── 状态栏指示器 ────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBar.text = '$(sync~spin) AWP 连接中'
  statusBar.show()
  context.subscriptions.push(statusBar)

  // ── WebSocket 接入 ──────────────────────────────────────
  ws.connect()

  // ── 全局消息处理：处理新任务通知 ─────────────────────────
  ws.onGlobalMessage((msg: any) => {
    if (msg.type === 'task_created') {
      tasksProvider.addNewTask(msg)
    }
  })

  ws.onMessage(msg => {
    if (msg.type === 'task_update' || msg.type === 'task_decision') {
      tasksProvider.refreshTask(msg.taskId)
    }
  })

  // ── 健康检查 + 状态栏更新 ───────────────────────────────
  const updateStatus = async () => {
    const alive = await client.ping()
    if (alive) {
      statusBar.text = '$(check) AWP'
      statusBar.tooltip = `已连接 ${getServerUrl()}`
      statusBar.color = undefined
    } else {
      statusBar.text = '$(error) AWP 离线'
      statusBar.tooltip = `无法连接 ${getServerUrl()}`
      statusBar.color = new vscode.ThemeColor('statusBarItem.warningForeground')
    }
  }
  updateStatus()
  const statusTimer = setInterval(updateStatus, 30000)
  context.subscriptions.push({ dispose: () => clearInterval(statusTimer) })

  // ── 自动刷新任务列表 ────────────────────────────────────
  const autoRefreshSec = vscode.workspace.getConfiguration('awp').get<number>('autoRefreshInterval') || 30
  if (autoRefreshSec > 0) {
    const refreshTimer = setInterval(() => tasksProvider.refresh(), autoRefreshSec * 1000)
    context.subscriptions.push({ dispose: () => clearInterval(refreshTimer) })
  }

  // ── 配置变化时重连 ──────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
      if (e.affectsConfiguration('awp.serverUrl')) {
        ws.disconnect()
        ws.connect()
        tasksProvider.refresh()
        knowledgeProvider.refresh()
      }
    })
  )

  // ── 注册资源清理 ────────────────────────────────────────
  context.subscriptions.push({ dispose: () => ws.disconnect() })
}

export function deactivate() {
  console.log('AWP 插件已停用')
}
