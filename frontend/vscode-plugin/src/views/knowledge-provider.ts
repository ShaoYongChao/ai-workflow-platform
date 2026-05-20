import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'

// ============================================================
// 知识库浏览 TreeView
//   读取 knowledge-base/index/kb.json，按文件分组展示 chunks。
//   主要给开发者一种「AI 在用什么参考代码」的可见性，方便理解
//   生成结果为什么是这样，以及决定是否往知识库里加新种子。
//
//   树形结构：
//     语言节点（Go / TypeScript）
//       └─ 文件节点（按 file 字段聚合）
//           └─ Chunk 节点（接口/struct/函数 等）
// ============================================================

// ── kb.json 中的 chunk 格式 ─────────────────────────────────
interface KBChunk {
  id: string
  type: 'interface' | 'struct' | 'function_signature' | 'class_signature' | 'error_definition'
  language: 'go' | 'typescript'
  file: string
  package?: string
  content: string
  symbols: string[]
  semantic: string
}

interface KnowledgeBase {
  version: string
  builtAt: string
  totalChunks: number
  chunks: KBChunk[]
}

// ── 节点类型 ────────────────────────────────────────────────
type Node = LanguageNode | FileNode | ChunkNode

class LanguageNode extends vscode.TreeItem {
  readonly kind = 'lang' as const
  override iconPath:     vscode.ThemeIcon
  override contextValue: string

  constructor(public readonly language: 'go' | 'typescript', count: number) {
    super(`${language === 'go' ? 'Go' : 'TypeScript'}  ·  ${count} chunks`,
      vscode.TreeItemCollapsibleState.Expanded)
    this.iconPath     = new vscode.ThemeIcon(language === 'go' ? 'symbol-package' : 'symbol-namespace')
    this.contextValue = 'awp-kb-lang'
  }
}

class FileNode extends vscode.TreeItem {
  readonly kind = 'file' as const
  override description:  string
  override tooltip:      string
  override iconPath:     vscode.ThemeIcon
  override contextValue: string

  constructor(public readonly file: string, public readonly chunks: KBChunk[]) {
    super(path.basename(file), vscode.TreeItemCollapsibleState.Collapsed)
    this.description  = path.dirname(file)
    this.tooltip      = `${file}\n${chunks.length} 个 chunk`
    this.iconPath     = new vscode.ThemeIcon('file-code')
    this.contextValue = 'awp-kb-file'
  }
}

class ChunkNode extends vscode.TreeItem {
  readonly kind = 'chunk' as const
  override description:  string
  override tooltip:      string
  override iconPath:     vscode.ThemeIcon
  override contextValue: string
  override command:      vscode.Command

  constructor(public readonly chunk: KBChunk) {
    super(extractSymbolName(chunk), vscode.TreeItemCollapsibleState.None)
    this.description  = chunk.type.replace('_', ' ')
    this.tooltip      = chunk.content.slice(0, 400) + (chunk.content.length > 400 ? '...' : '')
    this.iconPath     = new vscode.ThemeIcon(typeIcon(chunk.type))
    this.contextValue = 'awp-kb-chunk'
    this.command      = {
      command:   'awp.viewKBChunk',
      title:     '查看 Chunk 详情',
      arguments: [chunk]
    }
  }
}

// ── TreeDataProvider 实现 ───────────────────────────────────
export class KnowledgeProvider implements vscode.TreeDataProvider<Node> {
  private _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined | void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private kbCache: KnowledgeBase | null = null

  getTreeItem(element: Node): vscode.TreeItem {
    return element
  }

  async getChildren(element?: Node): Promise<Node[]> {
    const kb = this.loadKB()
    if (!kb) {
      // 未找到 kb.json，返回提示节点
      if (!element) {
        const hint = new vscode.TreeItem('未找到知识库索引', vscode.TreeItemCollapsibleState.None)
        hint.description = '请在设置中配置 awp.kbPath'
        hint.iconPath = new vscode.ThemeIcon('warning')
        hint.tooltip = '在 VS Code 设置中将 awp.kbPath 指向项目根目录下的 knowledge-base/index/kb.json'
        return [hint] as any
      }
      return []
    }
    if (kb.totalChunks === 0) return []

    // 顶层：按语言分组
    if (!element) {
      const langs: Node[] = []
      const goCount = kb.chunks.filter(c => c.language === 'go').length
      const tsCount = kb.chunks.filter(c => c.language === 'typescript').length
      if (goCount > 0) langs.push(new LanguageNode('go', goCount))
      if (tsCount > 0) langs.push(new LanguageNode('typescript', tsCount))
      return langs
    }

    // 语言节点 → 按文件聚合
    if (element.kind === 'lang') {
      const chunks = kb.chunks.filter(c => c.language === element.language)
      const byFile = new Map<string, KBChunk[]>()
      for (const c of chunks) {
        if (!byFile.has(c.file)) byFile.set(c.file, [])
        byFile.get(c.file)!.push(c)
      }
      return Array.from(byFile.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([file, cs]) => new FileNode(file, cs))
    }

    // 文件节点 → 展开 chunks
    if (element.kind === 'file') {
      // 接口 / 类型 优先排在前面
      const order: Record<KBChunk['type'], number> = {
        interface: 0, class_signature: 1, struct: 2,
        function_signature: 3, error_definition: 4
      }
      return element.chunks
        .slice()
        .sort((a, b) => (order[a.type] ?? 99) - (order[b.type] ?? 99))
        .map(c => new ChunkNode(c))
    }

    return []
  }

  refresh(): void {
    this.kbCache = null
    this._onDidChangeTreeData.fire()
  }

  // ── 加载 kb.json（多路径尝试） ────────────────────────────
  private loadKB(): KnowledgeBase | null {
    if (this.kbCache) return this.kbCache

    const candidates = this.candidatePaths()
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        try {
          this.kbCache = JSON.parse(fs.readFileSync(p, 'utf8'))
          return this.kbCache
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`AWP: kb.json 解析失败 ${p}: ${(err as Error).message}`)
        }
      }
    }

    return null
  }

  private candidatePaths(): string[] {
    const paths: string[] = []

    // 1. 用户显式指定的路径（优先）
    const custom = vscode.workspace.getConfiguration('awp').get<string>('kbPath')
    if (custom) paths.push(custom)

    // 2. 从工作区向上多层搜索
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (ws) {
      paths.push(path.join(ws, 'knowledge-base/index/kb.json'))
      paths.push(path.join(ws, '../knowledge-base/index/kb.json'))
      paths.push(path.join(ws, '../../knowledge-base/index/kb.json'))
      paths.push(path.join(ws, 'awp/knowledge-base/index/kb.json'))
      // 处理在 frontend/vscode-plugin 中开发的情况
      paths.push(path.join(ws, '../../knowledge-base/index/kb.json'))
      // 处理在 services/xxx 中开发的情况
      paths.push(path.join(ws, '../../../knowledge-base/index/kb.json'))
    }

    // 3. 从已打开的多根工作区中搜索
    for (const folder of (vscode.workspace.workspaceFolders || [])) {
      const fp = path.join(folder.uri.fsPath, 'knowledge-base/index/kb.json')
      if (!paths.includes(fp)) paths.push(fp)
    }

    return paths
  }
}

// ── 命令：查看 chunk 详情（弹出新文档窗口） ─────────────────
export async function showKBChunk(chunk: KBChunk): Promise<void> {
  const langId = chunk.language === 'go' ? 'go' : 'typescript'
  const doc = await vscode.workspace.openTextDocument({
    content:
      `// 来源: ${chunk.file}\n` +
      `// 类型: ${chunk.type}\n` +
      (chunk.package ? `// 包: ${chunk.package}\n` : '') +
      `// 符号: ${chunk.symbols.join(', ')}\n` +
      `// ──────────────────────────────────────\n\n` +
      chunk.content,
    language: langId
  })
  await vscode.window.showTextDocument(doc, { preview: true })
}

// ── 视觉辅助 ────────────────────────────────────────────────
function extractSymbolName(chunk: KBChunk): string {
  // 优先取符号列表的第一个有意义的名字
  const meaningful = chunk.symbols.filter(s =>
    !['Context','GET','POST','PUT','DELETE','Get','Set','Add','Save'].includes(s)
  )
  if (meaningful.length > 0) return meaningful[0]
  return chunk.symbols[0] || chunk.id.split(':').pop() || '(unnamed)'
}

function typeIcon(type: KBChunk['type']): string {
  return ({
    interface:          'symbol-interface',
    struct:             'symbol-structure',
    function_signature: 'symbol-method',
    class_signature:    'symbol-class',
    error_definition:   'warning',
  } as Record<string, string>)[type] || 'symbol-misc'
}
