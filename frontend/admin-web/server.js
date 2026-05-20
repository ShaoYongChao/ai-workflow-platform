'use strict'
/**
 * server.js — 纯 Node.js 内置 http 静态文件服务器
 * 服务 public/ 目录，零依赖
 */
const http = require('http')
const fs   = require('fs')
const path = require('path')

// 读取 .env
const envFile = [
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../../../.env'),
  path.resolve(process.cwd(), '.env'),
].find(f => fs.existsSync(f))
if (envFile) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim()
  })
}

const PORT       = parseInt(process.env.ADMIN_WEB_PORT || '3007')
const PUBLIC_DIR = path.join(__dirname, 'public')
const ADMIN_API  = process.env.NEXT_PUBLIC_ADMIN_API || 'http://localhost:3006/api/admin'
const ADMIN_KEY  = process.env.ADMIN_API_KEY || ''

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
}

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')

  let reqPath = req.url.split('?')[0]
  if (reqPath === '/') reqPath = '/index.html'

  const filePath = path.join(PUBLIC_DIR, reqPath)

  // 防止目录遍历
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback: 所有路由都返回 index.html
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); res.end('Not Found'); return }
        // 注入 API 地址配置
        const injected = html.toString().replace(
          '</head>',
          `<script>window.__AWP_API__='${ADMIN_API}';window.__AWP_KEY__='${ADMIN_KEY}'</script></head>`
        )
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(injected)
      })
      return
    }

    const ext  = path.extname(filePath)
    const mime = MIME[ext] || 'application/octet-stream'

    // index.html 注入 API 配置
    if (filePath.endsWith('index.html')) {
      const injected = data.toString().replace(
        '</head>',
        `<script>window.__AWP_API__='${ADMIN_API}';window.__AWP_KEY__='${ADMIN_KEY}'</script></head>`
      )
      res.writeHead(200, { 'Content-Type': mime })
      res.end(injected)
    } else {
      res.writeHead(200, { 'Content-Type': mime })
      res.end(data)
    }
  })
})

server.listen(PORT, () => {
  console.log(`🚀 admin-web 服务启动，端口 ${PORT}`)
  console.log(`   访问地址: http://localhost:${PORT}`)
  console.log(`   API 地址: ${ADMIN_API}`)
})

server.on('error', err => {
  console.error('服务器启动失败:', err.message)
  process.exit(1)
})
