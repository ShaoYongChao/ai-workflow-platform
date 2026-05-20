import {
  ApiResponse, SignInStatus, ClaimRequest, ClaimResponse, SignInError, SignInErrorCode
} from './types'

// API 基础地址从配置读取，禁止硬编码
const API_BASE = (typeof window !== 'undefined' && (window as any).__CONFIG__?.API_BASE)
  || process.env.NEXT_PUBLIC_API_URL
  || 'http://localhost:8080'

const REQUEST_TIMEOUT_MS = 10_000

// ── 基础请求封装 ────────────────────────────────────────────

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })

    const body: ApiResponse<T> = await res.json()

    if (!res.ok || body.code !== 0) {
      // 将后端错误码映射为客户端 SignInError
      throw new SignInError(
        body.msg || SignInErrorCode.SERVER_ERROR,
        body.msg || `请求失败 (${res.status})`
      )
    }

    return body.data as T

  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new SignInError(SignInErrorCode.NETWORK_ERROR, '请求超时，请检查网络')
    }
    if (err instanceof SignInError) throw err
    throw new SignInError(SignInErrorCode.NETWORK_ERROR, '网络异常，请稍后重试')
  } finally {
    clearTimeout(timer)
  }
}

// ── 签到相关 API ────────────────────────────────────────────

/**
 * 获取玩家当前签到状态
 * @param playerID 玩家 ID
 */
export async function getSignInStatus(playerID: string): Promise<SignInStatus> {
  return request<SignInStatus>(`/signin/status?player_id=${encodeURIComponent(playerID)}`)
}

/**
 * 执行签到领奖
 * @param req 签到请求
 * @throws {SignInError} code=already_claimed 时表示今日已领取
 */
export async function claimSignIn(req: ClaimRequest): Promise<ClaimResponse> {
  return request<ClaimResponse>('/signin/claim', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}