import { GeneratedFile } from '../schemas/types'

export function extractFilesFromOutput(raw: string): GeneratedFile[] {
  const files: GeneratedFile[] = []
  const pattern = /###\s*FILE:\s*([^\n]+)\n```(\w+)\n([\s\S]*?)```/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(raw)) !== null) {
    const [, filePath, lang, content] = match
    files.push({
      path: filePath.trim(),
      language: lang.toLowerCase().includes('go') ? 'go' : 'typescript',
      content: content.trim(),
      role: inferRole(filePath.trim())
    })
  }
  return files
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