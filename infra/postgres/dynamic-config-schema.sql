-- ============================================================
-- 动态配置 Schema
-- 所有可变配置入库，底层代码永远不需要改
-- ============================================================

-- ── LLM 模型配置（多模型支持） ─────────────────────────────────
CREATE TABLE IF NOT EXISTS llm_providers (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          VARCHAR(100) NOT NULL UNIQUE,    -- 'gpt-4o', 'claude-3-5-sonnet', ...
    display_name  VARCHAR(200) NOT NULL,
    provider_type VARCHAR(50)  NOT NULL,           -- 'openai' | 'anthropic' | 'deepseek' | 'ollama' | 'azure' | 'gemini' | 'qwen' | 'zhipu' | 'custom'
    base_url      TEXT,                            -- 自定义/代理地址，null=使用官方
    api_key_env   VARCHAR(100),                    -- 从哪个环境变量读 key，如 'OPENAI_API_KEY'
    api_key_value TEXT,                            -- 或直接存加密后的 key（生产用 KMS）
    model_id      VARCHAR(200) NOT NULL,           -- 发给 API 的真实 model 字符串
    context_window INT DEFAULT 128000,
    max_output_tokens INT DEFAULT 8192,
    supports_streaming BOOLEAN DEFAULT true,
    supports_function_call BOOLEAN DEFAULT false,
    input_price_per_1k  NUMERIC(10,6) DEFAULT 0,  -- 美元/1k tokens
    output_price_per_1k NUMERIC(10,6) DEFAULT 0,
    enabled       BOOLEAN DEFAULT true,
    is_default    BOOLEAN DEFAULT false,           -- 全局默认模型
    extra_params  JSONB DEFAULT '{}',              -- temperature/top_p 等默认参数
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 预置主流模型
INSERT INTO llm_providers (name, display_name, provider_type, api_key_env, model_id, context_window, max_output_tokens, input_price_per_1k, output_price_per_1k, is_default) VALUES
  ('claude-sonnet-4',    'Claude Sonnet 4',         'anthropic', 'ANTHROPIC_API_KEY', 'claude-sonnet-4-20250514',    200000, 8192,  0.003, 0.015, true),
  ('claude-opus-4',      'Claude Opus 4',           'anthropic', 'ANTHROPIC_API_KEY', 'claude-opus-4-20250514',      200000, 8192,  0.015, 0.075, false),
  ('gpt-4o',             'GPT-4o',                  'openai',    'OPENAI_API_KEY',    'gpt-4o',                      128000, 8192,  0.005, 0.015, false),
  ('gpt-4o-mini',        'GPT-4o Mini',             'openai',    'OPENAI_API_KEY',    'gpt-4o-mini',                 128000, 8192,  0.00015, 0.0006, false),
  ('o1-preview',         'OpenAI o1 Preview',       'openai',    'OPENAI_API_KEY',    'o1-preview',                  128000, 32768, 0.015, 0.06, false),
  ('deepseek-v3',        'DeepSeek V3',             'deepseek',  'DEEPSEEK_API_KEY',  'deepseek-chat',               65536,  8192,  0.00027, 0.0011, false),
  ('deepseek-r1',        'DeepSeek R1',             'deepseek',  'DEEPSEEK_API_KEY',  'deepseek-reasoner',           65536,  8192,  0.00055, 0.0022, false),
  ('gemini-2-flash',     'Gemini 2.0 Flash',        'gemini',    'GEMINI_API_KEY',    'gemini-2.0-flash-exp',        1000000,8192,  0.00035, 0.0015, false),
  ('gemini-1-5-pro',     'Gemini 1.5 Pro',          'gemini',    'GEMINI_API_KEY',    'gemini-1.5-pro-002',          2000000,8192,  0.00125, 0.005, false),
  ('qwen-max',           'Qwen Max (通义千问)',       'qwen',      'QWEN_API_KEY',      'qwen-max',                    32768,  8192,  0.04, 0.12, false),
  ('qwen-turbo',         'Qwen Turbo',              'qwen',      'QWEN_API_KEY',      'qwen-turbo',                  131072, 8192,  0.003, 0.006, false),
  ('zhipu-glm4',         'GLM-4 (智谱AI)',           'zhipu',     'ZHIPU_API_KEY',     'glm-4',                       128000, 4096,  0.007, 0.007, false),
  ('ollama-llama3',      'Llama 3 (本地)',           'ollama',    '',                  'llama3:70b',                  8192,   4096,  0, 0, false),
  ('ollama-qwen2',       'Qwen2 (本地)',             'ollama',    '',                  'qwen2:72b',                   32768,  8192,  0, 0, false)
ON CONFLICT (name) DO NOTHING;

-- ── Skill 定义（数据库驱动，可在 UI 添加） ───────────────────
CREATE TABLE IF NOT EXISTS skill_definitions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          VARCHAR(100) NOT NULL UNIQUE,    -- 'my-custom-skill'
    display_name  VARCHAR(200) NOT NULL,
    description   TEXT NOT NULL,
    category      VARCHAR(50) DEFAULT 'custom',    -- 'builtin' | 'llm' | 'tool' | 'custom'
    -- 执行方式
    executor_type VARCHAR(50) NOT NULL DEFAULT 'llm_prompt',
    -- 'llm_prompt'   : 调 LLM，填写 system_prompt/user_prompt_template
    -- 'builtin_fn'   : 调内置函数，填写 function_name
    -- 'http_webhook' : 调外部 HTTP，填写 webhook_url
    -- 'js_script'    : 运行沙箱 JS，填写 script_code
    -- LLM Prompt 模式
    system_prompt TEXT,                            -- 支持 {{spec.title}} 等变量
    user_prompt_template TEXT,                     -- 支持 {{spec}} {{context}} 等变量
    preferred_llm VARCHAR(100) REFERENCES llm_providers(name) ON DELETE SET NULL,
    max_tokens    INT DEFAULT 4096,
    temperature   NUMERIC(3,2) DEFAULT 0.2,
    -- 内置函数模式
    function_name VARCHAR(100),                    -- 内置函数名，如 'fileParser' 'staticAnalysis'
    -- Webhook 模式
    webhook_url   TEXT,
    webhook_headers JSONB DEFAULT '{}',
    webhook_timeout_ms INT DEFAULT 10000,
    -- JS 脚本模式（沙箱执行）
    script_code   TEXT,
    -- 输入/输出 Schema（供 UI 生成表单 + 运行时验证）
    input_schema  JSONB DEFAULT '{}',
    output_schema JSONB DEFAULT '{}',
    -- 管理
    enabled       BOOLEAN DEFAULT true,
    is_builtin    BOOLEAN DEFAULT false,           -- true = 内置不可删除
    project_id    VARCHAR(100),                    -- NULL = 全局，否则项目私有
    version       VARCHAR(20) DEFAULT '1.0.0',
    created_by    VARCHAR(100),
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Agent 定义（数据库驱动） ───────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_definitions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          VARCHAR(100) NOT NULL UNIQUE,
    display_name  VARCHAR(200) NOT NULL,
    description   TEXT NOT NULL,
    domain        VARCHAR(100) DEFAULT '*',        -- '*' | 'game' | 'customer-service' | ...
    -- Agent 使用哪些 Skill（有序列表）
    skill_names   TEXT[] NOT NULL DEFAULT '{}',
    -- 执行配置
    system_prompt TEXT,                            -- Agent 级别的 System Prompt 模板
    preferred_llm VARCHAR(100) REFERENCES llm_providers(name) ON DELETE SET NULL,
    max_retries   INT DEFAULT 3,
    timeout_ms    INT DEFAULT 120000,
    temperature   NUMERIC(3,2) DEFAULT 0.2,
    -- 输入/输出约定
    input_from    TEXT[],                          -- 依赖哪些上游 Agent 的输出
    output_files  BOOLEAN DEFAULT true,            -- 是否输出文件
    output_schema JSONB DEFAULT '{}',
    -- 管理
    enabled       BOOLEAN DEFAULT true,
    is_builtin    BOOLEAN DEFAULT false,
    project_id    VARCHAR(100),
    version       VARCHAR(20) DEFAULT '1.0.0',
    created_by    VARCHAR(100),
    tags          TEXT[] DEFAULT '{}',
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── 流水线定义（数据库驱动） ───────────────────────────────────
CREATE TABLE IF NOT EXISTS pipeline_definitions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          VARCHAR(100) NOT NULL,
    display_name  VARCHAR(200) NOT NULL,
    description   TEXT,
    domain        VARCHAR(100) DEFAULT '*',
    nodes         JSONB NOT NULL,                  -- PipelineNode[] JSON
    -- nodes 示例：
    -- [{"agentName":"spec-agent","dependsOn":[],"optional":false},
    --  {"agentName":"codegen-agent","dependsOn":["spec-agent"]}]
    enabled       BOOLEAN DEFAULT true,
    is_default    BOOLEAN DEFAULT false,
    project_id    VARCHAR(100),
    created_by    VARCHAR(100),
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(name, project_id)
);

-- ── 知识库条目管理（通过 UI 添加/编辑/删除） ─────────────────
CREATE TABLE IF NOT EXISTS kb_entries (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    VARCHAR(100),
    title         VARCHAR(255) NOT NULL,
    content       TEXT NOT NULL,                   -- 代码/文档/规范内容
    entry_type    VARCHAR(50) DEFAULT 'code',       -- 'code' | 'document' | 'convention' | 'api_spec'
    language      VARCHAR(50),                     -- 'go' | 'typescript' | 'csharp' | ...
    file_path     VARCHAR(500),                    -- 对应源文件路径
    symbols       TEXT[] DEFAULT '{}',             -- 提取的符号名（用于 BM25）
    tags          TEXT[] DEFAULT '{}',
    quality_score INT DEFAULT 70,                  -- 0-100，低于阈值不入检索
    enabled       BOOLEAN DEFAULT true,
    source        VARCHAR(50) DEFAULT 'manual',    -- 'manual' | 'git_hook' | 'upload'
    created_by    VARCHAR(100),
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kb_project   ON kb_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_kb_language  ON kb_entries(project_id, language);
CREATE INDEX IF NOT EXISTS idx_kb_enabled   ON kb_entries(enabled);

-- ── 系统全局设置 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_settings (
    key           VARCHAR(200) PRIMARY KEY,
    value         JSONB NOT NULL,
    description   TEXT,
    category      VARCHAR(50) DEFAULT 'general',   -- 'general' | 'llm' | 'security' | 'feature_flags'
    updated_by    VARCHAR(100),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 默认系统设置
INSERT INTO system_settings (key, value, description, category) VALUES
  ('default_llm',              '"claude-sonnet-4"',          '全局默认 LLM 模型', 'llm'),
  ('spec_agent_llm',           '"claude-sonnet-4"',          '需求分析 Agent 使用的模型', 'llm'),
  ('codegen_agent_llm',        '"claude-sonnet-4"',          '代码生成 Agent 使用的模型', 'llm'),
  ('autofix_llm',              '"claude-sonnet-4"',          'Auto-Fix 使用的模型', 'llm'),
  ('enable_autofix',           'true',                       '是否启用 Auto-Fix', 'feature_flags'),
  ('enable_sonarqube',         'false',                      '是否启用 SonarQube', 'feature_flags'),
  ('max_autofix_retries',      '3',                          'Auto-Fix 最大重试次数', 'general'),
  ('sandbox_timeout_seconds',  '60',                         '沙箱执行超时', 'general'),
  ('kb_min_quality_score',     '60',                         '知识库最低质量分', 'general'),
  ('enable_memory_system',     'true',                       '是否启用记忆系统', 'feature_flags'),
  ('consolidation_threshold',  '3',                          '记忆巩固阈值（N天内访问次数）', 'general')
ON CONFLICT (key) DO NOTHING;

-- 自动更新 updated_at
CREATE OR REPLACE FUNCTION update_config_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_llm_updated      BEFORE UPDATE ON llm_providers      FOR EACH ROW EXECUTE FUNCTION update_config_updated_at();
CREATE TRIGGER trg_skill_def_updated BEFORE UPDATE ON skill_definitions  FOR EACH ROW EXECUTE FUNCTION update_config_updated_at();
CREATE TRIGGER trg_agent_def_updated BEFORE UPDATE ON agent_definitions  FOR EACH ROW EXECUTE FUNCTION update_config_updated_at();
CREATE TRIGGER trg_pipeline_updated BEFORE UPDATE ON pipeline_definitions FOR EACH ROW EXECUTE FUNCTION update_config_updated_at();
CREATE TRIGGER trg_kb_updated       BEFORE UPDATE ON kb_entries          FOR EACH ROW EXECUTE FUNCTION update_config_updated_at();

-- ── 默认流水线模板（内置） ──────────────────────────────────────
INSERT INTO pipeline_definitions (name, display_name, description, domain, nodes, is_default, enabled, created_by)
VALUES
  (
    'standard-codegen-pipeline',
    'Standard Code Generation Pipeline',
    'Default pipeline: spec-agent → codegen-agent → executor-agent',
    '*',
    '[
      {"agentName":"spec-agent","dependsOn":[],"optional":false},
      {"agentName":"codegen-agent","dependsOn":["spec-agent"],"optional":false},
      {"agentName":"executor-agent","dependsOn":["codegen-agent"],"optional":false}
    ]'::JSONB,
    true,
    true,
    'system'
  ),
  (
    'game-dev-pipeline',
    'Game Development Pipeline',
    'For game projects: spec → codegen → executor + optional analyzer',
    'game',
    '[
      {"agentName":"spec-agent","dependsOn":[],"optional":false},
      {"agentName":"codegen-agent","dependsOn":["spec-agent"],"optional":false},
      {"agentName":"executor-agent","dependsOn":["codegen-agent"],"optional":false},
      {"agentName":"analyzer-agent","dependsOn":["executor-agent"],"optional":true}
    ]'::JSONB,
    true,
    true,
    'system'
  ),
  (
    'quick-codegen-pipeline',
    'Quick Code Generation (No Exec)',
    'Faster pipeline for code-only: spec → codegen only',
    '*',
    '[
      {"agentName":"spec-agent","dependsOn":[],"optional":false},
      {"agentName":"codegen-agent","dependsOn":["spec-agent"],"optional":false}
    ]'::JSONB,
    true,
    true,
    'system'
  )
ON CONFLICT (name, project_id) DO NOTHING;
