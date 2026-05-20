import { getSignInStatus, claimSignIn } from './api'
import { SignInStatus, ClaimResponse, SignInError, SignInErrorCode } from './types'

// ── 事件类型（解耦 UI，通过事件通知而非直接操作节点） ───────
export type SignInEvent =
  | { type: 'status_loaded'; status: SignInStatus }
  | { type: 'claim_success'; response: ClaimResponse }
  | { type: 'claim_failed'; error: SignInError }
  | { type: 'loading'; loading: boolean }

export type SignInEventListener = (event: SignInEvent) => void

/**
 * DailySignInManager 每日签到业务逻辑管理器
 *
 * 使用方式：
 * ```ts
 * const manager = new DailySignInManager('player_001')
 * manager.on(event => { ... }) // 监听状态变化
 * await manager.init()          // 初始化，拉取状态
 * await manager.claim()         // 执行签到
 * ```
 */
export class DailySignInManager {
  private playerID: string
  private status: SignInStatus | null = null
  private claiming = false              // 防重复点击标志
  private listeners: SignInEventListener[] = []

  constructor(playerID: string) {
    this.playerID = playerID
  }

  // ── 事件系统 ──────────────────────────────────────────────

  /** 注册事件监听器 */
  on(listener: SignInEventListener): () => void {
    this.listeners.push(listener)
    // 返回取消订阅函数
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener)
    }
  }

  private emit(event: SignInEvent): void {
    this.listeners.forEach(l => l(event))
  }

  // ── 公开方法 ──────────────────────────────────────────────

  /**
   * 初始化：拉取签到状态，登录后调用
   */
  async init(): Promise<void> {
    this.emit({ type: 'loading', loading: true })
    try {
      this.status = await getSignInStatus(this.playerID)
      this.emit({ type: 'status_loaded', status: this.status })
    } finally {
      this.emit({ type: 'loading', loading: false })
    }
  }

  /**
   * 执行签到领奖
   * - 防重复：请求进行中时忽略重复调用
   * - 幂等：今日已领取时触发 claim_failed(already_claimed)
   */
  async claim(): Promise<void> {
    if (this.claiming) return  // 防重复点击
    if (this.status?.claimed_today) {
      this.emit({
        type: 'claim_failed',
        error: new SignInError(SignInErrorCode.ALREADY_CLAIMED, '今日签到奖励已领取')
      })
      return
    }

    this.claiming = true
    this.emit({ type: 'loading', loading: true })

    try {
      const response = await claimSignIn({ player_id: this.playerID })

      // 更新本地状态（乐观更新）
      if (this.status) {
        this.status = {
          ...this.status,
          claimed_today: true,
          streak: response.streak,
        }
      }

      this.emit({ type: 'claim_success', response })
    } catch (err) {
      const error = err instanceof SignInError
        ? err
        : new SignInError(SignInErrorCode.SERVER_ERROR, '签到失败，请稍后重试')
      this.emit({ type: 'claim_failed', error })
    } finally {
      this.claiming = false
      this.emit({ type: 'loading', loading: false })
    }
  }

  /** 获取当前缓存状态（无需异步） */
  getStatus(): SignInStatus | null {
    return this.status
  }

  /** 是否可以签到 */
  canClaim(): boolean {
    return this.status !== null && !this.status.claimed_today && !this.claiming
  }
}