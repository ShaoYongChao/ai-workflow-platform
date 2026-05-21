-- ============================================================
-- 初始化 Skill 和 Agent 定义
-- 这个脚本在 docker-compose up 时被执行，填充示例数据
-- ============================================================

-- ── 清空现有数据（可选，开发环境用）──────────────────────
-- DELETE FROM agent_definitions WHERE is_builtin = false;
-- DELETE FROM skill_definitions WHERE is_builtin = false;

-- ── 预置内置 Skill（对应 builtin-skills.ts 中的函数）────────

-- Skill 1: LLM 调用（最常用）
INSERT INTO skill_definitions (
  name, display_name, description, category, executor_type,
  system_prompt, user_prompt_template, preferred_llm, max_tokens, temperature,
  is_builtin
) VALUES (
  'llm-call',
  'LLM 调用',
  '通过 LLM 生成内容、进行推理或数据转换',
  'builtin',
  'llm_prompt',
  'You are a professional {{domain}} developer. Generate high-quality code following best practices.',
  '{{input.prompt}}',
  'claude-sonnet-4',
  4096,
  0.2,
  true
) ON CONFLICT (name) DO UPDATE SET
  updated_at = NOW(),
  system_prompt = EXCLUDED.system_prompt,
  user_prompt_template = EXCLUDED.user_prompt_template;

-- Skill 2: 文件解析
INSERT INTO skill_definitions (
  name, display_name, description, category, executor_type,
  function_name, is_builtin
) VALUES (
  'file-parser',
  '文件解析',
  '解析代码文件，提取结构、类型、函数签名等',
  'builtin',
  'builtin_fn',
  'fileParserSkill',
  true
) ON CONFLICT (name) DO NOTHING;

-- Skill 3: 静态分析
INSERT INTO skill_definitions (
  name, display_name, description, category, executor_type,
  function_name, is_builtin
) VALUES (
  'static-analysis',
  '静态分析',
  '分析代码质量、检测代码异味、安全问题等',
  'builtin',
  'builtin_fn',
  'staticAnalysisSkill',
  true
) ON CONFLICT (name) DO NOTHING;

-- Skill 4: 知识库检索
INSERT INTO skill_definitions (
  name, display_name, description, category, executor_type,
  function_name, is_builtin
) VALUES (
  'knowledge-retrieval',
  '知识库检索',
  '从知识库中检索相关代码示例和最佳实践',
  'builtin',
  'builtin_fn',
  'knowledgeRetrievalSkill',
  true
) ON CONFLICT (name) DO NOTHING;

-- Skill 5: 记忆注入
INSERT INTO skill_definitions (
  name, display_name, description, category, executor_type,
  function_name, is_builtin
) VALUES (
  'memory-inject',
  '记忆注入',
  '从项目记忆库中提取相关的历史决策和最佳实践',
  'builtin',
  'builtin_fn',
  'memoryInjectSkill',
  true
) ON CONFLICT (name) DO NOTHING;

-- ── 示例 Skill: HTTP Webhook（用户可参考创建自己的） ────────

INSERT INTO skill_definitions (
  name, display_name, description, category, executor_type,
  webhook_url, webhook_headers, webhook_timeout_ms,
  is_builtin
) VALUES (
  'external-linter',
  '外部代码检查',
  '调用外部代码检查服务（如 SonarQube）',
  'custom',
  'http_webhook',
  'http://sonarqube:9000/api/ce/activity',
  '{"Authorization": "Bearer YOUR_SONAR_TOKEN"}',
  15000,
  false
) ON CONFLICT (name) DO NOTHING;

-- ── 示例 Skill: JS 脚本（沙箱运行）─────────────────────────

INSERT INTO skill_definitions (
  name, display_name, description, category, executor_type,
  script_code,
  is_builtin
) VALUES (
  'code-formatter',
  '代码格式化',
  '使用 JavaScript 对代码进行格式化（保证一致性）',
  'custom',
  'js_script',
  'const fs = require("path"); result = { formatted: input.code, isValid: true };',
  false
) ON CONFLICT (name) DO NOTHING;

-- ── 预置内置 Agent（对应 agent-registry.ts 中的硬编码 Agent）──

-- Agent 1: Spec 分析
INSERT INTO agent_definitions (
  name, display_name, description, domain,
  skill_names, system_prompt, preferred_llm, max_retries,
  is_builtin
) VALUES (
  'spec-analysis-agent',
  'Spec 分析',
  '分析、规范化需求文档，确保可执行',
  '*',
  '{"llm-call", "knowledge-retrieval", "memory-inject"}',
  'You are a requirements analyst. Analyze the spec and ensure it is clear, executable, and follows conventions.',
  'claude-sonnet-4',
  3,
  true
) ON CONFLICT (name) DO UPDATE SET
  updated_at = NOW(),
  system_prompt = EXCLUDED.system_prompt,
  skill_names = EXCLUDED.skill_names;

-- Agent 2: 代码生成
INSERT INTO agent_definitions (
  name, display_name, description, domain,
  skill_names, system_prompt, preferred_llm, max_retries,
  is_builtin
) VALUES (
  'codegen-agent',
  '代码生成',
  '根据需求 Spec 生成高质量代码',
  '*',
  '{"llm-call", "knowledge-retrieval", "file-parser"}',
  'You are an expert code generator. Generate clean, well-structured code that passes all tests.',
  'claude-sonnet-4',
  3,
  true
) ON CONFLICT (name) DO UPDATE SET
  updated_at = NOW(),
  system_prompt = EXCLUDED.system_prompt,
  skill_names = EXCLUDED.skill_names;

-- Agent 3: 测试执行
INSERT INTO agent_definitions (
  name, display_name, description, domain,
  skill_names, system_prompt, preferred_llm, max_retries,
  is_builtin
) VALUES (
  'test-agent',
  '测试执行',
  '执行代码测试，收集覆盖率和失败信息',
  '*',
  '{"static-analysis", "file-parser"}',
  'You are a QA expert. Ensure all tests pass and code quality meets standards.',
  'claude-sonnet-4',
  3,
  true
) ON CONFLICT (name) DO UPDATE SET
  updated_at = NOW(),
  system_prompt = EXCLUDED.system_prompt,
  skill_names = EXCLUDED.skill_names;

-- Agent 4: 代码重构
INSERT INTO agent_definitions (
  name, display_name, description, domain,
  skill_names, system_prompt, preferred_llm, max_retries,
  is_builtin
) VALUES (
  'refactor-agent',
  '代码重构',
  '优化代码结构、性能和可维护性',
  '*',
  '{"llm-call", "static-analysis", "memory-inject"}',
  'You are a code quality expert. Refactor code to improve readability, performance, and maintainability.',
  'claude-sonnet-4',
  2,
  true
) ON CONFLICT (name) DO UPDATE SET
  updated_at = NOW(),
  system_prompt = EXCLUDED.system_prompt,
  skill_names = EXCLUDED.skill_names;

-- Agent 5: Unity3D 代码生成
INSERT INTO agent_definitions (
  name, display_name, description, domain,
  skill_names, system_prompt, preferred_llm, max_retries,
  is_builtin
) VALUES (
  'unity3d-agent',
  'Unity3D 代码生成',
  '生成适配 Unity3D 的 C# 客户端代码',
  'game',
  '{"llm-call", "knowledge-retrieval"}',
  'You are a Unity3D expert. Generate clean, optimized C# code following Unity best practices. Focus on performance and memory management.',
  'claude-sonnet-4',
  3,
  true
) ON CONFLICT (name) DO UPDATE SET
  updated_at = NOW(),
  system_prompt = EXCLUDED.system_prompt,
  skill_names = EXCLUDED.skill_names;

-- ── 示例自定义 Agent（用户可参考创建）────────────────────

-- 游戏全栈 Agent
INSERT INTO agent_definitions (
  name, display_name, description, domain,
  skill_names, system_prompt, preferred_llm, max_retries,
  is_builtin
) VALUES (
  'game-fullstack-agent',
  '游戏全栈',
  '协调游戏服务端和客户端代码生成',
  'game',
  '{"spec-analysis-agent", "codegen-agent", "unity3d-agent", "test-agent"}',
  'You orchestrate full-stack game development. Ensure server and client code are properly integrated.',
  'claude-sonnet-4',
  3,
  false
) ON CONFLICT (name) DO NOTHING;

-- 客服智能体 Agent
INSERT INTO agent_definitions (
  name, display_name, description, domain,
  skill_names, system_prompt, preferred_llm, max_retries,
  is_builtin
) VALUES (
  'customer-service-agent',
  '智能客服',
  '生成智能客服系统代码',
  'customer-service',
  '{"spec-analysis-agent", "codegen-agent", "test-agent"}',
  'You generate customer service chatbot code. Focus on NLU, intent recognition, and conversation flow.',
  'claude-sonnet-4',
  3,
  false
) ON CONFLICT (name) DO NOTHING;

-- ── 提交日志 ──────────────────────────────────────────────

INSERT INTO audit_logs (action, actor, resource_type, metadata)
VALUES (
  'INIT_SKILLS_AGENTS',
  'system',
  'skill_definitions,agent_definitions',
  jsonb_build_object(
    'message', 'Initialized builtin skills and agents',
    'timestamp', NOW()
  )
) ON CONFLICT DO NOTHING;
