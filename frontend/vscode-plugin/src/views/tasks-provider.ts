import * as vscode from 'vscode'
import { ExecutorClient } from '../api/client'
import { TaskSummary, GeneratedFile, ExecutionStatus } from '../api/types'

// ============================================================
// 任务列表 TreeView
// ============================================================

export type LangType = 'go' | 'typescript' | 'csharp'

// ── 已接受的文件路径追踪（避免重复弹出接受面板） ─────────────
// key: taskId, value: Set<filePath>
const acceptedFilesRegistry = new Map<string, Set<string>>()

export function markFilesAccepted(taskId: string, filePaths: string[]) {
  if (!acceptedFilesRegistry.has(taskId)) {
    acceptedFilesRegistry.set(taskId, new Set())
  }
  for (const p of filePaths) {
    acceptedFilesRegistry.get(taskId)!.add(p)
  }
}

export function markTaskFullyAccepted(taskId: string) {
  // 标记为完全接受（用特殊标志 '*'）
  acceptedFilesRegistry.set(taskId, new Set(['*']))
}

export function isTaskFullyAccepted(taskId: string): boolean {
  return acceptedFilesRegistry.get(taskId)?.has('*') ?? false
}

// ── 任务节点 ─────────────────────────────────────────────────
export class TaskNode extends vscode.TreeItem {
  readonly task: TaskSummary
  override id:           string
  override description:  string
  override tooltip:      vscode.MarkdownString
  override iconPath:     vscode.ThemeIcon
  override contextValue: string

  constructor(task: TaskSummary) {
    super(task.spec_title || '(无标题)', vscode.TreeItemCollapsibleState.Collapsed)
    this.task         = task
    this.id           = task.task_id
    this.description  = buildDescription(task)
    this.tooltip      = buildTooltip(task)
    this.iconPath     = new vscode.ThemeIcon(statusIcon(task.status), statusColor(task.status))

    if (task.status === 'test_pass') {
      this.contextValue = 'awp-task-pending'
    } else if (task.status === 'manual_review') {
      this.contextValue = 'awp-task-manual'
    } else if (task.status.startsWith('human_')) {
      this.contextValue = 'awp-task-reviewed'
    } else if (task.status === 'error' || task.status === 'failed') {
      this.contextValue = 'awp-task-error'
    } else {
      this.contextValue = 'awp-task-running'
    }
  }
}

// ── 语言操作节点 ─────────────────────────────────────────────
export class LangActionNode extends vscode.TreeItem {
  readonly task:     TaskSummary
  readonly language: LangType
  readonly files:    GeneratedFile[]
  override contextValue: string

  constructor(task: TaskSummary, language: LangType, files: GeneratedFile[]) {
    const cfg = LANG_CONFIG[language]
    super(
      `${cfg.label} (${files.length} 个文件)`,
      vscode.TreeItemCollapsibleState.None
    )
    this.task     = task
    this.language = language
    this.files    = files
    this.iconPath     = new vscode.ThemeIcon(cfg.icon)
    this.contextValue = `awp-lang-${language}`
    this.command  = {
      command:   'awp.diffLangFiles',
      title:     `对比并应用 ${cfg.label}`,
      arguments: [{ task, language, files }]
    }
  }
}

const LANG_CONFIG: Record<LangType, { label: string; icon: string; ext: string }> = {
  go:         { label: 'Go 代码',         icon: 'symbol-namespace', ext: '.go'  },
  typescript: { label: 'TypeScript 代码', icon: 'symbol-interface', ext: '.ts'  },
  csharp:     { label: 'C# 代码',         icon: 'symbol-class',     ext: '.cs'  },
}

// ── 文件节点 ─────────────────────────────────────────────────
export class FileNode extends vscode.TreeItem {
  readonly file:   GeneratedFile
  readonly taskId: string
  override description:  string
  override tooltip:      string
  override iconPath:     vscode.ThemeIcon
  override contextValue: string
  override command:      vscode.Command

  constructor(file: GeneratedFile, taskId: string) {
    super(file.path, vscode.TreeItemCollapsibleState.None)
    this.file         = file
    this.taskId       = taskId
    this.description  = `${file.role} · ${file.language}`
    this.tooltip      = `${file.path}\n${file.content.split('\n').length} 行`
    this.iconPath     = new vscode.ThemeIcon(roleIcon(file.role))
    this.contextValue = 'awp-file'
    this.command      = {
      command:   'awp.viewDiff',
      title:     '查看 Diff',
      arguments: [{ file, taskId }]
    }
  }
}

type TreeNode = TaskNode | LangActionNode | FileNode

// ── TreeDataProvider 实现 ───────────────────────────────────
export class TasksProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private taskCache:  TaskSummary[]                       = []
  private filesCache: Map<string, GeneratedFile[]>        = new Map()
  private loading = false
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private readonly CACHE_KEY = 'awp.tasksCache'

  constructor(
    private readonly client: ExecutorClient,
    private readonly context?: vscode.ExtensionContext
  ) {
    // 离线模式：从持久化缓存恢复
    this.loadOfflineCache()
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) return this.fetchTasks()
    if (element instanceof TaskNode) return this.fetchFilesWithActions(element.task)
    return []
  }

  refresh(): void {
    this.filesCache.clear()
    this.scheduleRefresh()
  }

  refreshTask(taskId: string): void {
    this.filesCache.delete(taskId)
    // 如果缓存中有这个任务，更新它的状态（乐观更新）
    this.scheduleRefresh()
  }

  addNewTask(taskData: { taskId: string; specId: string; title: string; priority: string; status: string }): void {
    if (this.taskCache.some(t => t.task_id === taskData.taskId)) return

    const newTask: TaskSummary = {
      task_id: taskData.taskId,
      spec_id: taskData.specId,
      spec_title: taskData.title,
      status: (taskData.status || 'running') as ExecutionStatus,
      priority: (taskData.priority || 'P1') as 'P0' | 'P1' | 'P2',
      retry_count: 0,
      created_at: new Date().toISOString(),
      completed_at: undefined,
      total_score: undefined
    }
    this.taskCache.unshift(newTask)
    this.scheduleRefresh()
    vscode.window.showInformationMessage(`AWP 新任务: ${newTask.spec_title}`)
  }

  /** 更新缓存中某个任务的状态（submitDecision 后立即生效） */
  updateTaskStatus(taskId: string, newStatus: ExecutionStatus): void {
    const task = this.taskCache.find(t => t.task_id === taskId)
    if (task) {
      task.status = newStatus
    }
    this.filesCache.delete(taskId)
    this.scheduleRefresh()
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this._onDidChangeTreeData.fire()
    }, 150)
  }

  // ── 离线缓存 ─────────────────────────────────────────────
  private loadOfflineCache(): void {
    if (!this.context) return
    try {
      const cached = this.context.workspaceState.get<TaskSummary[]>(this.CACHE_KEY)
      if (cached && cached.length > 0) {
        this.taskCache = cached
        this._onDidChangeTreeData.fire()
      }
    } catch { /* 缓存损坏时忽略 */ }
  }

  private saveOfflineCache(tasks: TaskSummary[]): void {
    if (!this.context) return
    try {
      // 只缓存最近 50 个任务，不缓存 running/error 状态（容易过时）
      const toCache = tasks
        .filter(t => !['running', 'auto_fix_1', 'auto_fix_2', 'auto_fix_3'].includes(t.status))
        .slice(0, 50)
      this.context.workspaceState.update(this.CACHE_KEY, toCache)
    } catch { /* 存储失败忽略 */ }
  }

  // ── 获取任务列表 ─────────────────────────────────────────
  private async fetchTasks(): Promise<TreeNode[]> {
    if (this.loading) return this.taskCache.map(t => new TaskNode(t))
    this.loading = true

    try {
      const { items } = await this.client.listTasks({ limit: 50 })
      const apiIds = new Set(items.map(t => t.task_id))
      const pending = this.taskCache.filter(
        t => !apiIds.has(t.task_id) && t.status === 'running'
      )
      this.taskCache = [...pending, ...items]
      // 保存到离线缓存
      this.saveOfflineCache(this.taskCache)
      return this.taskCache.map(t => new TaskNode(t))
    } catch (err) {
      const msg = (err as Error).message
      // 离线模式：返回缓存，显示提示
      if (this.taskCache.length > 0) {
        vscode.window.showWarningMessage(
          `AWP 无法连接服务（${msg.slice(0, 60)}），显示离线缓存`
        )
      } else {
        vscode.window.showWarningMessage(
          `AWP 任务列表加载失败: ${msg}。请检查 executor 服务（localhost:3004）`
        )
      }
      return this.taskCache.map(t => new TaskNode(t))
    } finally {
      this.loading = false
    }
  }

  // ── 获取文件并插入语言操作按钮 ──────────────────────────
  private async fetchFilesWithActions(task: TaskSummary): Promise<TreeNode[]> {
    const taskId = task.task_id
    let files: GeneratedFile[]

    const cached = this.filesCache.get(taskId)
    if (cached) {
      files = cached
    } else {
      try {
        const resp = await this.client.getFiles(taskId)
        files = (resp.files || []) as GeneratedFile[]
        this.filesCache.set(taskId, files)
      } catch (err) {
        vscode.window.showErrorMessage(`加载任务文件失败: ${(err as Error).message}`)
        return []
      }
    }

    const nodes: TreeNode[] = []
    const hasFiles = files.length > 0

    // 只对"待 Review"和"需人工"显示语言操作按钮
    // 已接受/拒绝的任务不再显示（避免重复弹出）
    const isAwaitingReview = ['test_pass', 'manual_review'].includes(task.status)
    const alreadyFullyAccepted = isTaskFullyAccepted(taskId)

    if (hasFiles && isAwaitingReview && !alreadyFullyAccepted) {
      const langOrder: LangType[] = ['go', 'typescript', 'csharp']
      for (const lang of langOrder) {
        const langFiles = files.filter(f => {
          if (f.language === lang) return true
          if (lang === 'csharp') {
            const l = (f.language as string).toLowerCase()
            return l === 'cs' || l.includes('csharp') || l.includes('unity')
          }
          return false
        })
        if (langFiles.length > 0) {
          nodes.push(new LangActionNode(task, lang, langFiles))
        }
      }
    }

    nodes.push(...files.map(f => new FileNode(f, taskId)))
    return nodes
  }

  getFilesByTaskId(taskId: string): GeneratedFile[] | undefined {
    return this.filesCache.get(taskId)
  }
}

// ── 视觉辅助 ─────────────────────────────────────────────────
function buildDescription(task: TaskSummary): string {
  let desc = formatStatus(task.status)
  if (task.total_score != null) {
    const score = Number(task.total_score)
    const emoji = score >= 80 ? '⭐' : score >= 60 ? '🔶' : '🔴'
    desc += `  ${emoji}${score}`
  }
  return desc
}

function formatStatus(status: ExecutionStatus | string): string {
  const map: Record<string, string> = {
    running:                  '⏳ 执行中',
    generated:                '📝 已生成',
    test_pass:                '✓ 待 Review',
    auto_fix_1:               '🔧 修复 1/3',
    auto_fix_2:               '🔧 修复 2/3',
    auto_fix_3:               '🔧 修复 3/3',
    manual_review:            '⚠ 需人工',
    human_accepted:           '✅ 已接受',
    human_rejected:           '❌ 已拒绝',
    human_partial_accepted:   '◐ 部分接受',
    error:                    '⛔ 异常',
    failed:                   '⛔ 失败',
  }
  return map[status] || status
}

function statusIcon(status: ExecutionStatus | string): string {
  if (status === 'test_pass')              return 'pass-filled'
  if (status === 'human_accepted')         return 'check-all'
  if (status === 'human_rejected')         return 'circle-slash'
  if (status === 'human_partial_accepted') return 'diff-modified'
  if (status === 'manual_review')          return 'warning'
  if (status === 'error' || status === 'failed') return 'error'
  if (status.startsWith('auto_fix'))       return 'tools'
  if (status === 'running')                return 'sync~spin'
  return 'circle-outline'
}

function statusColor(status: ExecutionStatus | string): vscode.ThemeColor | undefined {
  if (status === 'test_pass')              return new vscode.ThemeColor('charts.green')
  if (status === 'human_accepted')         return new vscode.ThemeColor('charts.green')
  if (status === 'human_partial_accepted') return new vscode.ThemeColor('charts.blue')
  if (status === 'human_rejected')         return new vscode.ThemeColor('charts.red')
  if (status === 'manual_review')          return new vscode.ThemeColor('charts.orange')
  if (status === 'error' || status === 'failed') return new vscode.ThemeColor('charts.red')
  return undefined
}

function roleIcon(role: GeneratedFile['role']): string {
  return ({
    handler:   'symbol-method',
    service:   'symbol-class',
    model:     'symbol-structure',
    types:     'symbol-interface',
    test:      'beaker',
    client:    'globe',
    script:    'file-code',
    component: 'symbol-color',
  } as Record<string, string>)[role] || 'file-code'
}

function buildTooltip(task: TaskSummary): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true)
  md.isTrusted = false
  md.appendMarkdown(`**${task.spec_title}**\n\n`)
  md.appendMarkdown(`- 任务 ID: \`${task.task_id.slice(0, 8)}...\`\n`)
  md.appendMarkdown(`- 状态: ${formatStatus(task.status)}\n`)
  md.appendMarkdown(`- 优先级: ${task.priority}\n`)
  if (task.total_score !== undefined && task.total_score !== null) {
    md.appendMarkdown(`- AI 评分: **${task.total_score}** / 100\n`)
  }
  if (task.retry_count > 0) {
    md.appendMarkdown(`- Auto-Fix: ${task.retry_count} 次\n`)
  }
  md.appendMarkdown(`- 创建于: ${formatRelativeTime(task.created_at)}`)
  return md
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000)        return '刚刚'
  if (diff < 3_600_000)     return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000)    return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}
