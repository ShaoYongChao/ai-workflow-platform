import { FeatureSpec, RetrievalContext } from '../schemas/types'
import { logger } from '../utils/logger'

// ── Phase 1: Mock 检索服务 ──────────────────────────────────
// Phase 2 会替换为真实的 Hybrid RAG（Chroma + ES + Neo4j）
// 目前返回通用的 Go 游戏服务端规范，让 LLM 有基本约束可以遵循

export async function retrieveContext(spec: FeatureSpec): Promise<RetrievalContext> {
  logger.info({ specTitle: spec.title }, '[Mock] 检索上下文')

  // 根据 spec 中的实体和 API 推断可能涉及的接口
  const relatedInterfaces = buildMockInterfaces(spec)
  const conventions = getProjectConventions()

  return {
    relatedInterfaces,
    relatedModels: spec.entities.map((e: string) => buildEntityModel(e)),
    callGraph: buildCallGraph(spec),
    conventions,
    usedChunks: [],
    projectMemories: []
  }
}

// ── 根据 spec 推断相关接口 ──────────────────────────────────
function buildMockInterfaces(spec: FeatureSpec): string[] {
  const interfaces: string[] = []

  // 通用基础接口（所有功能都可能需要）
  interfaces.push('PlayerRepository.GetByID(ctx context.Context, playerID string) (*Player, error)')
  interfaces.push('RewardService.Grant(ctx context.Context, playerID string, reward Reward) error')
  interfaces.push('ConfigService.Get(key string) (interface{}, error)')
  interfaces.push('Logger.Info(msg string, fields ...zap.Field)')

  // 根据实体推断额外接口
  for (const entity of spec.entities) {
    const lower = entity.toLowerCase()
    if (lower.includes('signin') || lower.includes('sign')) {
      interfaces.push(`SignInRepository.GetRecord(ctx context.Context, playerID string, date time.Time) (*SignInRecord, error)`)
      interfaces.push(`SignInRepository.Save(ctx context.Context, record *SignInRecord) error`)
    }
    if (lower.includes('inventory') || lower.includes('item')) {
      interfaces.push(`InventoryService.Add(ctx context.Context, playerID string, itemID string, count int) error`)
    }
    if (lower.includes('config') || lower.includes('battle')) {
      interfaces.push(`ConfigLoader.Reload(ctx context.Context) error`)
      interfaces.push(`ConfigValidator.Validate(config interface{}) error`)
    }
  }

  return interfaces
}

function buildEntityModel(entity: string): string {
  return `type ${entity} struct { ID string \`json:"id"\`; CreatedAt time.Time \`json:"created_at"\` }`
}

function buildCallGraph(spec: FeatureSpec): string[] {
  return [
    `Handler → Service → Repository（严格分层，禁止跨层调用）`,
    `Service 层禁止直接操作 DB，必须通过 Repository interface`,
    `Handler 层只做参数校验和响应格式化，业务逻辑在 Service`
  ]
}

// ── 项目通用代码规范 ────────────────────────────────────────
function getProjectConventions(): string[] {
  return [
    '// 错误处理规范：使用 fmt.Errorf("operation: %w", err) 包装错误',
    '// 日志规范：使用 zap.Logger，禁止 fmt.Println',
    '// Context 规范：所有数据库操作第一个参数必须是 context.Context',
    '// 测试规范：使用 testify/assert，mock 用 testify/mock',
    '// 命名规范：接口名以 er 结尾（Repository, Servicer），实现加 Impl 后缀',
    '// 响应规范：统一使用 { "code": 0, "data": {}, "msg": "ok" } 结构'
  ]
}