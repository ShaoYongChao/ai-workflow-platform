import { GeneratedFile } from '../schemas/types'
import { logger } from './logger'

// ── 从 LLM 输出中提取所有代码文件 ──────────────────────────
// LLM 约定格式：
// ### FILE: server/signin/handler.go
// ```go
// package signin
// ...
// ```
export function extractFilesFromLLMOutput(raw: string): GeneratedFile[] {
  const files: GeneratedFile[] = []

  // 匹配 ### FILE: <path> 后跟代码块
  const filePattern = /###\s*FILE:\s*([^\n]+)\n```(\w+)\n([\s\S]*?)```/g
  let match: RegExpExecArray | null

  while ((match = filePattern.exec(raw)) !== null) {
    const [, filePath, lang, content] = match
    const path = filePath.trim()
    const language = normalizeLanguage(lang.trim())
    const role = inferRole(path)

    files.push({ path, language, content: content.trim(), role })
  }

  if (files.length === 0) {
    logger.warn('LLM 输出中未找到符合格式的文件块，尝试 fallback 解析')
    return fallbackParse(raw)
  }

  return files
}

function normalizeLanguage(lang: string): 'go' | 'typescript' | 'csharp' | 'java' | 'python' {
  const normalized = lang.toLowerCase()

  if (['go', 'golang'].includes(normalized)) return 'go'
  if (['typescript', 'ts', 'javascript', 'js'].includes(normalized)) return 'typescript'
  if (['csharp', 'c#', 'cs'].includes(normalized)) return 'csharp'
  if (['java'].includes(normalized)) return 'java'
  if (['python', 'py'].includes(normalized)) return 'python'

  // 默认 typescript（向后兼容）
  return 'typescript'
}

function inferRole(path: string): GeneratedFile['role'] {
  const p = path.toLowerCase()
  if (p.includes('_test') || p.includes('.test.') || p.includes('_spec')) return 'test'
  if (p.includes('handler') || p.includes('controller') || p.includes('router')) return 'handler'
  if (p.includes('service') || p.includes('usecase')) return 'service'
  if (p.includes('model') || p.includes('entity') || p.includes('dto')) return 'model'
  if (p.includes('types') || p.includes('interface')) return 'types'
  if (p.includes('client') || p.includes('api') || p.includes('hook')) return 'client'
  return 'service'
}

// ── Fallback：没有 FILE 标注时，尝试按语言切割 ──────────────
function fallbackParse(raw: string): GeneratedFile[] {
  const files: GeneratedFile[] = []
  const blocks = raw.matchAll(/```(go|typescript|ts)\n([\s\S]*?)```/g)
  let goIdx = 0
  let tsIdx = 0

  for (const block of blocks) {
    const [, lang, content] = block
    const language = normalizeLanguage(lang)
    const idx = language === 'go' ? goIdx++ : tsIdx++
    const ext = language === 'go' ? 'go' : 'ts'
    files.push({
      path: `generated/${language}_${idx}.${ext}`,
      language,
      content: content.trim(),
      role: 'service'
    })
  }
  return files
}

// ── 验证生成的 Go 文件基本结构 ─────────────────────────────
export function validateGoFile(content: string): { valid: boolean; issues: string[] } {
  const issues: string[] = []
  if (!content.includes('package ')) issues.push('缺少 package 声明')
  if (content.includes('TODO') || content.includes('FIXME')) issues.push('包含未完成的 TODO/FIXME')
  // 检查魔法数字（简单启发式）
  const magicNumbers = content.match(/\b(?<![\w.])\d{3,}\b(?![\w.])/g)
  if (magicNumbers && magicNumbers.length > 2) issues.push(`疑似魔法数字: ${magicNumbers.slice(0, 3).join(', ')}`)
  return { valid: issues.length === 0, issues }
}

// ── 验证 TypeScript 文件 ───────────────────────────────────
export function validateTSFile(content: string): { valid: boolean; issues: string[] } {
  const issues: string[] = []
  if (content.includes(': any') && content.split(': any').length > 3) {
    issues.push('过多的 any 类型，请明确类型定义')
  }
  if (content.includes('console.log') && !content.includes('// debug')) {
    issues.push('包含未清理的 console.log')
  }
  return { valid: issues.length === 0, issues }
}