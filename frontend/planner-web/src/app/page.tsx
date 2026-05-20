'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

// ── Types ────────────────────────────────────────────────────────

interface Message {
    id: string
    role: 'user' | 'ai'
    content: string
    timestamp: Date
}

interface StoredMessage {
    id: string
    role: 'user' | 'ai'
    content: string
    timestamp: string
}

interface FeatureSpec {
    title: string
    goal: string
    platform: string[]
    rules: Record<string, string>
    entities: string[]
    api_contract: Array<{ name: string; type: string }>
    acceptance: string[]
    priority: string
}

interface StoredSession {
    id: string
    title: string
    createdAt: string
    status: 'chatting' | 'submitted'
    messages: StoredMessage[]
    spec?: FeatureSpec | null
    completeness?: number
}

type TaskStatus = 'idle' | 'connecting' | 'chatting' | 'submitting' | 'submitted'

const SESSIONS_KEY = 'awp_planner_sessions'
const ACTIVE_SESSION_KEY = 'awp_planner_active_session'

// ── Utilities ────────────────────────────────────────────────────

function generateId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function getWsUrl(projectId: string, sessionId: string) {
    const base = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3001/ws'
    return `${base}?project_id=${encodeURIComponent(projectId)}&session_id=${encodeURIComponent(sessionId)}`
}

function loadSessions(): StoredSession[] {
    try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]') }
    catch { return [] }
}

function saveSessions(sessions: StoredSession[]) {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions))
}

function extractTitle(messages: StoredMessage[], specTitle?: string | null): string {
    if (specTitle) return specTitle
    const firstUser = messages.find(m => m.role === 'user')
    if (!firstUser) return '新对话'
    const text = firstUser.content.trim()
    return text.length > 18 ? text.slice(0, 18) + '…' : text || '新对话'
}

function fmtTime(iso: string) {
    return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const EXAMPLE_PROMPTS = [
    { label: '每日签到领奖', text: '我想做一个每日签到系统，玩家每天登录可以签到领取金币，连续签到7天有额外奖励，断签重置' },
    { label: '战斗数值配置', text: '需要一个战斗数值配置后台，策划可以在线配置各种武器的攻击力、暴击率等参数，修改后实时生效，不需要重启服务器' },
    { label: '好友邀请活动', text: '做一个好友邀请活动，邀请好友注册游戏可以获得道具奖励，被邀请的新用户也有新人礼包，需要防止刷号' },
]

// ── Main Component ───────────────────────────────────────────────

export default function PlannerPage() {
    const [messages, setMessages] = useState<Message[]>([])
    const [input, setInput] = useState('')
    const [status, setStatus] = useState<TaskStatus>('idle')
    const [completeness, setCompleteness] = useState(0)
    const [spec, setSpec] = useState<FeatureSpec | null>(null)
    const [streamBuffer, setStreamBuffer] = useState('')
    const [isStreaming, setIsStreaming] = useState(false)
    const [canSubmit, setCanSubmit] = useState(false)
    const [aiDeclaredComplete, setAiDeclaredComplete] = useState(false)
    const [sessions, setSessions] = useState<StoredSession[]>([])
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
    const [selectedLanguages, setSelectedLanguages] = useState<string[]>(['go', 'typescript'])

    // Delete-with-password modal state
    const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
    const [deletePassword, setDeletePassword] = useState('')
    const [deleteError, setDeleteError] = useState(false)

    const [projectId] = useState<string>(() =>
        typeof window !== 'undefined'
            ? (localStorage.getItem('awp_project_id') || 'default')
            : 'default'
    )

    const wsRef = useRef<WebSocket | null>(null)
    const messagesEndRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLTextAreaElement>(null)
    const streamBufferRef = useRef('')
    // Refs for values used inside WS callbacks (avoids stale closure)
    const activeSessionIdRef = useRef<string | null>(null)
    const specRef = useRef<FeatureSpec | null>(null)
    const completenessRef = useRef(0)

    // ── Init ──────────────────────────────────────────────────────

    useEffect(() => {
        const stored = loadSessions()
        setSessions(stored)
        const lastId = localStorage.getItem(ACTIVE_SESSION_KEY)
        if (lastId) {
            const session = stored.find(s => s.id === lastId)
            if (session) applySession(session)
        }
    }, []) // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [messages, streamBuffer])

    // ── Session state helpers ─────────────────────────────────────

    function applySession(session: StoredSession) {
        activeSessionIdRef.current = session.id
        setActiveSessionId(session.id)
        localStorage.setItem(ACTIVE_SESSION_KEY, session.id)
        setMessages(session.messages.map(m => ({ ...m, timestamp: new Date(m.timestamp) })))
        const restoredSpec = session.spec ?? null
        setSpec(restoredSpec)
        specRef.current = restoredSpec
        const restoredComp = session.completeness ?? 0
        setCompleteness(restoredComp)
        completenessRef.current = restoredComp
        setCanSubmit(false)
        setAiDeclaredComplete(false)
        setStreamBuffer('')
        streamBufferRef.current = ''
        setIsStreaming(false)
        setInput('')
    }

    const persistSession = useCallback((
        msgs: Message[],
        currentSpec: FeatureSpec | null,
        currentCompleteness: number,
        sessionStatus: 'chatting' | 'submitted'
    ) => {
        const sessionId = activeSessionIdRef.current
        if (!sessionId) return
        const storedMsgs: StoredMessage[] = msgs.map(m => ({
            id: m.id, role: m.role, content: m.content,
            timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : String(m.timestamp),
        }))
        setSessions(prev => {
            const updated = prev.map(s => s.id !== sessionId ? s : {
                ...s,
                title: extractTitle(storedMsgs, currentSpec?.title),
                status: sessionStatus,
                messages: storedMsgs,
                spec: currentSpec,
                completeness: currentCompleteness,
            })
            saveSessions(updated)
            return updated
        })
    }, [])

    // ── WebSocket ─────────────────────────────────────────────────

    const connectWS = useCallback((sessionId: string, initialText?: string, appendMode = false) => {
        setStatus('connecting')
        const ws = new WebSocket(getWsUrl(projectId, sessionId))
        wsRef.current = ws

        ws.onopen = () => {
            setStatus('chatting')
            if (!appendMode) {
                setMessages([{
                    id: 'welcome', role: 'ai',
                    content: '你好！我是需求分析师 AI。请用自然语言描述你想实现的游戏功能，我来帮你整理成开发规范。\n\n例如：「做一个每日签到系统，连续签到7天有额外奖励」',
                    timestamp: new Date(),
                }])
            }
            if (!appendMode && initialText) {
                setTimeout(() => {
                    setMessages(prev => [...prev, {
                        id: generateId(), role: 'user', content: initialText, timestamp: new Date(),
                    }])
                    ws.send(JSON.stringify({ type: 'user_input', payload: initialText }))
                    setInput('')
                }, 300)
            }
        }

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data)
            switch (msg.type) {
                case 'stream_start':
                    setIsStreaming(true)
                    streamBufferRef.current = ''
                    setStreamBuffer('')
                    break

                case 'stream_chunk':
                    streamBufferRef.current += msg.text
                    setStreamBuffer(streamBufferRef.current)
                    break

                case 'stream_end': {
                    setIsStreaming(false)
                    const finalContent = streamBufferRef.current
                    streamBufferRef.current = ''
                    setStreamBuffer('')
                    const newSpec = msg.spec ?? specRef.current
                    const newComp = msg.completeness ?? completenessRef.current
                    if (msg.spec) { setSpec(msg.spec); specRef.current = msg.spec }
                    if (msg.completeness !== undefined) { setCompleteness(msg.completeness); completenessRef.current = msg.completeness }
                    if (msg.canSubmit !== undefined) setCanSubmit(!!msg.canSubmit)
                    if (msg.aiDeclaredComplete) setAiDeclaredComplete(true)
                    setMessages(prev => {
                        const updated = [...prev, {
                            id: Date.now().toString(), role: 'ai' as const,
                            content: finalContent, timestamp: new Date(),
                        }]
                        persistSession(updated, newSpec, newComp, 'chatting')
                        return updated
                    })
                    break
                }

                case 'spec_submitted':
                    setStatus('submitted')
                    setMessages(prev => {
                        persistSession(prev, specRef.current, completenessRef.current, 'submitted')
                        return prev
                    })
                    setSessions(prev => {
                        const updated = prev.map(s =>
                            s.id === sessionId ? { ...s, status: 'submitted' as const } : s
                        )
                        saveSessions(updated)
                        return updated
                    })
                    break

                case 'error':
                    setIsStreaming(false)
                    setMessages(prev => [...prev, {
                        id: Date.now().toString(), role: 'ai',
                        content: `⚠️ ${msg.message}`, timestamp: new Date(),
                    }])
                    break
            }
        }

        ws.onerror = () => {
            setMessages(prev => [...prev, {
                id: generateId(), role: 'ai',
                content: '⚠️ 连接失败，请检查服务是否启动（spec-normalizer:3001）',
                timestamp: new Date(),
            }])
        }
        ws.onclose = () => {
            setStatus(prev => prev === 'submitted' ? 'submitted' : 'idle')
        }
    }, [projectId, persistSession])

    // ── Actions ───────────────────────────────────────────────────

    const startNewSession = useCallback((prefillText?: string) => {
        if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
        const sessionId = generateId()
        const newSession: StoredSession = {
            id: sessionId,
            title: prefillText
                ? (prefillText.length > 18 ? prefillText.slice(0, 18) + '…' : prefillText)
                : '新对话',
            createdAt: new Date().toISOString(),
            status: 'chatting',
            messages: [],
            spec: null,
            completeness: 0,
        }
        setSessions(prev => { const u = [newSession, ...prev]; saveSessions(u); return u })
        applySession(newSession)
        if (prefillText) setInput(prefillText)
        connectWS(sessionId, prefillText)
    }, [connectWS]) // eslint-disable-line react-hooks/exhaustive-deps

    const selectSession = useCallback((session: StoredSession) => {
        if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
        applySession(session)
        if (session.status === 'submitted') {
            setStatus('submitted')
        } else {
            connectWS(session.id, undefined, true)
        }
    }, [connectWS]) // eslint-disable-line react-hooks/exhaustive-deps

    const deleteSession = useCallback((id: string) => {
        setSessions(prev => {
            const updated = prev.filter(s => s.id !== id)
            saveSessions(updated)
            return updated
        })
        if (id === activeSessionId) {
            if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
            setMessages([])
            setSpec(null); specRef.current = null
            setCompleteness(0); completenessRef.current = 0
            setStatus('idle')
            setActiveSessionId(null); activeSessionIdRef.current = null
            localStorage.removeItem(ACTIVE_SESSION_KEY)
        }
        setDeletingSessionId(null)
        setDeletePassword('')
        setDeleteError(false)
    }, [activeSessionId])

    const confirmDelete = useCallback(() => {
        if (deletePassword !== '123') {
            setDeleteError(true)
            return
        }
        if (deletingSessionId) deleteSession(deletingSessionId)
    }, [deletePassword, deletingSessionId, deleteSession])

    const continueCurrentSession = useCallback(() => {
        const session = sessions.find(s => s.id === activeSessionId)
        if (!session || session.status === 'submitted') return
        connectWS(session.id, undefined, true)
    }, [sessions, activeSessionId, connectWS])

    const sendMessage = useCallback(() => {
        if (!input.trim() || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
        const content = input.trim()
        setInput('')
        setMessages(prev => [...prev, { id: generateId(), role: 'user', content, timestamp: new Date() }])
        wsRef.current.send(JSON.stringify({ type: 'user_input', payload: content }))
    }, [input])

    const submitSpec = useCallback(() => {
        if (!spec || !wsRef.current) return
        if (selectedLanguages.length === 0) {
            alert('请至少选择一种代码生成语言')
            return
        }
        setStatus('submitting')
        const finalSpec = {
            ...spec,
            languages: selectedLanguages
        }
        wsRef.current.send(JSON.stringify({ type: 'confirm_spec', payload: finalSpec }))
    }, [spec, selectedLanguages])

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            if (status === 'idle' && messages.length === 0) startNewSession(input.trim() || undefined)
            else sendMessage()
        }
    }

    const isInChat = status === 'chatting'
    const isHistoryView = status === 'idle' && messages.length > 0
    const canSend = input.trim().length > 0 && isInChat && !isStreaming

    return (
        <div className="planner-root">
            {/* ── Topbar ── */}
            <header className="topbar">
                <div className="topbar-left">
                    <div className="logo-mark">AWP</div>
                    <span className="topbar-title">需求工坊</span>
                    <span className="topbar-sep">/</span>
                    <span className="topbar-sub">策划输入</span>
                </div>
                <div className="topbar-right">
                    <StatusPill status={status} canSubmit={canSubmit} />
                </div>
            </header>

            <div className="layout">
                {/* ── Sidebar ── */}
                <aside className="sidebar">
                    <div className="sidebar-header">
                        <button type="button" className="new-chat-btn" onClick={() => startNewSession()}>
                            ＋ 新建对话
                        </button>
                    </div>
                    <div className="sidebar-list">
                        {sessions.length === 0 ? (
                            <p className="sidebar-empty">暂无历史记录</p>
                        ) : sessions.map(s => (
                            <div
                                key={s.id}
                                className={`sidebar-item${s.id === activeSessionId ? ' active' : ''}`}
                                onClick={() => selectSession(s)}
                            >
                                <div className="sidebar-item-top">
                                    <span className="sidebar-item-title">{s.title}</span>
                                    <button
                                        type="button"
                                        className="sidebar-item-del"
                                        title="删除会话"
                                        onClick={e => {
                                            e.stopPropagation()
                                            setDeletingSessionId(s.id)
                                            setDeletePassword('')
                                            setDeleteError(false)
                                        }}
                                    >
                                        ×
                                    </button>
                                </div>
                                <div className="sidebar-item-meta">
                                    <span className={`sidebar-item-badge ${s.status}`}>
                                        {s.status === 'submitted' ? '已提交' : '进行中'}
                                    </span>
                                    <span className="sidebar-item-time">{fmtTime(s.createdAt)}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </aside>

                {/* ── Chat panel ── */}
                <main className="chat-panel">
                    {status === 'idle' && messages.length === 0 ? (
                        <StartScreen
                            onStart={() => startNewSession()}
                            onExample={text => startNewSession(text)}
                            inputValue={input}
                            onInputChange={setInput}
                            onInputKeyDown={handleKeyDown}
                        />
                    ) : (
                        <>
                            <div className="messages-scroll">
                                <AnimatePresence initial={false}>
                                    {messages.map(msg => (
                                        <MessageBubble key={msg.id} message={msg} />
                                    ))}
                                </AnimatePresence>

                                {isStreaming && streamBuffer && (
                                    <motion.div
                                        initial={{ opacity: 0, y: 8 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        className="msg ai"
                                    >
                                        <div className="msg-avatar ai-avatar">AI</div>
                                        <div className="msg-body">
                                            <MarkdownLite content={streamBuffer} />
                                            <span className="cursor-blink">▌</span>
                                        </div>
                                    </motion.div>
                                )}
                                <div ref={messagesEndRef} />
                            </div>

                            {/* History-view banner (no active WS) */}
                            {isHistoryView && (
                                <div className="history-banner">
                                    <span className="history-banner-text">📖 历史记录 · 只读</span>
                                    <button
                                        type="button"
                                        className="continue-btn"
                                        onClick={continueCurrentSession}
                                    >
                                        继续此对话 →
                                    </button>
                                </div>
                            )}

                            {/* Input area */}
                            {!isHistoryView && status !== 'submitted' && (
                                <div className="input-area">
                                    <textarea
                                        ref={inputRef}
                                        className="chat-input"
                                        value={input}
                                        onChange={e => setInput(e.target.value)}
                                        onKeyDown={handleKeyDown}
                                        placeholder={
                                            isStreaming ? 'AI 回复中...'
                                                : status === 'connecting' ? '正在连接...'
                                                    : canSubmit ? '需求已完整！可继续补充，或点击右侧提交'
                                                        : '回答 AI 的问题，补充需求细节（Enter 发送）'
                                        }
                                        rows={3}
                                        disabled={!isInChat || isStreaming}
                                    />
                                    <div className="input-actions">
                                        <button
                                            type="button"
                                            className="new-session-btn"
                                            onClick={() => startNewSession()}
                                            title="开始新会话"
                                        >
                                            ＋ 新会话
                                        </button>
                                        <button
                                            type="button"
                                            className={`send-btn${canSend ? ' active' : ''}`}
                                            onClick={sendMessage}
                                            disabled={!canSend}
                                        >
                                            {isStreaming ? '...' : '发送'}
                                        </button>
                                    </div>
                                </div>
                            )}

                            {status === 'submitted' && (
                                <div className="submitted-actions">
                                    <button
                                        type="button"
                                        className="new-session-btn-lg"
                                        onClick={() => startNewSession()}
                                    >
                                        ＋ 开始新需求
                                    </button>
                                </div>
                            )}
                        </>
                    )}
                </main>

                {/* ── Spec panel ── */}
                <aside className="spec-panel">
                    <div className="spec-panel-header">
                        <span className="spec-panel-title">需求结构化预览</span>
                        <CompletenessBar value={completeness} />
                    </div>

                    {spec ? (
                        <SpecPreview spec={spec} />
                    ) : (
                        <div className="spec-empty">
                            <div className="spec-empty-icon">◈</div>
                            <p>AI 对话过程中，<br />结构化需求将在此实时显示</p>
                        </div>
                    )}

                    {status !== 'submitted' && !isHistoryView && spec && (
                        <>
                            <div className="language-selector">
                                <label className="language-label">📝 选择生成语言:</label>
                                <div className="language-buttons">
                                    {['go', 'typescript', 'csharp', 'java', 'python'].map(lang => (
                                        <button
                                            key={lang}
                                            type="button"
                                            onClick={() => {
                                                setSelectedLanguages(prev =>
                                                    prev.includes(lang)
                                                        ? prev.filter(l => l !== lang)
                                                        : [...prev, lang]
                                                )
                                            }}
                                            className={`language-btn${selectedLanguages.includes(lang) ? ' active' : ''}`}
                                            title={`${selectedLanguages.includes(lang) ? '取消选择' : '选择'} ${lang.toUpperCase()}`}
                                        >
                                            {lang.toUpperCase()}
                                        </button>
                                    ))}
                                </div>
                                {selectedLanguages.length === 0 && (
                                    <p className="language-warning">⚠️ 至少选择一种语言</p>
                                )}
                            </div>

                            <div className={`submit-zone ${canSubmit ? 'ready' : 'draft'}`}>
                                {canSubmit ? (
                                    <>
                                        {aiDeclaredComplete
                                            ? <p className="submit-hint ready">✅ AI 确认需求已完整（{completeness}%）</p>
                                            : <p className="submit-hint ready">需求完整度 {completeness}%，可以提交</p>
                                        }
                                        <p className="submit-refine-hint">💬 左侧仍可继续完善需求</p>
                                        <button
                                            type="button"
                                            className="submit-btn ready"
                                            onClick={submitSpec}
                                            disabled={status === 'submitting' || selectedLanguages.length === 0}
                                        >
                                            {status === 'submitting' ? '提交中...' : '确认并开始生成代码 →'}
                                        </button>
                                    </>
                                ) : (
                                    <>
                                        <p className="submit-hint draft">草稿 {completeness}%，继续和 AI 完善需求</p>
                                        <button
                                            type="button"
                                            className="submit-btn draft"
                                            onClick={submitSpec}
                                            disabled={completeness < 30 || status === 'submitting' || selectedLanguages.length === 0}
                                            title={completeness < 30 ? '需要更多信息才能提交' : selectedLanguages.length === 0 ? '请选择至少一种语言' : '强制提交当前草稿'}
                                        >
                                            强制提交草稿
                                        </button>
                                    </>
                                )}
                            </div>
                        </>
                    )}

                    {status === 'submitted' && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="submitted-banner"
                        >
                            ✓ 需求已提交，代码生成队列中...
                            <br />
                            <small>打开 VS Code 插件查看生成进度</small>
                        </motion.div>
                    )}
                </aside>
            </div>

            {/* ── Delete-session modal ── */}
            {deletingSessionId && (
                <div className="modal-overlay" onClick={() => setDeletingSessionId(null)}>
                    <motion.div
                        className="modal"
                        initial={{ opacity: 0, scale: 0.95, y: -8 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        transition={{ duration: 0.15 }}
                        onClick={e => e.stopPropagation()}
                    >
                        <h3 className="modal-title">删除会话</h3>
                        <p className="modal-desc">
                            请输入管理员密码确认删除，此操作不可恢复。
                        </p>
                        <input
                            className="modal-input"
                            type="password"
                            value={deletePassword}
                            onChange={e => { setDeletePassword(e.target.value); setDeleteError(false) }}
                            onKeyDown={e => e.key === 'Enter' && confirmDelete()}
                            placeholder="管理员密码"
                            autoFocus
                        />
                        {deleteError && (
                            <p className="modal-error">密码错误，请重试</p>
                        )}
                        <div className="modal-actions">
                            <button
                                type="button"
                                className="modal-btn cancel"
                                onClick={() => setDeletingSessionId(null)}
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                className="modal-btn confirm"
                                onClick={confirmDelete}
                            >
                                确认删除
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}
        </div>
    )
}

// ── Sub-components ───────────────────────────────────────────────

function StartScreen({
    onStart, onExample, inputValue, onInputChange, onInputKeyDown,
}: {
    onStart: () => void
    onExample: (text: string) => void
    inputValue: string
    onInputChange: (v: string) => void
    onInputKeyDown: (e: React.KeyboardEvent) => void
}) {
    return (
        <div className="start-screen">
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
                className="start-content"
            >
                <div className="start-glyph">◈</div>
                <h1 className="start-title">需求工坊</h1>
                <p className="start-desc">
                    用自然语言描述游戏功能需求<br />
                    AI 将引导你完成结构化整理，直接进入开发流水线
                </p>

                {/* Examples placed before textarea so they're never clipped */}
                <div className="start-examples">
                    <span className="example-label">快速示例</span>
                    {EXAMPLE_PROMPTS.map(ex => (
                        <button
                            key={ex.label}
                            type="button"
                            className="example-tag"
                            onClick={() => onExample(ex.text)}
                            title={ex.text}
                        >
                            {ex.label}
                        </button>
                    ))}
                </div>

                <div className="start-input-wrap">
                    <textarea
                        className="start-input"
                        value={inputValue}
                        onChange={e => onInputChange(e.target.value)}
                        onKeyDown={onInputKeyDown}
                        placeholder="直接描述你的需求，按 Enter 开始对话..."
                        rows={2}
                    />
                </div>

                <button type="button" className="start-btn" onClick={onStart}>
                    开始描述需求
                </button>
            </motion.div>
        </div>
    )
}

function MessageBubble({ message }: { message: Message }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className={`msg ${message.role}`}
        >
            {message.role === 'ai' && <div className="msg-avatar ai-avatar">AI</div>}
            <div className="msg-body">
                <MarkdownLite content={message.content} />
            </div>
            {message.role === 'user' && <div className="msg-avatar user-avatar">我</div>}
        </motion.div>
    )
}

function MarkdownLite({ content }: { content: string }) {
    const parts = content.split(/(```[\s\S]*?```)/g)
    return (
        <div className="markdown">
            {parts.map((part, i) => {
                if (part.startsWith('```')) {
                    const code = part.replace(/^```\w*\n?/, '').replace(/```$/, '')
                    return <pre key={i} className="code-block"><code>{code}</code></pre>
                }
                return <span key={i} style={{ whiteSpace: 'pre-wrap' }}>{part}</span>
            })}
        </div>
    )
}

function SpecPreview({ spec }: { spec: FeatureSpec }) {
    const priorityColor: Record<string, string> = { high: '#ef4444', medium: '#f59e0b', low: '#22c55e' }
    const priorityLabel: Record<string, string> = { high: '高优先级', medium: '中优先级', low: '低优先级' }
    return (
        <div className="spec-preview">
            <div className="spec-field">
                <label>功能名称</label>
                <strong>{spec.title}</strong>
            </div>
            <div className="spec-field">
                <label>目标</label>
                <span>{spec.goal}</span>
            </div>
            <div className="spec-field">
                <label>平台</label>
                <div className="tag-row">
                    {spec.platform.map(p => (
                        <span key={p} className="tag">{p === 'client' ? '客户端' : '服务端'}</span>
                    ))}
                </div>
            </div>
            {spec.rules && Object.keys(spec.rules).length > 0 && (
                <div className="spec-field">
                    <label>业务规则</label>
                    <ul className="rule-list">
                        {Object.entries(spec.rules).map(([k, v]) => (
                            <li key={k}><code>{k}</code>：{v}</li>
                        ))}
                    </ul>
                </div>
            )}
            {spec.entities && spec.entities.length > 0 && (
                <div className="spec-field">
                    <label>数据实体</label>
                    <div className="tag-row">
                        {spec.entities.map(e => <span key={e} className="tag entity">{e}</span>)}
                    </div>
                </div>
            )}
            {spec.api_contract && spec.api_contract.length > 0 && (
                <div className="spec-field">
                    <label>API 接口</label>
                    {spec.api_contract.map((api, i) => (
                        <div key={i} className="api-row">
                            <span className={`method-badge ${api.type?.toLowerCase()}`}>{api.type}</span>
                            <code>{api.name}</code>
                        </div>
                    ))}
                </div>
            )}
            {spec.acceptance && spec.acceptance.length > 0 && (
                <div className="spec-field">
                    <label>验收标准</label>
                    <ul className="accept-list">
                        {spec.acceptance.map((a, i) => <li key={i}>✓ {a}</li>)}
                    </ul>
                </div>
            )}
            <div className="spec-field priority-field">
                <label>优先级</label>
                <span className="priority-dot" style={{ background: priorityColor[spec.priority] || '#888' }} />
                <span>{priorityLabel[spec.priority] || spec.priority}</span>
            </div>
        </div>
    )
}

function CompletenessBar({ value }: { value: number }) {
    const color = value >= 80 ? '#22c55e' : value >= 50 ? '#f59e0b' : '#64748b'
    return (
        <div className="completeness">
            <div className="completeness-track">
                <motion.div
                    className="completeness-fill"
                    style={{ background: color }}
                    initial={{ width: 0 }}
                    animate={{ width: `${value}%` }}
                    transition={{ duration: 0.5 }}
                />
            </div>
            <span className="completeness-label" style={{ color }}>{value}%</span>
        </div>
    )
}

function StatusPill({ status, canSubmit }: { status: TaskStatus; canSubmit: boolean }) {
    const map: Record<TaskStatus, { label: string; color: string }> = {
        idle:       { label: '未连接',    color: '#64748b' },
        connecting: { label: '连接中...',  color: '#f59e0b' },
        chatting:   { label: canSubmit ? '需求就绪' : '对话中', color: canSubmit ? '#22c55e' : '#3b82f6' },
        submitting: { label: '提交中...',  color: '#a855f7' },
        submitted:  { label: '已进入队列', color: '#22c55e' },
    }
    const { label, color } = map[status]
    return (
        <div className="status-pill">
            <span className="status-dot" style={{ background: color }} />
            <span style={{ color }}>{label}</span>
        </div>
    )
}
