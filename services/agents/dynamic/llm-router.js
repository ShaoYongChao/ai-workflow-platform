"use strict";
/**
 * services/agents/dynamic/llm-router.ts
 *
 * 动态 LLM 路由器
 *
 * 从 system_settings + llm_providers 表读取配置，
 * 支持所有主流模型，完全不需要改代码添加新模型。
 *
 * 支持：Anthropic / OpenAI / DeepSeek / Gemini / Qwen / ZhipuAI / Ollama / Azure / 自定义
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LLMRouter = void 0;
exports.getLLMRouter = getLLMRouter;
// ── LLM Router ────────────────────────────────────────────────
class LLMRouter {
    constructor(pool) {
        this.cache = new Map();
        this.cacheTs = 0;
        this.CACHE_TTL = 60000; // 60s 缓存，DB 变更后自动失效
        this.pool = pool;
    }
    // ── 主调用入口 ────────────────────────────────────────────
    async call(opts) {
        const provider = await this.resolveProvider(opts.providerName);
        const apiKey = this.resolveApiKey(provider);
        switch (provider.providerType) {
            case 'anthropic': return this.callAnthropic(provider, apiKey, opts);
            case 'openai': return this.callOpenAI(provider, apiKey, opts);
            case 'deepseek': return this.callOpenAICompat(provider, apiKey, opts, 'https://api.deepseek.com/v1');
            case 'gemini': return this.callGemini(provider, apiKey, opts);
            case 'qwen': return this.callOpenAICompat(provider, apiKey, opts, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
            case 'zhipu': return this.callOpenAICompat(provider, apiKey, opts, 'https://open.bigmodel.cn/api/paas/v4');
            case 'ollama': return this.callOllama(provider, opts);
            case 'azure': return this.callAzure(provider, apiKey, opts);
            case 'custom': return this.callOpenAICompat(provider, apiKey, opts, provider.baseUrl);
            default: throw new Error(`不支持的 provider 类型: ${provider.providerType}`);
        }
    }
    // ── 流式调用 ──────────────────────────────────────────────
    async *stream(opts) {
        const provider = await this.resolveProvider(opts.providerName);
        const apiKey = this.resolveApiKey(provider);
        switch (provider.providerType) {
            case 'anthropic':
                yield* this.streamAnthropic(provider, apiKey, opts);
                break;
            case 'openai':
            case 'deepseek':
            case 'qwen':
            case 'zhipu':
            case 'custom':
                yield* this.streamOpenAICompat(provider, apiKey, opts);
                break;
            case 'ollama':
                yield* this.streamOllama(provider, opts);
                break;
            default: throw new Error(`${provider.providerType} 暂不支持流式`);
        }
    }
    // ── 获取可用模型列表（供 UI 展示） ───────────────────────
    async listProviders() {
        await this.refreshCache();
        return Array.from(this.cache.values());
    }
    // ── 获取系统默认模型 ──────────────────────────────────────
    async getDefaultProvider() {
        const r = await this.pool.query(`SELECT value FROM system_settings WHERE key = 'default_llm'`);
        const name = r.rows[0]?.value?.replace(/"/g, '') || 'claude-sonnet-4';
        return this.resolveProvider(name);
    }
    // ── 按用途获取模型（从 system_settings 读） ──────────────
    async getProviderForTask(taskType) {
        const keyMap = {
            spec: 'spec_agent_llm',
            codegen: 'codegen_agent_llm',
            autofix: 'autofix_llm',
            refactor: 'codegen_agent_llm',
        };
        const r = await this.pool.query(`SELECT value FROM system_settings WHERE key = $1`, [keyMap[taskType] || 'default_llm']);
        const name = r.rows[0]?.value?.replace(/"/g, '');
        return this.resolveProvider(name);
    }
    // ── 内部：解析 Provider ───────────────────────────────────
    async resolveProvider(name) {
        await this.refreshCache();
        if (!name)
            return this.getDefaultProvider();
        const p = this.cache.get(name);
        if (!p)
            throw new Error(`LLM Provider "${name}" 不存在或未启用`);
        return p;
    }
    async refreshCache() {
        if (Date.now() - this.cacheTs < this.CACHE_TTL)
            return;
        const r = await this.pool.query(`SELECT * FROM llm_providers WHERE enabled = true ORDER BY is_default DESC, name`);
        this.cache.clear();
        for (const row of r.rows) {
            this.cache.set(row.name, {
                name: row.name,
                displayName: row.display_name,
                providerType: row.provider_type,
                baseUrl: row.base_url,
                apiKeyEnv: row.api_key_env,
                apiKeyValue: row.api_key_value,
                modelId: row.model_id,
                contextWindow: row.context_window,
                maxOutputTokens: row.max_output_tokens,
                supportsStreaming: row.supports_streaming,
                supportsFunctionCall: row.supports_function_call,
                extraParams: row.extra_params || {}
            });
        }
        this.cacheTs = Date.now();
    }
    resolveApiKey(provider) {
        if (provider.apiKeyValue)
            return provider.apiKeyValue;
        if (provider.apiKeyEnv)
            return process.env[provider.apiKeyEnv] || '';
        return '';
    }
    // ── Anthropic ─────────────────────────────────────────────
    async callAnthropic(p, apiKey, opts) {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic.default({ apiKey, ...(p.baseUrl ? { baseURL: p.baseUrl } : {}) });
        const res = await client.messages.create({
            model: p.modelId,
            max_tokens: opts.maxTokens || p.maxOutputTokens,
            temperature: opts.temperature ?? p.extraParams.temperature ?? 0.2,
            system: opts.system,
            messages: [{ role: 'user', content: opts.user }]
        });
        return {
            content: res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
            model: p.modelId,
            promptTokens: res.usage.input_tokens,
            completionTokens: res.usage.output_tokens
        };
    }
    async *streamAnthropic(p, apiKey, opts) {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic.default({ apiKey, ...(p.baseUrl ? { baseURL: p.baseUrl } : {}) });
        const stream = client.messages.stream({
            model: p.modelId, max_tokens: opts.maxTokens || p.maxOutputTokens,
            temperature: opts.temperature ?? 0.2, system: opts.system,
            messages: [{ role: 'user', content: opts.user }]
        });
        for await (const chunk of stream) {
            if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
                yield chunk.delta.text;
            }
        }
    }
    // ── OpenAI 及兼容接口（DeepSeek/Qwen/ZhipuAI/Custom） ────
    async callOpenAI(p, apiKey, opts) {
        return this.callOpenAICompat(p, apiKey, opts, p.baseUrl || 'https://api.openai.com/v1');
    }
    async callOpenAICompat(p, apiKey, opts, baseUrl) {
        const OpenAI = require('openai');
        const client = new OpenAI.default({ apiKey, baseURL: baseUrl });
        const res = await client.chat.completions.create({
            model: p.modelId,
            max_tokens: opts.maxTokens || p.maxOutputTokens,
            temperature: opts.temperature ?? p.extraParams.temperature ?? 0.2,
            messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }]
        });
        return {
            content: res.choices[0]?.message?.content || '',
            model: p.modelId,
            promptTokens: res.usage?.prompt_tokens || 0,
            completionTokens: res.usage?.completion_tokens || 0
        };
    }
    async *streamOpenAICompat(p, apiKey, opts) {
        const baseUrl = p.baseUrl || (['openai'].includes(p.providerType) ? 'https://api.openai.com/v1' :
            p.providerType === 'deepseek' ? 'https://api.deepseek.com/v1' :
                p.providerType === 'qwen' ? 'https://dashscope.aliyuncs.com/compatible-mode/v1' :
                    p.providerType === 'zhipu' ? 'https://open.bigmodel.cn/api/paas/v4' : '');
        const OpenAI = require('openai');
        const client = new OpenAI.default({ apiKey, baseURL: baseUrl });
        const stream = await client.chat.completions.create({
            model: p.modelId, max_tokens: opts.maxTokens || p.maxOutputTokens,
            temperature: opts.temperature ?? 0.2, stream: true,
            messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }]
        });
        for await (const chunk of stream) {
            const text = chunk.choices[0]?.delta?.content;
            if (text)
                yield text;
        }
    }
    // ── Google Gemini ─────────────────────────────────────────
    async callGemini(p, apiKey, opts) {
        const https = require('https');
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${p.modelId}:generateContent?key=${apiKey}`;
        const body = JSON.stringify({
            systemInstruction: { parts: [{ text: opts.system }] },
            contents: [{ role: 'user', parts: [{ text: opts.user }] }],
            generationConfig: { maxOutputTokens: opts.maxTokens || p.maxOutputTokens, temperature: opts.temperature ?? 0.2 }
        });
        const data = await new Promise((resolve, reject) => {
            const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
                let raw = '';
                res.on('data', (d) => raw += d);
                res.on('end', () => { try {
                    resolve(JSON.parse(raw));
                }
                catch (e) {
                    reject(e);
                } });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
        const content = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
        return { content, model: p.modelId, promptTokens: data.usageMetadata?.promptTokenCount || 0, completionTokens: data.usageMetadata?.candidatesTokenCount || 0 };
    }
    // ── Ollama 本地部署 ───────────────────────────────────────
    async callOllama(p, opts) {
        const baseUrl = p.baseUrl || 'http://localhost:11434';
        const http = require('http');
        const body = JSON.stringify({ model: p.modelId, messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }], stream: false, options: { temperature: opts.temperature ?? 0.2 } });
        const data = await new Promise((resolve, reject) => {
            const url = new URL('/api/chat', baseUrl);
            const req = http.request({ hostname: url.hostname, port: url.port || 11434, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
                let raw = '';
                res.on('data', (d) => raw += d);
                res.on('end', () => { try {
                    resolve(JSON.parse(raw));
                }
                catch (e) {
                    reject(e);
                } });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
        return { content: data.message?.content || '', model: p.modelId, promptTokens: data.prompt_eval_count || 0, completionTokens: data.eval_count || 0 };
    }
    async *streamOllama(p, opts) {
        const baseUrl = p.baseUrl || 'http://localhost:11434';
        const http = require('http');
        const body = JSON.stringify({ model: p.modelId, messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }], stream: true, options: { temperature: opts.temperature ?? 0.2 } });
        const chunks = [];
        await new Promise((resolve, reject) => {
            const url = new URL('/api/chat', baseUrl);
            const req = http.request({ hostname: url.hostname, port: url.port || 11434, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
                res.on('data', (d) => { try {
                    const line = JSON.parse(d.toString());
                    if (line.message?.content)
                        chunks.push(line.message.content);
                }
                catch { } });
                res.on('end', resolve);
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
        for (const chunk of chunks)
            yield chunk;
    }
    // ── Azure OpenAI ──────────────────────────────────────────
    async callAzure(p, apiKey, opts) {
        // Azure endpoint: https://<resource>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=2024-02-01
        return this.callOpenAICompat(p, apiKey, opts, p.baseUrl || '');
    }
}
exports.LLMRouter = LLMRouter;
// ── 全局单例（其他模块 import 这个） ─────────────────────────
let _router = null;
function getLLMRouter(pool) {
    if (!_router)
        _router = new LLMRouter(pool);
    return _router;
}
//# sourceMappingURL=llm-router.js.map