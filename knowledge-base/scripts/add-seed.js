#!/usr/bin/env node
/**
 * knowledge-base/scripts/add-seed.js
 *
 * 向知识库添加新的种子代码，自动重建索引并可选向量化。
 *
 * 用法：
 *   node add-seed.js <源文件或目录> [--feature=<名称>] [--vectorize]
 *
 * 示例：
 *   # 添加单个文件
 *   node add-seed.js ../../src/battle/model.go --feature=battle
 *
 *   # 添加整个功能目录
 *   node add-seed.js ../../src/shop/ --feature=shop
 *
 *   # 添加并立刻向量化写入 Chroma
 *   node add-seed.js ../../src/battle/ --feature=battle --vectorize
 */

const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const SEED_DIR = path.join(ROOT, 'seed-code')

function main() {
    const args = process.argv.slice(2)
    const srcArg = args.find(a => !a.startsWith('--'))
    const feature = (args.find(a => a.startsWith('--feature=')) || '').replace('--feature=', '')
    const doVec = args.includes('--vectorize')

    if (!srcArg) {
        console.log(`用法: node add-seed.js <源文件或目录> [--feature=<名称>] [--vectorize]`)
        process.exit(1)
    }

    const srcPath = path.resolve(srcArg)
    if (!fs.existsSync(srcPath)) {
        console.error(`❌ 路径不存在: ${srcPath}`)
        process.exit(1)
    }

    const featureName = feature || path.basename(srcPath).replace(/\.\w+$/, '')
    const stat = fs.statSync(srcPath)

    console.log(`\n📁 添加种子代码: ${srcPath}`)
    console.log(`   功能名称: ${featureName}`)

    // ── 复制文件 ──────────────────────────────────────────────
    if (stat.isFile()) {
        const ext = path.extname(srcPath)
        const lang = ext === '.go' ? 'server' : 'client'
        const dest = path.join(SEED_DIR, lang, featureName, path.basename(srcPath))
        fs.mkdirSync(path.dirname(dest), { recursive: true })

        // 安全检查：跳过测试文件
        if (srcPath.includes('_test') || srcPath.includes('.test.')) {
            console.log(`  ⏭  跳过测试文件`)
        } else {
            fs.copyFileSync(srcPath, dest)
            console.log(`  ✅ 已复制 → ${path.relative(ROOT, dest)}`)
        }
    } else {
        // 目录：递归复制，智能区分 server/client
        let copied = 0
        walkDir(srcPath, (filePath) => {
            const ext = path.extname(filePath)
            if (!['.go', '.ts'].includes(ext)) return
            if (filePath.includes('_test') || filePath.includes('.test.')) return

            const lang = ext === '.go' ? 'server' : 'client'
            const relFile = path.relative(srcPath, filePath)
            const dest = path.join(SEED_DIR, lang, featureName, relFile)
            fs.mkdirSync(path.dirname(dest), { recursive: true })
            fs.copyFileSync(filePath, dest)
            console.log(`  ✅ ${path.relative(ROOT, dest)}`)
            copied++
        })
        console.log(`\n  共复制 ${copied} 个文件`)
    }

    // ── 重建索引 ──────────────────────────────────────────────
    console.log('\n🔧 重建知识库索引...')
    try {
        cp.execSync(`node ${path.join(__dirname, 'build-index.js')}`, {
            stdio: 'inherit',
            cwd: path.dirname(__dirname)
        })
    } catch (err) {
        console.error('❌ 索引构建失败')
        process.exit(1)
    }

    // ── 可选向量化 ────────────────────────────────────────────
    if (doVec) {
        console.log('\n🔮 写入 Chroma 向量库...')
        try {
            cp.execSync(`node ${path.join(__dirname, 'vectorize.js')}`, {
                stdio: 'inherit',
                env: { ...process.env }
            })
        } catch (err) {
            console.error('⚠️  向量化失败（不影响 BM25 检索）')
        }
    } else {
        console.log('\n💡 提示：运行以下命令写入向量库（需 Chroma 已启动）：')
        console.log(`   node knowledge-base/scripts/vectorize.js`)
    }

    // ── 显示当前知识库统计 ────────────────────────────────────
    const kb = JSON.parse(fs.readFileSync(path.join(ROOT, 'index/kb.json'), 'utf8'))
    console.log(`\n📊 知识库当前状态:`)
    console.log(`   总 chunk 数: ${kb.totalChunks}`)
    console.log(`   最后更新:   ${kb.builtAt}`)

    const byLang = {}
    for (const c of kb.chunks) {
        byLang[c.language] = (byLang[c.language] || 0) + 1
    }
    Object.entries(byLang).forEach(([lang, count]) => {
        console.log(`   ${lang}: ${count} chunks`)
    })
}

function walkDir(dir, callback) {
    fs.readdirSync(dir).forEach(name => {
        const full = path.join(dir, name)
        if (fs.statSync(full).isDirectory()) walkDir(full, callback)
        else callback(full)
    })
}

main()