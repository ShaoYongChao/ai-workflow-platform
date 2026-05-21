import { GeneratedFile } from '../schemas/types'

export function extractFilesFromOutput(raw: string): GeneratedFile[] {
  const files: GeneratedFile[] = []
  const pattern = /###\s*FILE:\s*([^\n]+)\n```(\w+)\n([\s\S]*?)```/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(raw)) !== null) {
    const [, filePath, lang, content] = match
    files.push({
      path: filePath.trim(),
      language: normalizeLanguage(lang),
      content: content.trim(),
      role: inferRole(filePath.trim())
    })
  }
  return files
}

function normalizeLanguage(lang: string): 'go' | 'typescript' | 'csharp' | 'java' | 'python' {
  const normalized = lang.toLowerCase()

  if (normalized.includes('go')) return 'go'
  if (normalized.includes('typescript') || normalized.includes('ts') || normalized.includes('javascript')) return 'typescript'
  if (normalized.includes('csharp') || normalized.includes('c#') || normalized.includes('cs')) return 'csharp'
  if (normalized.includes('java')) return 'java'
  if (normalized.includes('python') || normalized.includes('py')) return 'python'

  // 默认 typescript（向后兼容）
  return 'typescript'
}

function inferRole(p: string): GeneratedFile['role'] {
  const l = p.toLowerCase()
  if (l.includes('_test') || l.includes('.test.')) return 'test'
  if (l.includes('handler') || l.includes('controller')) return 'handler'
  if (l.includes('service')) return 'service'
  if (l.includes('model') || l.includes('entity')) return 'model'
  if (l.includes('types') || l.includes('interface')) return 'types'
  return 'client'
}