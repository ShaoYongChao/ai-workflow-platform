package battle

import "context"

// BattleConfig 战斗数值配置
type BattleConfig struct {
  HeroID     string  `json:"hero_id"`
  BaseHP     int     `json:"base_hp"`
  BaseATK    int     `json:"base_atk"`
  GrowthRate float64 `json:"growth_rate"`
}

// ConfigRepository 配置数据访问接口
type ConfigRepository interface {
  // Get 获取指定英雄配置
  Get(ctx context.Context, heroID string) (*BattleConfig, error)
  // Update 更新配置（自动触发热重载）
  Update(ctx context.Context, cfg *BattleConfig) error
  // Rollback 回滚到上一个版本
  Rollback(ctx context.Context, heroID string) error
}

// ConfigServicer 配置业务接口
type ConfigServicer interface {
  GetConfig(ctx context.Context, heroID string) (*BattleConfig, error)
  UpdateConfig(ctx context.Context, cfg *BattleConfig) error
  RollbackConfig(ctx context.Context, heroID string) error
}

// ErrConfigNotFound 配置不存在
var ErrConfigNotFound = &ConfigError{Code: "config_not_found", Message: "配置不存在"}

// ErrValueOutOfRange 数值超出安全范围
var ErrValueOutOfRange = &ConfigError{Code: "value_out_of_range", Message: "配置数值超出安全范围"}

type ConfigError struct {
  Code    string
  Message string
}

func (e *ConfigError) Error() string { return e.Message }
