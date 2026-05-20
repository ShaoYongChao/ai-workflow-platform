import * as vscode from 'vscode'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ExecutorClient } from '../api/client'
import { TasksProvider, LangType, markFilesAccepted, markTaskFullyAccepted, isTaskFullyAccepted } from '../views/tasks-provider'
import { GeneratedFile, TaskSummary, KBChunkMetadata } from '../api/types'
import { ConsoleViewProvider } from '../views/console-provider'

// ── 虚拟文件系统 ────────────────────────────────────────────
const AWP_SCHEME = 'awp-generated'

export class GeneratedContentProvider implements vscode.TextDocumentContentProvider {
  private contents = new Map<string, string>()

  set(uri: vscode.Uri, content: string) {
    this.contents.set(uri.toString(), content)
    this._onDidChange.fire(uri)
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) || ''
  }

  private _onDidChange = new vscode.EventEmitter<vscode.Uri>()
  onDidChange = this._onDidChange.event
}

let _contentProvider: GeneratedContentProvider | undefined

// ── 注册所有命令 ─────────────────────────────────────────────
export function registerCommands(
  context: vscode.ExtensionContext,
  client: ExecutorClient,
  tasksProvider: TasksProvider,
  contentProvider: GeneratedContentProvider,
  consoleProvider?: ConsoleViewProvider
) {
  _contentProvider = contentProvider

  // ──────────────────────────────────────────────────────────
  // awp.viewDiff — 预览生成文件（只读）
  // ──────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('awp.viewDiff', async (node: any) => {
      if (!node?.file || !node?.taskId) return
      const file: GeneratedFile = node.file

      const previewUri = vscode.Uri.parse(`${AWP_SCHEME}:/${node.taskId}/${file.path}?preview`)
      contentProvider.set(previewUri, file.content)
      const doc = await vscode.workspace.openTextDocument(previewUri)
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Active })
    })
  )

  // ──────────────────────────────────────────────────────────
  // awp.batchDiff — 批量对比所有文件（WebView 总览 + 逐个打开）
  // ──────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('awp.batchDiff', async (node: any) => {
      const task: TaskSummary = node?.task
      if (!task) return

      const files = tasksProvider.getFilesByTaskId(task.task_id)
      if (!files || files.length === 0) {
        vscode.window.showWarningMessage('暂无文件，请先展开任务节点')
        return
      }

      // 打开 WebView 总览
      const panel = vscode.window.createWebviewPanel(
        'awpBatchDiff',
        `批量对比 — ${task.spec_title || task.task_id.slice(0, 8)}`,
        vscode.ViewColumn.One,
        { enableScripts: true }
      )

      const wsFolder = vscode.workspace.workspaceFolders?.[0]
      const fileItems = files.map(f => {
        const realPath = wsFolder ? path.join(wsFolder.uri.fsPath, f.path) : ''
        const exists = !!realPath && fs.existsSync(realPath)
        const lines = f.content.split('\n').length
        return { path: f.path, language: f.language, role: f.role, lines, exists }
      })

      panel.webview.html = buildBatchDiffHtml(task, fileItems)

      // 处理 WebView → 插件的消息
      panel.webview.onDidReceiveMessage(async msg => {
        if (msg.command === 'openDiff') {
          const file = files.find(f => f.path === msg.path)
          if (file) {
            await vscode.commands.executeCommand('awp.viewDiff', { file, taskId: task.task_id })
          }
        } else if (msg.command === 'acceptAll') {
          await vscode.commands.executeCommand('awp.acceptTask', node)
          panel.dispose()
        } else if (msg.command === 'partialAccept') {
          await vscode.commands.executeCommand('awp.partialAccept', node)
          panel.dispose()
        } else if (msg.command === 'reject') {
          await vscode.commands.executeCommand('awp.rejectTask', node)
          panel.dispose()
        }
      })
    })
  )

  // ──────────────────────────────────────────────────────────
  // awp.applyFile — 应用单个文件
  // ──────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('awp.applyFile', async (node: any) => {
      if (!node?.file) return
      await applyFileToWorkspace(node.file)
    })
  )

  // ──────────────────────────────────────────────────────────
  // awp.acceptTask — 全部接受（写文件 + 上报 + 更新状态）
  // ──────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('awp.acceptTask', async (node: any) => {
      const task: TaskSummary | undefined = node?.task
      if (!task) return

      const score = await pickStarRating()
      if (score === undefined) return

      const feedback = await vscode.window.showInputBox({
        prompt: '反馈意见（可选）',
        placeHolder: '比如：代码质量很好 / 还差一些边界处理'
      })

      const files = tasksProvider.getFilesByTaskId(task.task_id) || []
      const applied: string[] = []
      const failed: string[] = []

      for (const f of files) {
        try {
          await applyFileToWorkspace(f, false)
          applied.push(f.path)
        } catch (err) {
          failed.push(`${f.path}: ${(err as Error).message}`)
        }
      }

      try {
        await client.submitDecision(task.task_id, 'accept', { feedback, humanScore: score })
        // ✅ 立即更新本地状态，不等下次刷新
        markTaskFullyAccepted(task.task_id)
        tasksProvider.updateTaskStatus(task.task_id, 'human_accepted')

        const msg = failed.length === 0
          ? `✅ 已接受任务，应用 ${applied.length} 个文件`
          : `✅ 应用 ${applied.length} 个，失败 ${failed.length} 个`
        vscode.window.showInformationMessage(msg)
      } catch (err) {
        vscode.window.showErrorMessage(`上报失败: ${(err as Error).message}`)
        tasksProvider.refresh()
      }
    })
  )

  // ──────────────────────────────────────────────────────────
  // awp.partialAccept — 局部接受（多选文件）
  // ──────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('awp.partialAccept', async (node: any) => {
      const task: TaskSummary | undefined = node?.task
      if (!task) return

      const files = tasksProvider.getFilesByTaskId(task.task_id) || []
      if (files.length === 0) {
        vscode.window.showWarningMessage('暂无文件可选择')
        return
      }

      const wsFolder = vscode.workspace.workspaceFolders?.[0]
      const items: vscode.QuickPickItem[] = files.map(f => {
        const realPath = wsFolder ? path.join(wsFolder.uri.fsPath, f.path) : ''
        const exists = realPath && fs.existsSync(realPath)
        return {
          label: f.path,
          description: `${f.language} · ${f.role}`,
          detail: exists ? '⬜ 已有文件，将覆盖' : '✨ 新文件',
          picked: true  // 默认全选
        }
      })

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: '选择要接受的文件（按 Space 切换选中，Enter 确认）',
        canPickMany: true,
        matchOnDescription: true
      })
      if (!picked || picked.length === 0) return

      const acceptedPaths = picked.map(p => p.label)
      const acceptedFiles = files.filter(f => acceptedPaths.includes(f.path))

      const score = await pickStarRating()
      if (score === undefined) return

      const feedback = await vscode.window.showInputBox({
        prompt: '反馈意见（可选）',
        placeHolder: '说明为什么部分接受'
      })

      // 写入选中文件
      for (const f of acceptedFiles) {
        try {
          await applyFileToWorkspace(f, false)
        } catch { /* 单个失败不阻塞 */ }
      }

      try {
        const isAll = acceptedPaths.length === files.length
        if (isAll) {
          await client.submitDecision(task.task_id, 'accept', { feedback, humanScore: score })
          markTaskFullyAccepted(task.task_id)
          tasksProvider.updateTaskStatus(task.task_id, 'human_accepted')
        } else {
          await client.submitDecision(task.task_id, 'partial_accept', {
            feedback,
            humanScore: score,
            acceptedFiles: acceptedPaths
          })
          markFilesAccepted(task.task_id, acceptedPaths)
          tasksProvider.updateTaskStatus(task.task_id, 'human_partial_accepted')
        }
        vscode.window.showInformationMessage(
          `✅ 已接受 ${acceptedPaths.length}/${files.length} 个文件`
        )
      } catch (err) {
        vscode.window.showErrorMessage(`上报失败: ${(err as Error).message}`)
        tasksProvider.refresh()
      }
    })
  )

  // ──────────────────────────────────────────────────────────
  // awp.rejectTask — 拒绝任务
  // ──────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('awp.rejectTask', async (node: any) => {
      const task: TaskSummary | undefined = node?.task
      if (!task) return

      const feedback = await vscode.window.showInputBox({
        prompt: '拒绝原因（必填，用于 AI 改进）',
        placeHolder: '比如：未按 Spec 要求 / 代码风格不符合项目 / 测试覆盖不足'
      })
      if (!feedback) return

      try {
        await client.submitDecision(task.task_id, 'reject', { feedback, humanScore: 1 })
        // ✅ 立即更新本地状态
        markTaskFullyAccepted(task.task_id)   // 拒绝后也不再弹出接受面板
        tasksProvider.updateTaskStatus(task.task_id, 'human_rejected')
        vscode.window.showInformationMessage(`❌ 任务 "${task.spec_title}" 已拒绝`)
      } catch (err) {
        vscode.window.showErrorMessage(`上报失败: ${(err as Error).message}`)
        tasksProvider.refresh()
      }
    })
  )

  // ──────────────────────────────────────────────────────────
  // awp.refreshTasks
  // ──────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('awp.refreshTasks', () => tasksProvider.refresh())
  )

  // ──────────────────────────────────────────────────────────
  // awp.viewKBChunk / awp.viewKBChunks / awp.showTaskKBChunks
  // ──────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('awp.viewKBChunk', async (chunk: any) => {
      const { showKBChunk } = await import('../views/knowledge-provider')
      await showKBChunk(chunk)
    })
  )
  context.subscriptions.push(
    vscode.commands.registerCommand('awp.viewKBChunks', async (node: any) => {
      if (!node?.taskId) return
      await vscode.commands.executeCommand('awp.showTaskKBChunks', { taskId: node.taskId })
    })
  )
  context.subscriptions.push(
    vscode.commands.registerCommand('awp.showTaskKBChunks', async (node: any) => {
      const taskId: string = node?.taskId
      if (!taskId) return

      try {
        const result = await client.getResult(taskId)
        const chunks = result.kb_chunks_used || []

        if (chunks.length === 0) {
          vscode.window.showInformationMessage('本次生成未使用任何知识库片段')
          return
        }

        const goChunks = chunks.filter(c => c.language === 'go')
        const tsChunks = chunks.filter(c => c.language === 'typescript')
        let markdown = '## 📚 代码生成使用的知识库\n\n'

        if (goChunks.length > 0) {
          markdown += `### Go 后端 (${goChunks.length} 个)\n`
          for (const chunk of goChunks) {
            markdown += `- **${chunk.type}** - ${chunk.file}\n`
            markdown += `  符号: ${chunk.symbols.join(', ')}\n`
          }
          markdown += '\n'
        }
        if (tsChunks.length > 0) {
          markdown += `### TypeScript 前端 (${tsChunks.length} 个)\n`
          for (const chunk of tsChunks) {
            markdown += `- **${chunk.type}** - ${chunk.file}\n`
            markdown += `  符号: ${chunk.symbols.join(', ')}\n`
          }
        }

        const panel = vscode.window.createWebviewPanel(
          'kbChunks', `KB Chunks - ${taskId.slice(0, 8)}...`,
          vscode.ViewColumn.Beside, { enableScripts: false }
        )
        panel.webview.html = buildMarkdownHtml(markdown)
      } catch (err) {
        vscode.window.showErrorMessage(`获取知识库信息失败: ${(err as Error).message}`)
      }
    })
  )

  // ──────────────────────────────────────────────────────────
  // awp.copyTaskId / awp.openTaskInBrowser
  // ──────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('awp.copyTaskId', async (node: any) => {
      const task: TaskSummary | undefined = node?.task
      if (!task) return
      await vscode.env.clipboard.writeText(task.task_id)
      vscode.window.showInformationMessage(`已复制任务 ID: ${task.task_id.slice(0, 8)}...`)
    })
  )
  context.subscriptions.push(
    vscode.commands.registerCommand('awp.openTaskInBrowser', async (node: any) => {
      const task: TaskSummary | undefined = node?.task
      if (!task) return
      const executor = vscode.workspace.getConfiguration('awp').get<string>('serverUrl') || 'http://localhost:3004'
      await vscode.env.openExternal(vscode.Uri.parse(`${executor}/tasks/${task.task_id}`))
    })
  )

  // ──────────────────────────────────────────────────────────
  // awp.rejectAllFiles
  // ──────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('awp.rejectAllFiles', async (node: any) => {
      await vscode.commands.executeCommand('awp.rejectTask', node)
    })
  )

  // ──────────────────────────────────────────────────────────
  // awp.generateCode — 手动触发代码生成
  // ──────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('awp.generateCode', async () => {
      let specs: import('../api/types').SpecItem[]
      try {
        const data = await client.listSpecs({ limit: 100 })
        specs = data.items
      } catch (err) {
        vscode.window.showErrorMessage(`获取 Spec 列表失败: ${(err as Error).message}`)
        return
      }

      if (specs.length === 0) {
        vscode.window.showInformationMessage('暂无可用 Spec，请先在策划界面创建功能需求')
        return
      }

      const items = specs.map(s => ({
        label: s.title,
        description: `优先级: ${s.priority}  |  ${s.goal?.slice(0, 60) || ''}`,
        detail: `创建时间: ${new Date(s.created_at).toLocaleString()}  |  ID: ${s.id.slice(0, 8)}...`,
        specId: s.id,
        specTitle: s.title
      }))

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: '选择要生成代码的功能 Spec',
        matchOnDescription: true
      })
      if (!picked) return

      const confirm = await vscode.window.showWarningMessage(
        `确认为「${picked.specTitle}」触发 AI 代码生成？`,
        { modal: true }, '✅ 确认生成'
      )
      if (confirm !== '✅ 确认生成') return

      const progress = vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `正在触发：${picked.specTitle}`, cancellable: false },
        () => client.triggerGeneration(picked.specId)
      )

      try {
        const result = await progress
        await vscode.commands.executeCommand('awp._subscribeTask', result.taskId)
        await vscode.commands.executeCommand('awpConsoleView.focus')
        consoleProvider?.focusTask(result.taskId, picked.specTitle)
        vscode.window.showInformationMessage(
          `🚀 已触发「${picked.specTitle}」代码生成，实时进度见控制台`,
          '刷新任务列表'
        ).then(choice => { if (choice) tasksProvider.refresh() })
      } catch (err) {
        vscode.window.showErrorMessage(`触发生成失败: ${(err as Error).message}`)
      }
    })
  )

  // ──────────────────────────────────────────────────────────
  // awp.diffLangFiles — 语言级对比 + 全部接受/局部接受
  // 修复：全部接受后调用 submitDecision，状态同步更新
  // ──────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'awp.diffLangFiles',
      async (arg: { task: TaskSummary; language: LangType; files: GeneratedFile[] }) => {
        if (!arg?.files?.length) return
        const { task, language, files } = arg

        // 如果整个任务已被接受，直接提示不再弹出
        if (isTaskFullyAccepted(task.task_id)) {
          vscode.window.showInformationMessage(`任务「${task.spec_title}」已接受，如需重新查看请刷新任务列表`)
          return
        }

        const langLabel = { go: 'Go', typescript: 'TypeScript', csharp: 'C#' }[language]

        // 保存到临时目录
        const tmpRoot = path.join(os.tmpdir(), 'awp-generated', task.task_id, language)
        fs.mkdirSync(tmpRoot, { recursive: true })

        const tmpFiles: { file: GeneratedFile; tmpPath: string }[] = []
        for (const file of files) {
          const tmpPath = path.join(tmpRoot, file.path.replace(/\//g, path.sep))
          fs.mkdirSync(path.dirname(tmpPath), { recursive: true })
          fs.writeFileSync(tmpPath, file.content, 'utf8')
          tmpFiles.push({ file, tmpPath })
        }

        // 逐文件打开 Diff
        const wsFolder = vscode.workspace.workspaceFolders?.[0]
        let openedCount = 0, newFileCount = 0

        for (const { file, tmpPath } of tmpFiles) {
          const tmpUri = vscode.Uri.file(tmpPath)
          if (wsFolder) {
            const wsPath = path.join(wsFolder.uri.fsPath, file.path)
            if (fs.existsSync(wsPath)) {
              await vscode.commands.executeCommand(
                'vscode.diff', vscode.Uri.file(wsPath), tmpUri,
                `${file.path}  (当前 ↔ AI 生成)`,
                { preview: openedCount === 0 }
              )
            } else {
              const doc = await vscode.workspace.openTextDocument(tmpUri)
              await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: openedCount > 0 })
              newFileCount++
            }
          } else {
            const doc = await vscode.workspace.openTextDocument(tmpUri)
            await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: openedCount > 0 })
          }
          openedCount++
        }

        const diffCount = openedCount - newFileCount
        const summary = [
          diffCount    > 0 ? `${diffCount} 个文件需对比`  : '',
          newFileCount > 0 ? `${newFileCount} 个新文件`    : '',
        ].filter(Boolean).join('，')

        const action = await vscode.window.showInformationMessage(
          `已打开 ${langLabel} 代码对比：${summary}。确认后将写入工作区。`,
          '✅ 全部接受', '📋 局部接受', '❌ 取消'
        )

        if (action === '✅ 全部接受') {
          await applyLangFilesToWorkspace(files, task.task_id, wsFolder)

          // 检查整个任务是否已全部接受
          const allTaskFiles = tasksProvider.getFilesByTaskId(task.task_id) || []
          const acceptedPaths = files.map(f => f.path)
          const allDone = allTaskFiles.every(f => acceptedPaths.includes(f.path))

          const score = await pickStarRating()
          if (score === undefined) return

          const feedback = await vscode.window.showInputBox({
            prompt: '反馈意见（可选）', placeHolder: '对本次代码生成的评价'
          })

          try {
            if (allDone) {
              await client.submitDecision(task.task_id, 'accept', { feedback, humanScore: score })
              markTaskFullyAccepted(task.task_id)
              tasksProvider.updateTaskStatus(task.task_id, 'human_accepted')
              vscode.window.showInformationMessage(`✅ 已全部接受并写入工作区（评分 ${score}★）`)
            } else {
              await client.submitDecision(task.task_id, 'partial_accept', {
                feedback, humanScore: score, acceptedFiles: acceptedPaths
              })
              markFilesAccepted(task.task_id, acceptedPaths)
              tasksProvider.updateTaskStatus(task.task_id, 'human_partial_accepted')
              vscode.window.showInformationMessage(
                `✅ 已接受 ${langLabel} 文件（${files.length} 个），其余文件可继续处理`
              )
            }
          } catch (err) {
            vscode.window.showErrorMessage(`上报失败: ${(err as Error).message}`)
            tasksProvider.refresh()
          }

        } else if (action === '📋 局部接受') {
          // 转到局部接受命令（带有 task 参数）
          await vscode.commands.executeCommand('awp.partialAccept', { task })
        }
        // ❌ 取消：临时文件保留供继续查看
      }
    )
  )
}

// ── 批量写入 ─────────────────────────────────────────────────
async function applyLangFilesToWorkspace(
  files: GeneratedFile[], _taskId: string, wsFolder: vscode.WorkspaceFolder | undefined
) {
  if (!wsFolder) {
    vscode.window.showWarningMessage('没有打开工作区文件夹，请先 File > Open Folder')
    return
  }
  for (const file of files) {
    const dest = path.join(wsFolder.uri.fsPath, file.path)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, file.content, 'utf8')
  }
}

// ── 应用单文件（交互模式） ────────────────────────────────────
async function applyFileToWorkspace(file: GeneratedFile, confirm = true) {
  const wsFolder = vscode.workspace.workspaceFolders?.[0]
  if (!wsFolder) throw new Error('没有打开工作区文件夹，请先 File > Open Folder')

  const destPath = path.join(wsFolder.uri.fsPath, file.path)
  const exists   = fs.existsSync(destPath)

  if (!confirm) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    fs.writeFileSync(destPath, file.content, 'utf8')
    return
  }

  const insertOptions: vscode.QuickPickItem[] = [
    {
      label: '$(new-file) 创建 / 覆盖文件', description: file.path,
      detail: exists ? '⚠️ 目标文件已存在，将被覆盖' : '将在工作区创建新文件'
    },
    {
      label: '$(eye) 在编辑器中预览（只读）', description: file.path,
      detail: '以只读方式打开，方便复制所需内容'
    }
  ]

  const picked = await vscode.window.showQuickPick(insertOptions, {
    placeHolder: `选择「${file.path}」的应用方式`, ignoreFocusOut: true
  })
  if (!picked) return

  if (picked.label.startsWith('$(new-file)')) {
    if (exists) {
      const c = await vscode.window.showWarningMessage(
        `文件已存在: ${file.path}\n要覆盖吗？`, { modal: true }, '覆盖', '查看 Diff'
      )
      if (c === '查看 Diff') {
        await vscode.commands.executeCommand('awp.viewDiff', { file, taskId: '_apply' })
        return
      }
      if (c !== '覆盖') return
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    fs.writeFileSync(destPath, file.content, 'utf8')
    vscode.window.showInformationMessage(`✅ 已写入: ${file.path}`)
    const doc = await vscode.workspace.openTextDocument(destPath)
    await vscode.window.showTextDocument(doc)

  } else if (picked.label.startsWith('$(eye)')) {
    const previewUri = vscode.Uri.parse(`${AWP_SCHEME}:/${Date.now()}/${file.path}?preview`)
    if (_contentProvider) _contentProvider.set(previewUri, file.content)
    const doc = await vscode.workspace.openTextDocument(previewUri)
    await vscode.window.showTextDocument(doc, { preview: true })
  }
}

// ── 1-5 星评分 ────────────────────────────────────────────────
async function pickStarRating(): Promise<number | undefined> {
  const items = [
    { label: '⭐⭐⭐⭐⭐  5 — 完美，直接上线',     score: 5 },
    { label: '⭐⭐⭐⭐  4 — 良好，略作调整',       score: 4 },
    { label: '⭐⭐⭐  3 — 还行，需小幅修改',       score: 3 },
    { label: '⭐⭐  2 — 需要较多修改',             score: 2 },
    { label: '⭐  1 — 质量较差，差距较大',         score: 1 },
  ]
  const picked = await vscode.window.showQuickPick(items, { placeHolder: '请为本次 AI 生成代码评分' })
  return picked?.score
}

// ── 批量 Diff WebView HTML ─────────────────────────────────
function buildBatchDiffHtml(
  task: TaskSummary,
  files: { path: string; language: string; role: string; lines: number; exists: boolean }[]
): string {
  const rows = files.map(f => `
    <tr class="file-row" onclick="openDiff('${f.path.replace(/'/g, "\\'")}')">
      <td><span class="lang ${f.language}">${f.language}</span></td>
      <td class="path">${f.path}</td>
      <td>${f.role}</td>
      <td>${f.lines} 行</td>
      <td>${f.exists ? '<span class="modify">修改</span>' : '<span class="new">新增</span>'}</td>
    </tr>
  `).join('')

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-foreground); padding: 16px; }
    h2 { color: var(--vscode-textLink-foreground); margin-bottom: 4px; }
    .subtitle { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 6px 12px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 11px; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
    .file-row { cursor: pointer; }
    .file-row:hover td { background: var(--vscode-list-hoverBackground); }
    td { padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 13px; }
    .path { font-family: var(--vscode-editor-font-family); }
    .lang { padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; }
    .go { background: #1a3a5c; color: #5b8cff; }
    .typescript { background: #0f2a1f; color: #4ade80; }
    .csharp { background: #2a1f3a; color: #a78bfa; }
    .new { color: #4ade80; font-size: 11px; }
    .modify { color: #f59e0b; font-size: 11px; }
    .actions { display: flex; gap: 8px; margin-top: 20px; }
    button { padding: 8px 18px; border-radius: 5px; cursor: pointer; font-size: 13px; border: none; }
    .btn-accept  { background: #1a4a1a; color: #4ade80; border: 1px solid #1e4a30; }
    .btn-partial { background: #1a2a4a; color: #5b8cff; border: 1px solid #2a3550; }
    .btn-reject  { background: #3a1010; color: #f87171; border: 1px solid #5a1a1a; }
    button:hover { opacity: 0.85; }
  </style>
  </head><body>
  <h2>📋 批量对比 — ${task.spec_title || task.task_id.slice(0, 8)}</h2>
  <div class="subtitle">${files.length} 个文件 · 点击行打开 Diff 视图</div>
  <table>
    <thead><tr><th>语言</th><th>文件路径</th><th>类型</th><th>行数</th><th>变更</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="actions">
    <button class="btn-accept"  onclick="send('acceptAll')">✅ 全部接受</button>
    <button class="btn-partial" onclick="send('partialAccept')">📋 局部接受</button>
    <button class="btn-reject"  onclick="send('reject')">❌ 拒绝任务</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    function openDiff(p) { vscode.postMessage({ command: 'openDiff', path: p }); }
    function send(cmd) { vscode.postMessage({ command: cmd }); }
  </script>
  </body></html>`
}

// ── KB Chunks WebView HTML ─────────────────────────────────
function buildMarkdownHtml(markdown: string): string {
  const html = markdown
    .split('\n')
    .map(line => {
      if (line.startsWith('## '))  return `<h2>${line.slice(3)}</h2>`
      if (line.startsWith('### ')) return `<h3>${line.slice(4)}</h3>`
      if (line.startsWith('- '))   return `<li>${line.slice(2)}</li>`
      if (line.startsWith('  '))   return `<div style="margin-left:16px;color:var(--vscode-descriptionForeground)">${line.trim()}</div>`
      return line ? `<p>${line}</p>` : ''
    })
    .join('\n')
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-foreground); padding: 20px; }
    h2,h3 { color: var(--vscode-textLink-foreground); }
    li { margin: 6px 0; }
  </style></head><body>${html}</body></html>`
}
