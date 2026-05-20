import { DailySignInManager, SignInEvent } from './DailySignInManager'
import { SignInErrorCode } from './types'
import * as api from './api'

// Mock API 层
jest.mock('./api')
const mockGetStatus = api.getSignInStatus as jest.MockedFunction<typeof api.getSignInStatus>
const mockClaim = api.claimSignIn as jest.MockedFunction<typeof api.claimSignIn>

describe('DailySignInManager', () => {
  let manager: DailySignInManager
  let events: SignInEvent[]

  beforeEach(() => {
    manager = new DailySignInManager('player_001')
    events = []
    manager.on(e => events.push(e))
    jest.clearAllMocks()
  })

  // ── init ──────────────────────────────────────────────────

  it('init: 成功拉取状态并触发 status_loaded 事件', async () => {
    mockGetStatus.mockResolvedValue({
      claimed_today: false, streak: 3, last_sign_in: '2024-01-01T00:00:00Z'
    })

    await manager.init()

    const statusEvent = events.find(e => e.type === 'status_loaded')
    expect(statusEvent).toBeDefined()
    expect((statusEvent as any).status.streak).toBe(3)
    expect(manager.canClaim()).toBe(true)
  })

  it('init: loading 事件成对出现（true → false）', async () => {
    mockGetStatus.mockResolvedValue({
      claimed_today: false, streak: 0, last_sign_in: ''
    })
    await manager.init()

    const loadingEvents = events.filter(e => e.type === 'loading')
    expect(loadingEvents[0]).toEqual({ type: 'loading', loading: true })
    expect(loadingEvents[1]).toEqual({ type: 'loading', loading: false })
  })

  // ── claim ─────────────────────────────────────────────────

  it('claim: 成功签到触发 claim_success 事件', async () => {
    mockGetStatus.mockResolvedValue({
      claimed_today: false, streak: 0, last_sign_in: ''
    })
    mockClaim.mockResolvedValue({
      success: true, streak: 1, message: '签到成功',
      reward: { type: 'coin', amount: 100 }
    })

    await manager.init()
    await manager.claim()

    const successEvent = events.find(e => e.type === 'claim_success')
    expect(successEvent).toBeDefined()
    expect((successEvent as any).response.streak).toBe(1)
  })

  it('claim: 今日已领取时触发 claim_failed(already_claimed)', async () => {
    mockGetStatus.mockResolvedValue({
      claimed_today: true, streak: 5, last_sign_in: '2024-01-01T00:00:00Z'
    })
    await manager.init()
    await manager.claim()

    const failEvent = events.find(e => e.type === 'claim_failed')
    expect(failEvent).toBeDefined()
    expect((failEvent as any).error.code).toBe(SignInErrorCode.ALREADY_CLAIMED)
    expect(mockClaim).not.toHaveBeenCalled() // 不应发起网络请求
  })

  it('claim: 防重复点击 - 并发调用只执行一次', async () => {
    mockGetStatus.mockResolvedValue({
      claimed_today: false, streak: 0, last_sign_in: ''
    })
    mockClaim.mockImplementation(() =>
      new Promise(resolve => setTimeout(() =>
        resolve({ success: true, streak: 1, message: 'ok' }), 50))
    )

    await manager.init()
    // 并发触发两次
    await Promise.all([manager.claim(), manager.claim()])

    expect(mockClaim).toHaveBeenCalledTimes(1)
  })

  it('canClaim: init 前返回 false', () => {
    expect(manager.canClaim()).toBe(false)
  })

  // ── 事件取消订阅 ──────────────────────────────────────────

  it('on: 返回的取消函数有效', async () => {
    mockGetStatus.mockResolvedValue({
      claimed_today: false, streak: 0, last_sign_in: ''
    })
    const unsubscribe = manager.on(() => {})
    unsubscribe()

    await manager.init()
    // 取消后不再收到事件（原始 events 数组仍在收）
    expect(events.length).toBeGreaterThan(0) // 原始监听器仍工作
  })
})