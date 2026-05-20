import { extractFilesFromLLMOutput, validateGoFile, validateTSFile } from '../utils/code-parser'

describe('extractFilesFromLLMOutput', () => {

  it('正常解析标准格式输出', () => {
    const raw = `
这是生成的代码：

### FILE: server/daily_signin/handler.go
\`\`\`go
package daily_signin

import "net/http"

func HandleClaim(w http.ResponseWriter, r *http.Request) {}
\`\`\`

### FILE: client/daily_signin/api.ts
\`\`\`typescript
export async function claimReward(): Promise<void> {}
\`\`\`
`
    const files = extractFilesFromLLMOutput(raw)
    expect(files).toHaveLength(2)
    expect(files[0].path).toBe('server/daily_signin/handler.go')
    expect(files[0].language).toBe('go')
    expect(files[0].role).toBe('handler')
    expect(files[1].path).toBe('client/daily_signin/api.ts')
    expect(files[1].language).toBe('typescript')
  })

  it('fallback 解析：无 FILE 标注时按代码块切割', () => {
    const raw = `
\`\`\`go
package main
func main() {}
\`\`\`

\`\`\`typescript
export function foo() {}
\`\`\`
`
    const files = extractFilesFromLLMOutput(raw)
    expect(files.length).toBeGreaterThan(0)
  })

  it('LLM 输出无代码块时返回空数组', () => {
    const files = extractFilesFromLLMOutput('这是一段没有代码的纯文字回复')
    expect(files).toHaveLength(0)
  })

  it('正确识别测试文件角色', () => {
    const raw = `
### FILE: server/signin/handler_test.go
\`\`\`go
package signin_test
\`\`\`
`
    const files = extractFilesFromLLMOutput(raw)
    expect(files[0].role).toBe('test')
  })
})

describe('validateGoFile', () => {

  it('合法 Go 文件通过验证', () => {
    const content = `package signin

// HandleClaim 处理签到领奖请求
func HandleClaim() error {
    return nil
}
`
    const result = validateGoFile(content)
    expect(result.valid).toBe(true)
    expect(result.issues).toHaveLength(0)
  })

  it('缺少 package 声明时报错', () => {
    const result = validateGoFile('func main() {}')
    expect(result.valid).toBe(false)
    expect(result.issues).toContain('缺少 package 声明')
  })

  it('检测到 TODO 时报警告', () => {
    const result = validateGoFile('package main\n// TODO: implement this')
    expect(result.valid).toBe(false)
    expect(result.issues.some(i => i.includes('TODO'))).toBe(true)
  })
})

describe('validateTSFile', () => {

  it('合法 TS 文件通过验证', () => {
    const content = `
export interface SignInStatus {
  claimed: boolean
  streak: number
}

export async function getStatus(): Promise<SignInStatus> {
  return { claimed: false, streak: 0 }
}
`
    const result = validateTSFile(content)
    expect(result.valid).toBe(true)
  })

  it('过多 any 类型时报错', () => {
    const content = `
function a(x: any) {}
function b(y: any) {}
function c(z: any) {}
function d(w: any) {}
`
    const result = validateTSFile(content)
    expect(result.valid).toBe(false)
  })
})