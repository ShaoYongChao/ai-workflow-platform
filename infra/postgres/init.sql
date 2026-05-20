-- ============================================================
-- AI 工作流平台 - 数据库初始化
-- ============================================================

-- 功能需求记录
CREATE TABLE IF NOT EXISTS feature_specs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    raw_input TEXT NOT NULL,            -- 策划原始白话输入
    structured_spec JSONB NOT NULL,     -- 标准化后的 JSON Spec
    completeness_score FLOAT DEFAULT 0, -- AI 判断的完整度 0-100
    status VARCHAR(50) DEFAULT 'draft', -- draft | submitted | generating | done | failed
    project_id VARCHAR(100),
    created_by VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 代码生成任务
CREATE TABLE IF NOT EXISTS generation_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    spec_id UUID REFERENCES feature_specs(id),
    status VARCHAR(50) DEFAULT 'pending', -- pending | running | success | failed | manual_review
    priority VARCHAR(10) DEFAULT 'P1',    -- P0 | P1 | P2
    retry_count INT DEFAULT 0,
    max_retries INT DEFAULT 3,
    generated_files JSONB,               -- 生成的文件列表及内容
    test_result JSONB,                   -- 测试执行结果
    kb_chunks_used JSONB,                -- 代码生成时使用的知识库 chunks: [{ id, type, language, file }]
    error_log TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 评分记录
CREATE TABLE IF NOT EXISTS score_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES generation_tasks(id),
    correctness_score FLOAT,   -- 单元测试通过率 (权重35%)
    test_coverage FLOAT,       -- 测试覆盖率 (权重25%)
    quality_score FLOAT,       -- SonarQube质量分 (权重20%)
    maintainability FLOAT,     -- 圈复杂度等 (权重10%)
    human_score FLOAT,         -- 开发者主观评分1-5 (权重10%)
    total_score FLOAT,         -- 综合加权得分
    feedback_text TEXT,        -- 开发者文字反馈
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 审计日志（安全合规）
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action VARCHAR(100) NOT NULL,  -- spec_created | code_generated | knowledge_queried 等
    actor VARCHAR(100),
    resource_type VARCHAR(50),
    resource_id UUID,
    project_id VARCHAR(100),
    metadata JSONB,
    ip_address INET,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 失败样本（用于模型优化）
CREATE TABLE IF NOT EXISTS failure_samples (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES generation_tasks(id),
    failure_type VARCHAR(100),   -- test_failure | compile_error | quality_gate | human_reject
    error_detail TEXT,
    spec_snapshot JSONB,
    generated_code TEXT,
    fix_attempts JSONB,          -- 每次 Auto-Fix 的记录
    resolved BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 用户偏好记忆（个性化）
CREATE TABLE IF NOT EXISTS developer_preferences (
    developer_id VARCHAR(100) PRIMARY KEY,
    naming_style VARCHAR(50),           -- camelCase | snake_case | PascalCase
    prefers_class_over_hook BOOLEAN,
    preferred_patterns JSONB,           -- 常用设计模式
    custom_constraints TEXT[],          -- 自定义约束
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_specs_project ON feature_specs(project_id);
CREATE INDEX IF NOT EXISTS idx_specs_status ON feature_specs(status);
CREATE INDEX IF NOT EXISTS idx_tasks_spec ON generation_tasks(spec_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON generation_tasks(status);
CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

-- 自动更新 updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_specs_updated_at
    BEFORE UPDATE ON feature_specs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- 记忆系统 Schema（Hemers 架构）
-- ============================================================

-- ── 会话记忆（短期，任务完成后销毁） ─────────────────────────
-- 存在 Redis 里，这里只做持久化备份
CREATE TABLE IF NOT EXISTS session_memories (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id   VARCHAR(100) NOT NULL,   -- 任务 ID 或对话 ID
    project_id   VARCHAR(100),
    developer_id VARCHAR(100),
    content      TEXT NOT NULL,           -- 记忆内容（对话摘要、关键决策）
    embedding    FLOAT[],                 -- 向量（可选，Chroma 里存）
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    expires_at   TIMESTAMPTZ             -- 到期自动清理
);
CREATE INDEX IF NOT EXISTS idx_session_mem_session ON session_memories(session_id);
CREATE INDEX IF NOT EXISTS idx_session_mem_expires ON session_memories(expires_at);

-- ── 长期项目记忆（项目存续期间） ─────────────────────────────
CREATE TABLE IF NOT EXISTS project_memories (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   VARCHAR(100) NOT NULL,
    memory_type  VARCHAR(50) NOT NULL,    -- 'architecture' | 'pattern' | 'convention' | 'best_practice'
    title        VARCHAR(255) NOT NULL,
    content      TEXT NOT NULL,
    source_task  UUID REFERENCES generation_tasks(id),
    access_count INT DEFAULT 0,
    last_accessed TIMESTAMPTZ,
    confidence   FLOAT DEFAULT 0.5,      -- 0-1，越高越可信
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_proj_mem_project  ON project_memories(project_id);
CREATE INDEX IF NOT EXISTS idx_proj_mem_type     ON project_memories(project_id, memory_type);
CREATE INDEX IF NOT EXISTS idx_proj_mem_access   ON project_memories(access_count DESC);

-- ── 技能记忆（可复用生成模板） ───────────────────────────────
CREATE TABLE IF NOT EXISTS skill_memories (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   VARCHAR(100),             -- NULL = 全局技能
    skill_name   VARCHAR(100) NOT NULL,    -- 'generate_reward_system'
    description  TEXT NOT NULL,
    template     TEXT NOT NULL,            -- Prompt 模板或代码框架
    input_schema JSONB,                    -- 输入参数 Schema
    success_rate FLOAT DEFAULT 0,          -- 使用成功率
    use_count    INT DEFAULT 0,
    last_used_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_name ON skill_memories(project_id, skill_name);

-- ── 巩固记录（Consolidation 日志） ───────────────────────────
CREATE TABLE IF NOT EXISTS consolidation_logs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id       VARCHAR(100),
    source_session   VARCHAR(100),
    target_memory_id UUID REFERENCES project_memories(id),
    consolidated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 自动更新 updated_at
CREATE TRIGGER trg_proj_mem_updated
    BEFORE UPDATE ON project_memories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_skill_updated
    BEFORE UPDATE ON skill_memories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- SonarQube 需要独立的数据库
CREATE DATABASE sonarqube OWNER awp;
