package daily_signin

import (
	"context"
	"errors"
	"fmt"
	"time"

	"go.uber.org/zap"
)

// ── 常量（禁止 Magic Number） ───────────────────────────────
const (
	StreakBonusThreshold = 7   // 连续签到 N 天触发额外奖励
	DailyRewardAmount    = 100 // 每日基础金币奖励
	StreakBonusChestID   = "chest_rare_001"
)

// SignInService 签到业务逻辑实现
type SignInService struct {
	repo   SignInRepository
	reward RewardServicer // 依赖注入，不直接调用具体实现
	logger *zap.Logger
}

// NewSignInService 构造函数（依赖注入）
func NewSignInService(repo SignInRepository, reward RewardServicer, logger *zap.Logger) *SignInService {
	return &SignInService{repo: repo, reward: reward, logger: logger}
}

// GetStatus 获取玩家签到状态
func (s *SignInService) GetStatus(ctx context.Context, playerID string) (*SignInStatus, error) {
	record, err := s.repo.GetTodayRecord(ctx, playerID)
	if err != nil {
		return nil, fmt.Errorf("GetStatus: get today record: %w", err)
	}

	streak, err := s.repo.GetCurrentStreak(ctx, playerID)
	if err != nil {
		return nil, fmt.Errorf("GetStatus: get streak: %w", err)
	}

	status := &SignInStatus{
		ClaimedToday: record != nil,
		Streak:       streak,
		NextReward:   s.calcNextReward(streak),
	}

	if record != nil {
		status.LastSignIn = record.SignInDate
	}

	return status, nil
}

// Claim 执行签到领奖（幂等）
func (s *SignInService) Claim(ctx context.Context, req ClaimRequest) (*ClaimResponse, error) {
	// 1. 检查今日是否已领取
	existing, err := s.repo.GetTodayRecord(ctx, req.PlayerID)
	if err != nil {
		return nil, fmt.Errorf("Claim: check existing: %w", err)
	}
	if existing != nil {
		return nil, ErrAlreadyClaimed
	}

	// 2. 获取当前连续天数
	streak, err := s.repo.GetCurrentStreak(ctx, req.PlayerID)
	if err != nil {
		return nil, fmt.Errorf("Claim: get streak: %w", err)
	}
	newStreak := streak + 1

	// 3. 计算本次奖励
	reward := s.calcReward(newStreak)

	// 4. 保存签到记录
	record := &SignInRecord{
		PlayerID:   req.PlayerID,
		SignInDate: time.Now().UTC(),
		Streak:     newStreak,
	}
	if err := s.repo.Save(ctx, record); err != nil {
		return nil, fmt.Errorf("Claim: save record: %w", err)
	}

	// 5. 发放奖励（通过 RewardService，不直接操作 Inventory）
	if err := s.reward.Grant(ctx, req.PlayerID, *reward); err != nil {
		// 奖励发放失败不回滚签到记录，记录错误供后续补偿
		s.logger.Error("Claim: grant reward failed",
			zap.String("playerID", req.PlayerID),
			zap.Error(err),
		)
	}

	s.logger.Info("player claimed daily signin",
		zap.String("playerID", req.PlayerID),
		zap.Int("streak", newStreak),
	)

	return &ClaimResponse{
		Success: true,
		Reward:  reward,
		Streak:  newStreak,
		Message: "签到成功",
	}, nil
}

// calcReward 计算当前签到应得奖励
func (s *SignInService) calcReward(streak int) *Reward {
	if streak%StreakBonusThreshold == 0 {
		// 连续签到 7 天额外奖励
		return &Reward{Type: "chest", ItemID: StreakBonusChestID, Amount: 1}
	}
	return &Reward{Type: "coin", Amount: DailyRewardAmount}
}

// calcNextReward 预告下次奖励
func (s *SignInService) calcNextReward(currentStreak int) *Reward {
	return s.calcReward(currentStreak + 1)
}

// ── 依赖的外部接口（只定义契约，不实现） ──────────────────

// RewardServicer 奖励发放接口（跨模块依赖注入）
type RewardServicer interface {
	Grant(ctx context.Context, playerID string, reward Reward) error
}

// ── 错误判断工具函数 ────────────────────────────────────────

func IsAlreadyClaimed(err error) bool {
	var e *SignInError
	return errors.As(err, &e) && e.Code == "already_claimed"
}
