#!/usr/bin/env node
/**
 * knowledge-base/scripts/build-index.js
 *
 * 解析种子代码，提取接口契约（不存实现），写入：
 *   1. knowledge-base/index/kb.json  — 轻量 JSON 全量索引
 *   2. knowledge-base/index/chunks/  — 每个 chunk 一个文件（供向量化）
 *
 * 运行：node knowledge-base/scripts/build-index.js
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SEED_DIR = path.join(ROOT, 'seed-code')
const INDEX_DIR = path.join(ROOT, 'index')
const CHUNK_DIR = path.join(INDEX_DIR, 'chunks')

fs.mkdirSync(CHUNK_DIR, { recursive: true })

// ── 主流程 ──────────────────────────────────────────────────
function main() {
    console.log('🔍 开始解析种子代码...\n')

    const allChunks = []

    walkDir(SEED_DIR, (filePath) => {
        const ext = path.extname(filePath)
        const rel = path.relative(SEED_DIR, filePath)
        const lang = ext === '.go' ? 'go' : ext === '.ts' ? 'typescript' : null
        if (!lang) return

        // 跳过测试文件（不入知识库，避免污染）
        if (rel.includes('_test') || rel.includes('.test.')) {
            console.log(`  ⏭  跳过测试文件: ${rel}`)
            return
        }

        const source = fs.readFileSync(filePath, 'utf8')
        const chunks = lang === 'go'
            ? parseGoFile(source, rel)
            : parseTSFile(source, rel)

        console.log(`  ✅ ${rel}  →  ${chunks.length} 个 chunk`)
        allChunks.push(...chunks)
    })

    // ── 写入 chunks（每个 chunk 一个文件，供向量化脚本逐个处理）
    for (const chunk of allChunks) {
        const fname = chunk.id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json'
        fs.writeFileSync(path.join(CHUNK_DIR, fname), JSON.stringify(chunk, null, 2))
    }

    // ── 写入全量索引
    const index = {
        version: '1.0.0',
        builtAt: new Date().toISOString(),
        totalChunks: allChunks.length,
        chunks: allChunks
    }
    fs.writeFileSync(path.join(INDEX_DIR, 'kb.json'), JSON.stringify(index, null, 2))

    console.log(`\n✅ 知识库构建完成`)
    console.log(`   总 chunk 数: ${allChunks.length}`)
    console.log(`   索引路径:    ${path.join(INDEX_DIR, 'kb.json')}`)
    console.log(`   Chunk 目录:  ${CHUNK_DIR}`)
}

// ── Go 文件解析 ─────────────────────────────────────────────
// 策略：只提取 type / interface / func 签名 + 注释，不存实现体
function parseGoFile(source, relPath) {
    const chunks = []
    const lines = source.split('\n')
    const pkg = (source.match(/^package\s+(\w+)/m) || [])[1] || 'unknown'

    // 1. 提取 interface 定义（完整保留，这是最重要的契约）
    extractGoInterfaces(source).forEach((iface, i) => {
        chunks.push({
            id: `go:${relPath}:interface:${i}`,
            type: 'interface',
            language: 'go',
            file: relPath,
            package: pkg,
            content: iface.trim(),
            // 用于 BM25 精确检索的符号名
            symbols: extractSymbolNames(iface),
            // 用于语义检索的文本
            semantic: `Go interface in package ${pkg}: ${iface}`,
        })
    })

    // 2. 提取 struct 定义（只取字段，不取方法体）
    extractGoStructs(source).forEach((s, i) => {
        chunks.push({
            id: `go:${relPath}:struct:${i}`,
            type: 'struct',
            language: 'go',
            file: relPath,
            package: pkg,
            content: s.trim(),
            symbols: extractSymbolNames(s),
            semantic: `Go struct in package ${pkg}: ${s}`,
        })
    })

    // 3. 提取 func 签名（带注释，不含实现体）
    extractGoFuncSignatures(source).forEach((fn, i) => {
        chunks.push({
            id: `go:${relPath}:func:${i}`,
            type: 'function_signature',
            language: 'go',
            file: relPath,
            package: pkg,
            content: fn.trim(),
            symbols: extractSymbolNames(fn),
            semantic: `Go function in package ${pkg}: ${fn}`,
        })
    })

    // 4. 提取错误变量定义
    extractGoErrors(source).forEach((e, i) => {
        chunks.push({
            id: `go:${relPath}:error:${i}`,
            type: 'error_definition',
            language: 'go',
            file: relPath,
            package: pkg,
            content: e.trim(),
            symbols: extractSymbolNames(e),
            semantic: `Go error definition in package ${pkg}: ${e}`,
        })
    })

    return chunks
}

// ── TypeScript 文件解析 ─────────────────────────────────────
function parseTSFile(source, relPath) {
    const chunks = []

    // 1. 提取 interface / type 定义
    extractTSInterfaces(source).forEach((iface, i) => {
        chunks.push({
            id: `ts:${relPath}:interface:${i}`,
            type: 'interface',
            language: 'typescript',
            file: relPath,
            content: iface.trim(),
            symbols: extractSymbolNames(iface),
            semantic: `TypeScript interface: ${iface}`,
        })
    })

    // 2. 提取 class 定义（方法签名，不含实现）
    extractTSClasses(source).forEach((cls, i) => {
        chunks.push({
            id: `ts:${relPath}:class:${i}`,
            type: 'class_signature',
            language: 'typescript',
            file: relPath,
            content: cls.trim(),
            symbols: extractSymbolNames(cls),
            semantic: `TypeScript class: ${cls}`,
        })
    })

    // 3. 提取 export function / export async function 签名
    extractTSFunctions(source).forEach((fn, i) => {
        chunks.push({
            id: `ts:${relPath}:function:${i}`,
            type: 'function_signature',
            language: 'typescript',
            file: relPath,
            content: fn.trim(),
            symbols: extractSymbolNames(fn),
            semantic: `TypeScript function: ${fn}`,
        })
    })

    return chunks
}

// ── 具体提取函数 ────────────────────────────────────────────

function extractGoInterfaces(source) {
    const results = []
    // 匹配 interface 块（含前置注释）
    const re = /((?:\/\/[^\n]*\n)*)type\s+\w+\s+interface\s*\{[^}]*\}/g
    let m
    while ((m = re.exec(source)) !== null) results.push(m[0])
    return results
}

function extractGoStructs(source) {
    const results = []
    const re = /((?:\/\/[^\n]*\n)*)type\s+\w+\s+struct\s*\{[^}]*\}/g
    let m
    while ((m = re.exec(source)) !== null) results.push(m[0])
    return results
}

function extractGoFuncSignatures(source) {
    const results = []
    const lines = source.split('\n')
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // 匹配 func 声明行（公开函数，大写开头）
        if (/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?[A-Z]\w*\(/.test(line)) {
            // 收集前置注释（最多往前5行）
            const comments = []
            for (let j = Math.max(0, i - 5); j < i; j++) {
                if (lines[j].trim().startsWith('//')) comments.push(lines[j])
                else comments.length = 0 // 非连续注释则清空
            }
            // 只取函数签名行（不含实现体）
            const sig = line.replace(/\s*\{.*$/, '').trim()
            results.push([...comments, sig].join('\n'))
        }
    }
    return results
}

function extractGoErrors(source) {
    const results = []
    const re = /var\s+Err\w+\s*=\s*[^\n]+/g
    let m
    while ((m = re.exec(source)) !== null) results.push(m[0])
    return results
}

function extractTSInterfaces(source) {
    const results = []
    // interface 和 type alias
    const re = /((?:\/\*\*[\s\S]*?\*\/\n|\/\/[^\n]*\n)*)export\s+(?:interface|type)\s+\w+[\s\S]*?\n\}/g
    let m
    while ((m = re.exec(source)) !== null) results.push(m[0])
    return results
}

function extractTSClasses(source) {
    const results = []
    // 提取 class 的方法签名列表（不含实现体）
    const classRe = /((?:\/\*\*[\s\S]*?\*\/\n)?)export\s+class\s+(\w+)[\s\S]*?\{([\s\S]*?)\n\}/g
    let m
    while ((m = classRe.exec(source)) !== null) {
        const [, jsdoc, className, body] = m
        // 只提取方法签名行（不含 { ... } 实现）
        const methodSigs = body
            .split('\n')
            .filter(l => {
                const t = l.trim()
                return (
                    (t.startsWith('async ') || t.startsWith('public ') || t.startsWith('private ') || /^\w+\(/.test(t))
                    && !t.startsWith('//')
                    && !t.startsWith('*')
                    && t !== '{'
                    && t !== '}'
                )
            })
            .map(l => l.replace(/\{.*$/, '').trim())
            .filter(Boolean)

        if (methodSigs.length > 0) {
            results.push(`${jsdoc}class ${className} {\n  ${methodSigs.join('\n  ')}\n}`)
        }
    }
    return results
}

function extractTSFunctions(source) {
    const results = []
    // export function / export async function
    const re = /((?:\/\*\*[\s\S]*?\*\/\n|\/\/[^\n]*\n)*)export\s+(?:async\s+)?function\s+\w+[^{]*/g
    let m
    while ((m = re.exec(source)) !== null) {
        results.push(m[0].replace(/[{,]\s*$/, '').trim())
    }
    return results
}

function extractSymbolNames(text) {
    // 提取所有大写开头的标识符（类名、接口名、函数名）
    const matches = text.match(/\b[A-Z][a-zA-Z0-9]+\b/g) || []
    return [...new Set(matches)]
}

// ── 文件系统工具 ────────────────────────────────────────────
function walkDir(dir, callback) {
    fs.readdirSync(dir).forEach(name => {
        const full = path.join(dir, name)
        if (fs.statSync(full).isDirectory()) walkDir(full, callback)
        else callback(full)
    })
}

main()