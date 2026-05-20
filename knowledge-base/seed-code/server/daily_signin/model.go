package daily_signin

import (
	"context"
	"time"
)

// SignInRecord 玩家签到记录
type SignInRecord struct {
	ID         string    `json:"id" db:"id"`
	PlayerID   string    `json:"player_id" db:"player_id"`
	SignInDate time.Time `json:"sign_in_date" db:"sign_in_date"`
	Streak     int       `json:"streak" db:"streak"` // 连续签到天数
	CreatedAt  time.Time `json:"created_at" db:"created_at"`
}

// SignInStatus 签到状态（返回给客户端）
type SignInStatus struct {
	ClaimedToday bool      `json:"claimed_today"`
	Streak       int       `json:"streak"`
	NextReward   *Reward   `json:"next_reward,omitempty"`
	LastSignIn   time.Time `json:"last_sign_in"`
}

// Reward 奖励结构
type Reward struct {
	Type   string `json:"type"` // "coin" | "item" | "chest"
	ItemID string `json:"item_id,omitempty"`
	Amount int    `json:"amount"`
}

// ClaimRequest 领奖请求
type ClaimRequest struct {
	PlayerID string `json:"player_id" validate:"required"`
}

// ClaimResponse 领奖响应
type ClaimResponse struct {
	Success bool    `json:"success"`
	Reward  *Reward `json:"reward,omitempty"`
	Streak  int     `json:"streak"`
	Message string  `json:"message"`
}

// ── Repository 接口（数据层契约，Handler/Service 只依赖此接口） ──

// SignInRepository 签到数据访问接口
type SignInRepository interface {
	// GetTodayRecord 获取玩家今日签到记录，无记录返回 nil, nil
	GetTodayRecord(ctx context.Context, playerID string) (*SignInRecord, error)

	// GetCurrentStreak 获取玩家当前连续签到天数
	GetCurrentStreak(ctx context.Context, playerID string) (int, error)

	// Save 保存签到记录
	Save(ctx context.Context, record *SignInRecord) error
}

// ── Service 接口（业务层契约） ──────────────────────────────

// SignInServicer 签到业务逻辑接口
type SignInServicer interface {
	// GetStatus 获取玩家当前签到状态
	GetStatus(ctx context.Context, playerID string) (*SignInStatus, error)

	// Claim 执行签到领奖，幂等：同一天重复调用返回 ErrAlreadyClaimed
	Claim(ctx context.Context, req ClaimRequest) (*ClaimResponse, error)
}

// ── 错误定义 ────────────────────────────────────────────────

// ErrAlreadyClaimed 今日已领取
var ErrAlreadyClaimed = newSignInError("already_claimed", "今日签到奖励已领取")

// ErrPlayerNotFound 玩家不存在
var ErrPlayerNotFound = newSignInError("player_not_found", "玩家不存在")

type SignInError struct {
	Code    string
	Message string
}

func (e *SignInError) Error() string { return e.Message }

func newSignInError(code, msg string) *SignInError {
	return &SignInError{Code: code, Message: msg}
}
