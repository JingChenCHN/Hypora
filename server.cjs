// Hypora Web 版静态服务器 + AI 同源代理(零依赖, node server.cjs [端口], 默认 8080)
//
// 1) 静态托管 dist/ 产物(同旧版 server.cjs)。
// 2) /api/ai* 同源代理:浏览器把访客自己的 API Key 放 Authorization 头发给同源 /api/ 端点,
//    本代理在白名单校验后,把该头原样转发给目标 LLM(DeepSeek / GLM / 本地 llama-server),
//    并把 SSE 流原样回传前端。
//
// 安全模型:代理本身不持有、不存储任何 API Key(透传 + 上游白名单), 因此不会产生「站点级中心密钥」
// 泄露。每个访客用自己的 Key, 只经过 自己浏览器 → 同源代理 → 对应云 API 一条链路, Key 不落盘、
// 不打日志。若日后想改为「站点内置统一 Key」供访客免填:只需在 sendToUpstream 里用服务端变量
// 覆盖 Authorization, 前端零改动。
//
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')

const PORT = parseInt(process.argv[2] || '8080', 10)
const ROOT = path.resolve(__dirname)

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.map': 'application/json', '.webp': 'image/webp',
}

// 允许代理转发的上游白名单。请求头 X-Hypora-Target 提供完整上游 URL, 仅当 host 命中此表才放行,
// 防止被当作开放代理滥用。若要新增云厂商, 在此加一行。
const ALLOW_HOSTS = new Set([
  'api.deepseek.com',
  'open.bigmodel.cn',
  '127.0.0.1',
  'localhost',
])

function applyProxy(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('Method Not Allowed')
  }

  // X-Hypora-Target = 完整上游 URL(含 path/query, 前端已拼好 base+endpoint)。
  //   例:https://api.deepseek.com/v1/chat/completions、https://open.bigmodel.cn/api/paas/v4/chat/completions
  const targetRaw = req.headers['x-hypora-target'] || ''
  let upstream
  try { upstream = new URL(targetRaw) } catch { upstream = null }
  if (!upstream || !ALLOW_HOSTS.has(upstream.hostname)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('disallowed upstream target')
  }

  // 对本地主机允许 http;云必须 https
  const isLocal = upstream.hostname === '127.0.0.1' || upstream.hostname === 'localhost'
  if (!isLocal && upstream.protocol !== 'https:') {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('https required for remote upstream')
  }

  // 读取并透传 Authorization(访客自己的 Key), 再补 Content-Type;其余头忽略
  const headers = { 'Content-Type': req.headers['content-type'] || 'application/json' }
  if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization']

  // 请求体大小上限(多模态图片单张 10MB, 给到 64MB 防过载)
  const MAX_BODY = 64 * 1024 * 1024
  const chunks = []
  let size = 0
  req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { req.destroy() } else chunks.push(c) })
  req.on('error', () => { if (!res.headersSent) { res.writeHead(400); res.end('bad request body') } })
  req.on('end', () => {
    const bodyBuf = Buffer.concat(chunks)
    const transport = isLocal ? http : https
    const apreq = transport.request(upstream, {
      method: req.method,
      headers,
      timeout: 120000,
    }, (upres) => {
      res.writeHead(upres.statusCode || 502, {
        'Content-Type': upres.headers['content-type'] || 'application/json',
        'Cache-Control': upres.headers['cache-control'] || 'no-store',
      })
      upres.pipe(res)
      upres.on('error', () => { res.end() })
    })
    apreq.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`proxy error: ${err.message}`)
    })
    apreq.on('timeout', () => { apreq.destroy(new Error('upstream timeout')) })
    apreq.write(bodyBuf)
    apreq.end()
  })
}

function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0])
  if (p === '/' || p === '') p = '/index.html'
  const file = path.join(ROOT, p)
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden') }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not Found') }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(buf)
  })
}

http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0]
  if (urlPath === '/api/ai' || urlPath.startsWith('/api/ai/')) {
    return applyProxy(req, res)
  }
  return serveStatic(req, res)
}).listen(PORT, () => console.log('Hypora Web 已启动(静态+AI代理): http://localhost:' + PORT))