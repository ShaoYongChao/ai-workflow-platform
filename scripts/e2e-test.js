#!/usr/bin/env node
'use strict'
/**
 * scripts/e2e-test.js  —  端到端联调，不依赖 Docker
 *
 * 运行：
 *   node scripts/e2e-test.js                         # Mock LLM
 *   ANTHROPIC_API_KEY=sk-ant-xxx node scripts/e2e-test.js  # 真实 LLM
 */

const fs = require('fs')
const path = require('path')
const https = require('https')

const ROOT = path.resolve(__dirname, '..')
try { require('dotenv').config({ path: path.join(ROOT, '.env') }) } catch { }

// ── 颜色 ──────────────────────────────────────────────────────
const c = {
    green: s => `\x1b[32m${s}\x1b[0m`,
    red: s => `\x1b[31m${s}\x1b[0m`,
    yellow: s => `\x1b[33m${s}\x1b[0m`,
    blue: s => `\x1b[34m${s}\x1b[0m`,
    bold: s => `\x1b[1m${s}\x1b[0m`,
    dim: s => `\x1b[2m${s}\x1b[0m`,
}

// ── 测试框架 ──────────────────────────────────────────────────
const results = []
let passed = 0, failed = 0

async function test(name, fn) {
    try {
        await fn()
        console.log(c.green(`  ✅ ${name}`))
        passed++
        results.push({ name, status: 'pass' })
    } catch (e) {
        console.log(c.red(`  ❌ ${name}: ${e.message}`))
        failed++
        results.push({ name, status: 'fail', error: e.message })
    }
}

function section(title) {
    console.log(`\n${c.bold(c.blue('▶ ' + title))}`)
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg)
}

// ── 每日签到 Spec ─────────────────────────────────────────────
const SPEC = {
    title: "每日签到领奖功能",
    goal: "玩家每日登录可领取奖励，连续签到获得额外奖励",
    platform: ["client", "server"],
    rules: {
        daily_reward: "每日只能领取一次",
        continuous_bonus: "连续签到7天可领取稀有道具箱",
        reset: "断签重置计数，不可补签"
    },
    entities: ["Player", "SignIn", "Reward"],
    api_contract: [
        { name: "getStatus", type: "GET" },
        { name: "claim", type: "POST" }
    ],
    acceptance: [
        "每日只能领取一次，重复领取返回错误",
        "连续7天签到正确触发额外奖励",
        "断签后计数归零"
    ],
    priority: "high"
}

// ── Mock LLM 输出（无 API Key 时使用） ───────────────────────
const MOCK_GO = `
### FILE: server/daily_signin/model.go
\`\`\`go
package daily_signin

import (
	"context"
	"time"
)

type SignInRecord struct {
	ID         string    \`json:"id"\`
	PlayerID   string    \`json:"player_id"\`
	SignInDate time.Time \`json:"sign_in_date"\`
	Streak     int       \`json:"streak"\`
}

type SignInRepository interface {
	GetTodayRecord(ctx context.Context, playerID string) (*SignInRecord, error)
	GetCurrentStreak(ctx context.Context, playerID string) (int, error)
	Save(ctx context.Context, record *SignInRecord) error
}

var ErrAlreadyClaimed = &SignInError{Code: "already_claimed", Message: "今日签到奖励已领取"}

type SignInError struct{ Code, Message string }
func (e *SignInError) Error() string { return e.Message }
\`\`\`

### FILE: server/daily_signin/service.go
\`\`\`go
package daily_signin

import (
	"context"
	"fmt"
	"time"
)

const (
	StreakBonusThreshold = 7
	DailyRewardCoin      = 100
	StreakBonusChestID   = "chest_rare_001"
)

type SignInService struct{ repo SignInRepository }

func NewSignInService(repo SignInRepository) *SignInService {
	return &SignInService{repo: repo}
}

func (s *SignInService) Claim(ctx context.Context, playerID string) error {
	existing, err := s.repo.GetTodayRecord(ctx, playerID)
	if err != nil { return fmt.Errorf("Claim: %w", err) }
	if existing != nil { return ErrAlreadyClaimed }
	streak, err := s.repo.GetCurrentStreak(ctx, playerID)
	if err != nil { return fmt.Errorf("Claim: get streak: %w", err) }
	return s.repo.Save(ctx, &SignInRecord{
		PlayerID: playerID, SignInDate: time.Now().UTC(), Streak: streak + 1,
	})
}
\`\`\`

### FILE: server/daily_signin/handler.go
\`\`\`go
package daily_signin

import (
	"encoding/json"
	"errors"
	"net/http"
)

type Handler struct{ svc *SignInService }
func NewHandler(svc *SignInService) *Handler { return &Handler{svc: svc} }

func (h *Handler) Claim(w http.ResponseWriter, r *http.Request) {
	var req struct{ PlayerID string \`json:"player_id"\` }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest); return
	}
	if req.PlayerID == "" {
		http.Error(w, "player_id required", http.StatusBadRequest); return
	}
	if err := h.svc.Claim(r.Context(), req.PlayerID); err != nil {
		var se *SignInError
		if errors.As(err, &se) && se.Code == "already_claimed" {
			w.WriteHeader(http.StatusConflict)
			json.NewEncoder(w).Encode(map[string]string{"code": se.Code, "msg": se.Message})
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError); return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"code": 0, "msg": "ok"})
}
\`\`\`

### FILE: server/daily_signin/handler_test.go
\`\`\`go
package daily_signin_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
)

type MockRepo struct{ mock.Mock }
func (m *MockRepo) GetTodayRecord(ctx context.Context, p string) (*SignInRecord, error) {
	args := m.Called(ctx, p)
	if args.Get(0) == nil { return nil, args.Error(1) }
	return args.Get(0).(*SignInRecord), args.Error(1)
}
func (m *MockRepo) GetCurrentStreak(ctx context.Context, p string) (int, error) {
	args := m.Called(ctx, p); return args.Int(0), args.Error(1)
}
func (m *MockRepo) Save(ctx context.Context, r *SignInRecord) error {
	return m.Called(ctx, r).Error(0)
}

func TestClaim_Success(t *testing.T) {
	repo := new(MockRepo)
	repo.On("GetTodayRecord", mock.Anything, "p1").Return(nil, nil)
	repo.On("GetCurrentStreak", mock.Anything, "p1").Return(3, nil)
	repo.On("Save", mock.Anything, mock.Anything).Return(nil)
	body, _ := json.Marshal(map[string]string{"player_id": "p1"})
	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	w := httptest.NewRecorder()
	NewHandler(NewSignInService(repo)).Claim(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestClaim_AlreadyClaimed(t *testing.T) {
	repo := new(MockRepo)
	repo.On("GetTodayRecord", mock.Anything, "p1").Return(&SignInRecord{PlayerID: "p1"}, nil)
	body, _ := json.Marshal(map[string]string{"player_id": "p1"})
	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	w := httptest.NewRecorder()
	NewHandler(NewSignInService(repo)).Claim(w, req)
	assert.Equal(t, http.StatusConflict, w.Code)
}

func TestClaim_MissingPlayerID(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader([]byte("{}")))
	w := httptest.NewRecorder()
	NewHandler(NewSignInService(new(MockRepo))).Claim(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)
}
\`\`\``

const MOCK_TS = `
### FILE: client/daily_signin/types.ts
\`\`\`typescript
export interface SignInStatus {
  claimed_today: boolean
  streak: number
  last_sign_in: string
}
export interface ClaimResponse { success: boolean; streak: number; message: string }
export class SignInError extends Error {
  constructor(public readonly code: string, message: string) { super(message) }
}
\`\`\`

### FILE: client/daily_signin/api.ts
\`\`\`typescript
import { SignInStatus, ClaimResponse, SignInError } from './types'
const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080'
async function req<T>(p: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(API + p, { ...opts, headers: {'Content-Type':'application/json',...opts.headers} })
  const body = await res.json()
  if (!res.ok || body.code !== 0) throw new SignInError(body.msg, body.msg)
  return body.data as T
}
export const getSignInStatus = (id: string) => req<SignInStatus>(\`/signin/status?player_id=\${id}\`)
export const claimSignIn     = (pid: string) => req<ClaimResponse>('/signin/claim', { method:'POST', body: JSON.stringify({player_id: pid}) })
\`\`\`

### FILE: client/daily_signin/DailySignInManager.ts
\`\`\`typescript
import { getSignInStatus, claimSignIn } from './api'
import { SignInStatus, ClaimResponse, SignInError } from './types'
export type Event = { type:'status_loaded';status:SignInStatus } | { type:'claim_success';response:ClaimResponse } | { type:'claim_failed';error:SignInError } | { type:'loading';loading:boolean }
export class DailySignInManager {
  private status: SignInStatus | null = null
  private claiming = false
  private listeners: ((e: Event) => void)[] = []
  constructor(private readonly playerID: string) {}
  on(l: (e: Event) => void) { this.listeners.push(l); return () => { this.listeners = this.listeners.filter(x => x !== l) } }
  private emit(e: Event) { this.listeners.forEach(l => l(e)) }
  async init() {
    this.emit({ type:'loading', loading:true })
    try { this.status = await getSignInStatus(this.playerID); this.emit({ type:'status_loaded', status:this.status }) }
    finally { this.emit({ type:'loading', loading:false }) }
  }
  async claim() {
    if (this.claiming || this.status?.claimed_today) {
      if (this.status?.claimed_today) this.emit({ type:'claim_failed', error: new SignInError('already_claimed','今日已领取') })
      return
    }
    this.claiming = true
    this.emit({ type:'loading', loading:true })
    try {
      const response = await claimSignIn(this.playerID)
      if (this.status) this.status = { ...this.status, claimed_today:true, streak:response.streak }
      this.emit({ type:'claim_success', response })
    } catch(err) {
      this.emit({ type:'claim_failed', error: err instanceof SignInError ? err : new SignInError('err','失败') })
    } finally { this.claiming = false; this.emit({ type:'loading', loading:false }) }
  }
  canClaim() { return !!this.status && !this.status.claimed_today && !this.claiming }
}
\`\`\`

### FILE: client/daily_signin/DailySignInManager.test.ts
\`\`\`typescript
import { DailySignInManager } from './DailySignInManager'
import * as api from './api'
jest.mock('./api')
const mockStatus = api.getSignInStatus as jest.MockedFunction<typeof api.getSignInStatus>
const mockClaim  = api.claimSignIn    as jest.MockedFunction<typeof api.claimSignIn>
describe('DailySignInManager', () => {
  let m: DailySignInManager
  beforeEach(() => { m = new DailySignInManager('p1'); jest.clearAllMocks() })
  it('init 成功', async () => {
    mockStatus.mockResolvedValue({ claimed_today:false, streak:3, last_sign_in:'' })
    await m.init()
    expect(m.canClaim()).toBe(true)
  })
  it('claim 成功触发事件', async () => {
    mockStatus.mockResolvedValue({ claimed_today:false, streak:0, last_sign_in:'' })
    mockClaim.mockResolvedValue({ success:true, streak:1, message:'ok' })
    await m.init()
    const events: any[] = []
    m.on(e => events.push(e))
    await m.claim()
    expect(events.find(e => e.type === 'claim_success')).toBeDefined()
  })
  it('已领取不发请求', async () => {
    mockStatus.mockResolvedValue({ claimed_today:true, streak:5, last_sign_in:'' })
    await m.init()
    await m.claim()
    expect(mockClaim).not.toHaveBeenCalled()
  })
})
\`\`\``

// ── 核心工具函数 ──────────────────────────────────────────────
function validateSpec(spec) {
    const required = ['title', 'goal', 'platform', 'rules', 'entities', 'api_contract', 'acceptance']
    const missing = required.filter(f => {
        const v = spec[f]; return !v || (Array.isArray(v) ? v.length === 0 : typeof v === 'object' && Object.keys(v).length === 0)
    })
    if (missing.length > 0) throw new Error(`缺少字段: ${missing.join(', ')}`)
    return { completeness: 100 }
}

function searchKB(chunks, spec) {
    const symbols = [...spec.entities, ...spec.api_contract.map(a => a.name)]
    const text = [spec.title, spec.goal, ...spec.entities].join(' ').toLowerCase()
    const words = text.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 2)
    return chunks
        .map(ch => {
            const symScore = symbols.filter(s => ch.symbols.includes(s) || ch.content.includes(s)).length
            const chWords = (ch.content + ' ' + ch.semantic).toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/)
            const textScore = words.filter(w => chWords.includes(w)).length / (words.length || 1)
            return { ch, score: symScore * 2 + textScore }
        })
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map(x => x.ch)
}

function extractFiles(raw) {
    const files = [], pat = /###\s*FILE:\s*([^\n]+)\n```(\w+)\n([\s\S]*?)```/g
    let m
    while ((m = pat.exec(raw)) !== null) {
        const [, fp, lang, content] = m
        const p = fp.toLowerCase()
        files.push({
            path: fp.trim(),
            language: lang.toLowerCase().includes('go') ? 'go' : 'typescript',
            content: content.trim(),
            role: p.includes('_test') || p.includes('.test.') ? 'test'
                : p.includes('handler') ? 'handler'
                    : p.includes('service') ? 'service'
                        : p.includes('model') || p.includes('types') ? 'model' : 'client'
        })
    }
    return files
}

function validateGoFile(content) {
    const issues = []
    if (!content.includes('package ')) issues.push('缺少 package 声明')
    if (content.includes('TODO')) issues.push('包含 TODO')
    return issues
}

function validateTSFile(content) {
    const issues = []
    if (content.split(': any').length > 4) issues.push('过多 any 类型')
    if (content.includes('console.log')) issues.push('包含 console.log')
    return issues
}

function calculateScore(testResults) {
    if (!testResults.length) return null
    const last = {}
    for (const r of testResults) last[r.language] = r
    const rs = Object.values(last)
    const tot = rs.reduce((s, r) => s + r.totalTests, 0)
    const pass = rs.reduce((s, r) => s + r.passedTests, 0)
    const cor = tot > 0 ? (pass / tot) * 100 : 0
    const covs = rs.map(r => r.coverage).filter(c => c != null)
    const cov = covs.length ? covs.reduce((s, c) => s + c, 0) / covs.length : 0
    const qual = cor >= 100 ? 80 : cor * 0.8
    return { correctness: Math.round(cor), coverage: Math.round(cov), quality: Math.round(qual), total: Math.round(cor * 0.35 + cov * 0.25 + qual * 0.20) }
}

async function callAnthropic(system, user) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 8192, temperature: 0.2, system, messages: [{ role: 'user', content: user }] })
        const req = https.request({
            hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) }
        }, res => {
            let raw = ''
            res.on('data', d => raw += d)
            res.on('end', () => {
                try {
                    const d = JSON.parse(raw)
                    if (d.error) reject(new Error(d.error.message))
                    else resolve(d.content.filter(b => b.type === 'text').map(b => b.text).join(''))
                } catch (e) { reject(e) }
            })
        })
        req.on('error', reject)
        req.write(body); req.end()
    })
}

// ── 主流程 ────────────────────────────────────────────────────
async function main() {
    const hasKey = !!process.env.ANTHROPIC_API_KEY
    console.log(c.bold('\n🚀 AWP 端到端联调'))
    console.log(c.dim(`   LLM: ${hasKey ? 'Anthropic API（真实）' : 'Mock 输出'}\n`))

    // STEP 1
    section('STEP 1: Spec 结构校验')
    await test('每日签到 Spec 通过校验', () => {
        const r = validateSpec(SPEC); assert(r.completeness === 100, '完整度不足')
    })
    await test('缺字段的 Spec 被拒绝', () => {
        let threw = false
        try { validateSpec({ title: 'x', goal: 'y' }) } catch { threw = true }
        assert(threw, '应该抛出错误')
    })

    // STEP 2
    section('STEP 2: 知识库检索')
    const kbPath = path.join(ROOT, 'knowledge-base/index/kb.json')
    let kb = null, context = null

    await test('知识库加载成功', () => {
        assert(fs.existsSync(kbPath), 'kb.json 不存在')
        kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'))
        assert(kb.totalChunks > 0, 'chunk 为 0')
        console.log(c.dim(`     → ${kb.totalChunks} chunks`))
    })

    await test('检索命中关键接口', () => {
        assert(kb, '知识库未加载')
        const matches = searchKB(kb.chunks, SPEC)
        const content = matches.map(c => c.content).join('\n')
        assert(content.includes('SignInRepository'), 'SignInRepository 未召回')
        assert(content.includes('Claim'), 'Claim 方法未召回')
        const go = matches.filter(m => m.language === 'go')
        const ts = matches.filter(m => m.language === 'typescript')
        console.log(c.dim(`     → Go:${go.length} TS:${ts.length} 共${matches.length}个chunk`))
        context = {
            relatedInterfaces: go.filter(m => m.type === 'interface' || m.type === 'function_signature').slice(0, 5).map(m => `// [${m.file}]\n${m.content}`),
            relatedModels: go.filter(m => m.type === 'struct').slice(0, 3).map(m => m.content),
        }
    })

    await test('interface 类型优先于 struct', () => {
        if (!kb) return
        const matches = searchKB(kb.chunks, SPEC)
        const ii = matches.findIndex(m => m.type === 'interface')
        const si = matches.findIndex(m => m.type === 'struct')
        if (ii >= 0 && si >= 0) assert(ii <= si, `interface(${ii}) 应 <= struct(${si})`)
    })

    // STEP 3
    section('STEP 3: Prompt 构建')
    let goPrompt, tsPrompt

    await test('Go Prompt 含必要约束', () => {
        const ctx = context || { relatedInterfaces: [], relatedModels: [] }
        const ifaceBlock = ctx.relatedInterfaces.join('\n')
        goPrompt = {
            system: `你是资深 Golang 工程师。\n必须生成4个文件：handler.go/service.go/model.go/handler_test.go\n格式：### FILE: <路径>\n\`\`\`go\n<代码>\n\`\`\`\n知识库接口：\n${ifaceBlock}\n禁止：Magic Number/忽略error/跨层调用`,
            user: `生成：${SPEC.title}\n目标：${SPEC.goal}\nAPI：${SPEC.api_contract.map(a => `${a.type} /${a.name}`).join('，')}\n实体：${SPEC.entities.join('，')}\n规则：\n${Object.entries(SPEC.rules).map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n验收：\n${SPEC.acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n')}`
        }
        assert(goPrompt.system.includes('handler_test.go'), '缺少测试文件要求')
        assert(goPrompt.user.includes('每日只能领取一次'), '缺少业务规则')
        if (ifaceBlock) assert(goPrompt.system.includes('SignIn'), '知识库接口未注入')
        console.log(c.dim(`     → system:${goPrompt.system.length}c user:${goPrompt.user.length}c`))
    })

    await test('TS Prompt 含必要约束', () => {
        tsPrompt = {
            system: `你是资深 TypeScript 工程师。\n必须生成4个文件：api.ts/types.ts/DailySignInManager.ts/DailySignInManager.test.ts\n格式：### FILE: <路径>\n\`\`\`typescript\n<代码>\n\`\`\`\n禁止：any类型/console.log/硬编码地址`,
            user: `生成：${SPEC.title}\nAPI：${SPEC.api_contract.map(a => `${a.type} /${a.name}`).join('，')}\n规则：\n${Object.entries(SPEC.rules).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`
        }
        assert(tsPrompt.system.includes('any类型'), '缺少 any 禁止')
        assert(tsPrompt.system.includes('DailySignInManager.test.ts'), '缺少测试文件要求')
    })

    // STEP 4
    section('STEP 4: LLM 代码生成')
    let goOut, tsOut

    await test('Go 代码生成', async () => {
        if (!hasKey) { goOut = MOCK_GO; console.log(c.dim('     → Mock 输出')); return }
        console.log(c.dim('     → 调用 Anthropic API (Go)...'))
        const t = Date.now()
        goOut = await callAnthropic(goPrompt.system, goPrompt.user)
        console.log(c.dim(`     → ${Date.now() - t}ms，${goOut.length} chars`))
    })

    await test('TS 代码生成', async () => {
        if (!hasKey) { tsOut = MOCK_TS; console.log(c.dim('     → Mock 输出')); return }
        console.log(c.dim('     → 调用 Anthropic API (TS)...'))
        const t = Date.now()
        tsOut = await callAnthropic(tsPrompt.system, tsPrompt.user)
        console.log(c.dim(`     → ${Date.now() - t}ms，${tsOut.length} chars`))
    })

    // STEP 5
    section('STEP 5: 代码文件解析')
    let goFiles = [], tsFiles = []

    await test('Go 输出解析出 ≥3 个文件', () => {
        goFiles = extractFiles(goOut || '').filter(f => f.language === 'go')
        console.log(c.dim(`     → ${goFiles.map(f => f.path).join(', ')}`))
        assert(goFiles.length >= 3, `期望 ≥3，实际 ${goFiles.length}`)
    })

    await test('TS 输出解析出 ≥3 个文件', () => {
        tsFiles = extractFiles(tsOut || '').filter(f => f.language === 'typescript')
        console.log(c.dim(`     → ${tsFiles.map(f => f.path).join(', ')}`))
        assert(tsFiles.length >= 3, `期望 ≥3，实际 ${tsFiles.length}`)
    })

    await test('包含测试文件', () => {
        const all = [...goFiles, ...tsFiles]
        assert(all.some(f => f.role === 'test'), '缺少 _test.go 或 .test.ts')
    })

    // STEP 6
    section('STEP 6: 代码质量验证')

    await test('Go 文件有 package 声明', () => {
        const noPackage = goFiles.filter(f => f.role !== 'test' && validateGoFile(f.content).some(i => i.includes('package')))
        assert(noPackage.length === 0, `以下文件缺少 package: ${noPackage.map(f => f.path).join(',')}`)
    })

    await test('TS 文件没有过多 any', () => {
        const anyTotal = tsFiles.reduce((n, f) => n + (f.content.split(': any').length - 1), 0)
        if (anyTotal > 0) console.log(c.yellow(`     ⚠️  共 ${anyTotal} 处 any`))
        assert(anyTotal < 8, `any 类型过多: ${anyTotal}`)
    })

    await test('handler 处理了 already_claimed', () => {
        const handler = goFiles.find(f => f.role === 'handler')
        assert(handler, '没有 handler 文件')
        const ok = handler.content.includes('Conflict') || handler.content.includes('409') || handler.content.includes('already_claimed')
        assert(ok, 'handler 未处理 already_claimed')
    })

    await test('测试文件覆盖验收标准', () => {
        const testContent = [...goFiles, ...tsFiles].filter(f => f.role === 'test').map(f => f.content).join('\n')
        assert(testContent.length > 0, '无测试内容')
        const hasAlreadyClaimed = testContent.includes('AlreadyClaimed') || testContent.includes('already_claimed') || testContent.includes('Conflict')
        assert(hasAlreadyClaimed, '测试未覆盖「已领取」验收标准')
    })

    // STEP 7
    section('STEP 7: 错误摘要（executor 层）')

    await test('失败摘要格式正确', () => {
        const summary = (() => {
            const parts = []
            const results = [{ language: 'go', status: 'fail', testCases: [{ name: 'TestClaim_Success', status: 'fail', errorMessage: 'expected 200, got 500' }] }]
            for (const r of results) {
                if (r.status === 'pass') continue
                parts.push(`=== ${r.language.toUpperCase()} ===`)
                r.testCases.filter(c => c.status === 'fail').forEach(c => parts.push(`  - ${c.name}: ${c.errorMessage}`))
            }
            return parts.join('\n')
        })()
        assert(summary.includes('GO'), '缺少语言标识')
        assert(summary.includes('TestClaim_Success'), '缺少测试名')
    })

    // STEP 8
    section('STEP 8: 评分计算')

    await test('全通过得高分', () => {
        const s = calculateScore([
            { language: 'go', totalTests: 4, passedTests: 4, coverage: 85, status: 'pass' },
            { language: 'typescript', totalTests: 3, passedTests: 3, coverage: 90, status: 'pass' }
        ])
        assert(s.correctness === 100, `正确性 ${s.correctness}`)
        assert(s.total > 50, `总分 ${s.total} 过低`)
        console.log(c.dim(`     → 正确性=${s.correctness} 覆盖=${s.coverage} 质量=${s.quality} 总分=${s.total}`))
    })

    await test('部分失败时分数更低', () => {
        const good = calculateScore([{ language: 'go', totalTests: 4, passedTests: 4, coverage: 85, status: 'pass' }])
        const bad = calculateScore([{ language: 'go', totalTests: 4, passedTests: 1, coverage: 20, status: 'fail' }])
        assert(good.total > bad.total, `good(${good.total}) 应 > bad(${bad.total})`)
    })

    // 保存生成文件
    section('保存生成结果')
    const outDir = path.join(ROOT, 'scripts/e2e-output')
    fs.mkdirSync(outDir, { recursive: true })
    const allFiles = [...goFiles, ...tsFiles]
    for (const f of allFiles) {
        const dest = path.join(outDir, f.path)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, f.content, 'utf8')
    }
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
        timestamp: new Date().toISOString(), usedRealLLM: hasKey,
        files: allFiles.map(f => ({ path: f.path, language: f.language, role: f.role, lines: f.content.split('\n').length }))
    }, null, 2))
    console.log(c.green(`  ✅ 已保存 ${allFiles.length} 个文件到 scripts/e2e-output/`))
    allFiles.forEach(f => console.log(c.dim(`     - ${f.path}  (${f.content.split('\n').length} 行)`)))

    // 最终报告
    console.log(`\n${'═'.repeat(52)}`)
    console.log(c.bold('端到端联调结果'))
    console.log(`${'═'.repeat(52)}`)
    console.log(`  ${c.green('通过')}: ${passed}  ${c.red('失败')}: ${failed}`)
    console.log(`  LLM:  ${hasKey ? c.green('Anthropic 真实调用') : c.yellow('Mock（设置 ANTHROPIC_API_KEY 可真实调用）')}`)

    if (failed > 0) {
        console.log(c.red('\n失败详情：'))
        results.filter(r => r.status === 'fail').forEach(r => console.log(`  ❌ ${r.name}: ${r.error}`))
        process.exit(1)
    } else {
        console.log(c.green('\n✅ 全部通过，端到端流程完整可用'))
        if (!hasKey) console.log(c.dim('\n  提示：ANTHROPIC_API_KEY=sk-ant-xxx node scripts/e2e-test.js'))
    }
}

main().catch(err => { console.error(c.red('致命错误:'), err); process.exit(1) })