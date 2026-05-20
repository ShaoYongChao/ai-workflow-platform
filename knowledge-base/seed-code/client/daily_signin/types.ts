// ── 与后端严格对齐的类型定义 ──────────────────────────────

export interface Reward {
  type: 'coin' | 'item' | 'chest'
  item_id?: string
  amount: number
}

export interface SignInStatus {
  claimed_today: boolean
  streak: number
  next_reward?: Reward
  last_sign_in: string // ISO 8601
}

export interface ClaimRequest {
  player_id: string
}

export interface ClaimResponse {
  success: boolean
  reward?: Reward
  streak: number
  message: string
}

// ── API 响应包装（与后端统一格式对齐） ──────────────────────
export interface ApiResponse<T> {
  code: number
  data?: T
  msg: string
}

// ── 错误类型 ────────────────────────────────────────────────
export class SignInError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'SignInError'
  }
}

export const SignInErrorCode = {
  ALREADY_CLAIMED: 'already_claimed',
  NETWORK_ERROR: 'network_error',
  SERVER_ERROR: 'server_error',
} as const