// Hypora Web 版打包：纯静态前端资源，部署到任意 web server（nginx / 静态托管 / 本地预览）即可浏览器访问。
// 不含 Electron 运行时；文件保存走浏览器下载，窗口控制等桌面 API 已降级。
// release 规则与 Electron 版一致：含 sourcecode/ 源码模块，便于服务器编译与二次开发。
// 用法: node scripts/build-web.cjs
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { packSourcecode } = require('./pack-sourcecode.cjs')

const root = path.join(__dirname, '..')

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`)
  execSync(cmd, { stdio: 'inherit', cwd: root, ...opts })
}

function main() {
  console.log('【1/6】构建前端资源...')
  run('npx vite build')

  console.log('【2/6】清理 web 输出目录...')
  const outDir = path.join(root, 'release/web')
  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })

  console.log('【3/6】拷贝静态站点...')
  fs.cpSync(path.join(root, 'dist'), outDir, { recursive: true })

  console.log('【4/6】写入部署说明与本地预览脚本...')
  // 可选：内嵌零依赖 Node 静态服务器，方便服务器上快速启动预览
  const server = `// 零依赖静态服务器：node server.cjs [端口]（默认 8080）
const http = require('http')
const fs = require('fs')
const path = require('path')
const PORT = parseInt(process.argv[2] || '8080', 10)
const ROOT = __dirname
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.map': 'application/json', '.webp': 'image/webp'
}
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0])
  if (p === '/' || p === '') p = '/index.html'
  const file = path.join(ROOT, p)
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden') }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not Found') }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(buf)
  })
}).listen(PORT, () => console.log('Hypora Web 版已启动: http://localhost:' + PORT))
`
  fs.writeFileSync(path.join(outDir, 'server.cjs'), server, 'utf-8')

  const readme = `# Hypora Web 版

纯静态前端构建，部署到任意 web server 即可通过浏览器访问。

## 快速预览（零依赖）

\`\`\`bash
node server.cjs            # 默认 8080
node server.cjs 3000       # 指定端口
\`\`\`
浏览器打开 http://localhost:8080

## 部署到 nginx / 静态托管

将本目录所有文件上传到站点根目录（或子目录）即可。已用相对路径（base './'），支持子路径部署。

nginx 示例：

\`\`\`nginx
server {
  listen 80;
  server_name hypora.example.com;
  root /var/www/hypora;   # 指向本目录
  index index.html;
  location / { try_files $uri $uri/ /index.html; }
}
\`\`\`

## 与桌面版的差异

- **文件保存**：走浏览器下载（"另存为"），无法直接写回本地路径。打开本地文件用浏览器文件选择器。
- **窗口置顶等桌面控制**：不可用（已降级提示"仅在桌面客户端可用"）。
- **.md 文件关联**：不可用（这是桌面端特性）。
- **AI 助手**：可直接调用 DeepSeek / GLM。浏览器跨域请求需对应 API 允许 CORS；若遇跨域拦截，建议通过后端代理转发。
- **主题、编辑、导出 MD/HTML、公式、Mermaid 图表**：均与桌面版一致。

## 源码

如需二次开发或本地构建，参见同目录 \`sourcecode/\`（若打包时包含）或项目主仓库。
`
  fs.writeFileSync(path.join(outDir, 'README.md'), readme, 'utf-8')

  console.log('【5/6】打包源码模块 sourcecode（供服务器编译与二次开发）...')
  packSourcecode(outDir, 'web')

  console.log('【6/6】复制官网营销页到 release/site/ ...')
  const siteOut = path.join(root, 'release', 'site')
  if (fs.existsSync(siteOut)) fs.rmSync(siteOut, { recursive: true, force: true })
  fs.mkdirSync(siteOut, { recursive: true })
  const siteSrc = path.join(root, 'site', 'index.html')
  if (fs.existsSync(siteSrc)) {
    fs.copyFileSync(siteSrc, path.join(siteOut, 'index.html'))
    // 官网为单文件静态页，复用零依赖服务器便于预览
    fs.copyFileSync(path.join(outDir, 'server.cjs'), path.join(siteOut, 'server.cjs'))
  } else {
    console.log('  ⚠️ 未找到 site/index.html，跳过官网复制')
  }

  console.log('\n✅ Web 版打包完成！')
  console.log(`📍 静态站点: ${outDir}\\`)
  console.log(`📍 源码位置: ${outDir}\\sourcecode\\`)
  console.log(`📍 官网页面: ${siteOut}\\`)
  console.log(`   预览: node "${outDir}\\server.cjs"`)
}

main()
