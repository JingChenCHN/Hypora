// ============ 内置本地 LLM 引擎（llama.cpp sidecar）============
// 托管 MiniCPM 2B 的 llama-server 子进程：模型下载/校验、后端回落（vulkan→cpu）、
// 端口协商、健康轮询与状态推送。渲染层经 ai-engine:* IPC 交互。
// 本模块只在 Electron 主进程加载；纯 Node（harness/脚本）下 electron require 失败被吞、
// 路径退到 home 目录，导出函数（snapshot/getConfig 等）仍可直接调用。
const path = require('path')
const fs = require('fs')
const os = require('os')
const net = require('net')
const http = require('http')
const https = require('https')
const events = require('events')
const { spawn } = require('child_process')

// electron 惰性容错：npm 安装的 electron 包在纯 Node 下导出的是二进制路径字符串，同样按 null 处理
let electron = null
try {
  const mod = require('electron')
  if (mod && typeof mod === 'object' && mod.app && mod.ipcMain) electron = mod
} catch { electron = null }

// ============ 常量 ============
// 双模型：默认 Q4_K_M（体积小、下载快），保留 Q8_0 供更高精度需求选用；字节数用于完整性校验
const MODELS = {
  'MiniCPM5-2B-Q4_K_M.gguf': {
    url: 'https://hf-mirror.com/openbmb/MiniCPM5-2B-GGUF/resolve/main/MiniCPM5-2B-Q4_K_M.gguf',
    bytes: 1561318368,
    isDefault: true,
  },
  'MiniCPM5-2B-Q8_0.gguf': {
    url: 'https://hf-mirror.com/openbmb/MiniCPM5-2B-GGUF/resolve/main/MiniCPM5-2B-Q8_0.gguf',
    bytes: 2679710688,
  },
}
const DEFAULT_MODEL = 'MiniCPM5-2B-Q4_K_M.gguf'
const PORT_CANDIDATES = [8899, 8900, 8901, 8902, 8903, 8904, 8905, 8906, 8907, 8908, 8909]
const HEALTH_TIMEOUT_MS = 90_000          // 模型加载上限（2B Q8 冷启动数秒～数十秒）
const HEALTH_POLL_MS = 400
const DOWNLOAD_PROGRESS_MS = 200          // 进度推送节流
const BACKENDS = ['vulkan', 'cpu']
const RING_LIMIT = 200                    // 每个后端保留的最后输出行数
const STOP_EXIT_WAIT_MS = 3000            // stop 等子进程退出的兜底时长
const IDLE_DELAY_MS = 3000                // done/cancelled 延迟回 idle，避免面板残留旧进度

// ============ 路径 ============
// 引擎根目录：有 electron 用 <userData>/ai-engine，无 electron（harness）退 ~/.hypora-ai-engine
function engineRoot() {
  const app = electron?.app
  if (app && typeof app.getPath === 'function') return path.join(app.getPath('userData'), 'ai-engine')
  return path.join(os.homedir(), '.hypora-ai-engine')
}
const modelDir = () => path.join(engineRoot(), 'models')
const modelPathOf = (name) => path.join(modelDir(), name)
const engineJsonPath = () => path.join(engineRoot(), 'engine.json')

// 二进制根：HYPORA_AI_ENGINE_DIR 可覆盖（harness 用），否则随打包态取 resources 或源码目录
function binRoot() {
  if (process.env.HYPORA_AI_ENGINE_DIR) return process.env.HYPORA_AI_ENGINE_DIR
  const app = electron?.app
  if (app) {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'ai-engine', 'win-x64')
      : path.join(__dirname, 'ai-engine', 'win-x64')
  }
  return path.join(__dirname, 'ai-engine', 'win-x64')
}
const exeName = () => (process.platform === 'win32' ? 'llama-server.exe' : 'llama-server')
const exePathOf = (b) => path.join(binRoot(), b, exeName())   // zip 内容扁平，llama-server 直接位于后端目录下

// ============ 日志 ============
let logger = null                                  // 注入的主进程日志函数 (level, msg)
const ringBuf = { vulkan: [], cpu: [] }            // 各后端最近输出（失败诊断取尾部）
const pendingLine = { vulkan: '', cpu: '' }        // 跨 chunk 的半行缓冲

const dateStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

function log(level, msg) {
  try { if (logger) logger(level, msg) } catch { /* 忽略 */ }
  const app = electron?.app
  if (!app || typeof app.getPath !== 'function') return   // 无 electron：只进内存环形缓冲
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, `ai-engine-${dateStr()}.log`), `[${new Date().toISOString()}] [${level}] [ai-engine] ${msg}\n`)
  } catch { /* 忽略写失败 */ }
}

// 子进程输出按行喂进环形缓冲（各保留最后 RING_LIMIT 行）并落盘
function feedOutput(b, chunk) {
  let buf = (pendingLine[b] || '') + chunk.toString()
  const lines = buf.split(/\r?\n/)
  buf = lines.pop() || ''
  if (buf.length > 4000) {                // 进度条等无换行的长输出：强制断行防缓冲膨胀
    lines.push(buf.slice(0, 4000))
    buf = ''
  }
  pendingLine[b] = buf
  for (const line of lines) {
    const text = line.trim()
    if (!text) continue
    const out = text.length > 500 ? text.slice(0, 500) + '…' : text
    const arr = ringBuf[b]
    arr.push(out)
    if (arr.length > RING_LIMIT) arr.splice(0, arr.length - RING_LIMIT)
    log('INFO', `[${b}] ${out}`)
  }
}
const tailLogs = (b, n) => (ringBuf[b] || []).slice(-n)

// ============ 引擎状态机 ============
// phase ∈ stopped | starting | running | stopping | failed
let phase = 'stopped'
let backend = null
let port = null
let pid = null
let startedAt = null
let error = null
let child = null
let startToken = 0          // 启动序号：所有异步回调先校验 token，防回落/快速启停产生僵尸迁移

function snapshot() {
  return {
    phase, backend, port,
    baseUrl: phase === 'running' && port ? `http://127.0.0.1:${port}` : null,
    model: activeModel,
    pid, startedAt, error
  }
}

// 状态迁移后向所有窗口推送快照
function pushStatus() {
  const snap = snapshot()
  for (const win of electron?.BrowserWindow?.getAllWindows?.() || []) {
    try { win.webContents.send('ai-engine-status', snap) } catch { /* 忽略 */ }
  }
}

// ============ 端口记忆与协商 ============
function readEngineJson() {
  try { return JSON.parse(fs.readFileSync(engineJsonPath(), 'utf-8')) || {} } catch { return {} }
}
function writeEngineJson(patch) {
  try {
    fs.mkdirSync(engineRoot(), { recursive: true })
    fs.writeFileSync(engineJsonPath(), JSON.stringify({ ...readEngineJson(), ...patch }, null, 2))
  } catch (e) { log('ERROR', `写 engine.json 失败: ${e.message}`) }
}

// 上次成功端口优先，其余候选去重
function candidatePorts() {
  const last = readEngineJson().lastPort
  const list = Number.isInteger(last) && last > 0 ? [last, ...PORT_CANDIDATES] : [...PORT_CANDIDATES]
  return [...new Set(list)]
}

// 真实 bind 探测：绑得上说明端口空闲，立即 close 再交给 llama-server 抢占
function canBind(p) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(p, '127.0.0.1')
  })
}
async function findFreePort() {
  for (const p of candidatePorts()) if (await canBind(p)) return p
  return null
}

// ============ 健康轮询 ============
// /health 返回 5xx/连接拒绝 = 模型加载中，2xx = 就绪；每跳校验 token，超时上限由上层竞速兜底
function pollHealth(p, token) {
  return new Promise((resolve) => {
    let timer = null
    let done = false
    const finish = (kind) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve({ kind })
    }
    const tick = () => {
      if (token !== startToken) return finish('abort')
      const req = http.get({ host: '127.0.0.1', port: p, path: '/health', timeout: 2000 }, (res) => {
        res.resume()
        if (res.statusCode >= 200 && res.statusCode < 300) finish('ready')
        else timer = setTimeout(tick, HEALTH_POLL_MS)
      })
      req.on('timeout', () => req.destroy())
      req.on('error', () => { if (!done) timer = setTimeout(tick, HEALTH_POLL_MS) })
    }
    timer = setTimeout(tick, HEALTH_POLL_MS)
  })
}

// 等待子进程退出，最多 ms（失败清理时避免残留进程占着端口）
function waitExit(c, ms) {
  return new Promise((resolve) => {
    let over = false
    const fin = () => { if (!over) { over = true; resolve() } }
    c.once('exit', fin)
    setTimeout(fin, ms)
  })
}

// ============ 启动单后端 ============
// 就绪返回 true；进程退出 / 健康超时 / spawn 失败返回 false，并把原因写进 attempts[b]
async function runBackend(b, token, attempts) {
  const free = await findFreePort()
  if (token !== startToken) return false
  if (!free) { attempts[b] = '候选端口全部被占用'; return false }
  const args = [
    '--host', '127.0.0.1', '--port', String(free),
    '--model', modelPathOf(activeModel), '--ctx-size', '8192', '--no-webui',
    // vulkan 全量 offload 到 GPU；cpu 走纯 CPU，留 2 核给主进程
    ...(b === 'vulkan' ? ['-ngl', '999'] : ['-ngl', '0', '-t', String(Math.max(1, os.cpus().length - 2))])
  ]
  let c
  try {
    c = spawn(exePathOf(b), args, { cwd: path.join(binRoot(), b), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    attempts[b] = e.message
    log('ERROR', `spawn ${b} 失败: ${e.message}`)
    return false
  }
  child = c
  backend = b
  port = free
  pid = c.pid
  startedAt = Date.now()
  log('INFO', `启动 ${b} 后端 (pid=${c.pid}, port=${free}, model=${activeModel})`)

  c.stdout.on('data', (chunk) => feedOutput(b, chunk))
  c.stderr.on('data', (chunk) => feedOutput(b, chunk))
  let timeoutTimer = null
  const exitP = new Promise((resolve) => c.once('exit', (code, signal) => resolve({ kind: 'exit', code, signal })))
  const errorP = new Promise((resolve) => c.once('error', (e) => resolve({ kind: 'error', message: e.message })))
  const timeoutP = new Promise((resolve) => { timeoutTimer = setTimeout(() => resolve({ kind: 'timeout' }), HEALTH_TIMEOUT_MS) })

  const outcome = await Promise.race([exitP, errorP, pollHealth(free, token), timeoutP])
  if (timeoutTimer) clearTimeout(timeoutTimer)
  if (token !== startToken) {             // 期间发生 stop / 新 start，让位
    try { c.kill() } catch { /* 忽略 */ }
    return false
  }
  if (outcome.kind === 'ready') {
    phase = 'running'
    error = null
    writeEngineJson({ lastPort: free })   // 记住可用端口，下次优先
    pushStatus()
    log('INFO', `引擎就绪: http://127.0.0.1:${free}`)
    // running 期间意外退出（任务管理器杀进程等）：回 stopped，渲染层 streamChat 报错后自行刷新状态
    c.once('exit', () => {
      if (token !== startToken || phase !== 'running') return
      phase = 'stopped'
      error = null
      pid = null
      startedAt = null
      child = null
      pushStatus()
      log('INFO', '引擎进程意外退出')
    })
    return true
  }
  attempts[b] = outcome.kind === 'error' ? outcome.message
    : outcome.kind === 'exit' ? `进程退出(code=${outcome.code ?? outcome.signal})`
      : `健康检查超时（${HEALTH_TIMEOUT_MS / 1000}s）`
  log('ERROR', `${b} 启动失败: ${attempts[b]}`)
  try { c.kill() } catch { /* 忽略 */ }
  await waitExit(c, STOP_EXIT_WAIT_MS)
  if (token === startToken) child = null
  return false
}

// ============ start ============
let activeModel = DEFAULT_MODEL            // 本次引擎实际加载的模型（start 时择定）

// 模型文件就绪 = 存在且字节数与注册表严格一致（残件/损坏件不算）
function modelFileOk(name) {
  try {
    return fs.existsSync(modelPathOf(name)) && fs.statSync(modelPathOf(name)).size === MODELS[name].bytes
  } catch { return false }
}

// 择模型：默认优先（已就绪才作数），其次任一注册表模型，再其次目录内任一模型；都没有返回 null
function pickModel() {
  if (modelFileOk(DEFAULT_MODEL)) return DEFAULT_MODEL
  for (const name of Object.keys(MODELS)) {
    if (modelFileOk(name)) return name
  }
  const locals = scanLocalModels()
  return locals.length ? locals[0].name : null
}

// 扫描模型目录：所有 GGUF 魔数校验通过的文件皆为可选模型（不限于内置下载目录，用户自放模型同样可选）
function scanLocalModels() {
  const dir = modelDir()
  let entries = []
  try { entries = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.gguf')) } catch { return [] }
  const out = []
  for (const name of entries) {
    try {
      const fp = modelPathOf(name)
      const st = fs.statSync(fp)
      if (!st.isFile() || st.size < 4) continue
      const head = Buffer.alloc(4)
      const fd = fs.openSync(fp, 'r')
      fs.readSync(fd, head, 0, 4, 0)
      fs.closeSync(fd)
      if (head.toString('latin1') !== 'GGUF') continue
      out.push({ name, size: st.size, isDefault: name === DEFAULT_MODEL })
    } catch { /* 跳过不可读文件 */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

// 可运行判定：目录扫描（GGUF 校验）通过即可；注册表模型的严格字节校验只用于下载完整性
function isRunnableModel(name) {
  return !!name && scanLocalModels().some((m) => m.name === name)
}

// 用户显式选择的运行模型（engine.json 持久化）；文件失效时回落自动择取
let selectedModel = null
try { selectedModel = readEngineJson().selectedModel ?? null } catch { selectedModel = null }

// 有效择取：显式选择优先（目录内 GGUF 校验通过即可），否则默认优先自动选
function resolveSelection() {
  if (selectedModel && isRunnableModel(selectedModel)) return selectedModel
  return pickModel()
}

// 用户选择运行其一：持久化偏好；引擎在跑/启动中则等 stop 收尾后自动以新模型重启
function setModel(name) {
  if (!name || !isRunnableModel(name)) {
    log('WARN', `忽略不可用的模型选择: ${name}`)
    return snapshot()
  }
  selectedModel = name
  writeEngineJson({ selectedModel: name })
  log('INFO', `已选择运行模型: ${name}`)
  if (phase === 'running' || phase === 'starting') {
    stop()
    const t = setInterval(() => {
      if (phase === 'stopping') return
      clearInterval(t)
      start().catch(() => {})
    }, 120)
  }
  return snapshot()
}

async function start() {
  if (phase === 'starting' || phase === 'running') return snapshot()   // 幂等

  // 择模型：用户显式选择优先，其次默认 Q4_K_M、任一已下载；一个都没有 → phase 保持 stopped，抛 MODEL_MISSING 让渲染层弹下载卡
  const chosen = resolveSelection()
  if (!chosen) {
    phase = 'stopped'
    error = null
    const err = new Error('内置模型尚未下载')
    err.code = 'MODEL_MISSING'
    throw err
  }
  activeModel = chosen
  // 二进制存在性：vulkan 缺失则跳过直接用 cpu；两个都缺 → failed
  const usable = BACKENDS.filter((b) => fs.existsSync(exePathOf(b)))
  if (!usable.length) {
    phase = 'failed'
    error = `引擎文件缺失（${exePathOf('vulkan')}、${exePathOf('cpu')} 均未找到）`
    pushStatus()
    log('ERROR', error)
    return snapshot()
  }
  phase = 'starting'
  error = null
  backend = null
  pushStatus()
  const attempts = {}
  for (let i = 0; i < usable.length; i++) {
    const b = usable[i]
    const token = ++startToken
    attempts[b] = null
    const ok = await runBackend(b, token, attempts)
    if (token !== startToken) return snapshot()     // 期间被 stop / 新 start 接管
    if (ok) return snapshot()
    if (i < usable.length - 1) log('INFO', `${b} 不可用，回落 ${usable[i + 1]}`)
  }

  // 两个后端都失败：拼两份日志尾部给出可诊断的 error
  phase = 'failed'
  pid = null
  startedAt = null
  error = '启动失败（Vulkan 与 CPU 均不可用）：' + usable.map((b) => {
    const tail = tailLogs(b, 3).join(' / ') || '(无输出)'
    return `[${b}] ${attempts[b] || '未知原因'}；日志末尾: ${tail}`
  }).join('；')
  pushStatus()
  log('ERROR', error)
  return snapshot()
}

// ============ stop / kill ============
function settleStopped() {
  if (phase !== 'stopping') return
  child = null
  phase = 'stopped'
  pid = null
  startedAt = null
  pushStatus()
}

function stop() {
  if (phase !== 'running' && phase !== 'starting') return snapshot()
  phase = 'stopping'
  startToken++                      // 作废一切在途回调（健康轮询、回落、意外退出）
  pushStatus()
  const c = child
  if (!c) { settleStopped(); return snapshot() }
  log('INFO', `停止引擎 (pid=${c.pid})`)
  try { c.kill() } catch { /* 忽略 */ }
  if (process.platform === 'win32' && c.pid) {
    // taskkill /T 连树强杀，防 llama-server 子进程成孤儿（无需等待结果）
    try { spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* 忽略 */ }
  }
  c.once('exit', settleStopped)
  setTimeout(settleStopped, STOP_EXIT_WAIT_MS)
  return snapshot()
}

// before-quit / will-quit 的同步清理入口：有子进程就杀，不推送状态，不抛错
function kill() {
  startToken++
  const c = child
  child = null
  if (c) {
    try { c.kill() } catch { /* 忽略 */ }
    if (process.platform === 'win32' && c.pid) {
      try { spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* 忽略 */ }
    }
  }
  phase = 'stopped'
  pid = null
}

// ============ 模型下载 ============
let dlModel = null                        // 当前下载的模型名
let dlState = { phase: 'idle', model: null, receivedBytes: 0, totalBytes: 0, percent: 0, bytesPerSecond: 0, error: null }
let dlReq = null            // 在途请求（取消用）
let dlStream = null         // 在途写盘流（取消时关闭，防句柄泄漏阻塞后续改名）
let dlToken = 0             // 下载序号：作废旧的进度/完成/取消定时器

function setDl(patch) { dlState = { ...dlState, ...patch } }
function pushDownload() {
  for (const win of electron?.BrowserWindow?.getAllWindows?.() || []) {
    try { win.webContents.send('ai-engine-download', dlState) } catch { /* 忽略 */ }
  }
}

function downloadModel(modelName) {
  const name = MODELS[modelName] ? modelName : DEFAULT_MODEL   // 未指定 → 默认模型
  if (dlState.phase === 'downloading') {
    if (dlModel === name) return { ...dlState }               // 同模型幂等
    downloadCancel()                                          // 换模型：先取消在途
  }
  dlModel = name
  dlToken++
  runDownload(dlToken)
  return { ...dlState }
}

// 取消：abort 请求，.part 保留供下次断点续传
function downloadCancel() {
  if (dlState.phase !== 'downloading') return { ...dlState }
  dlToken++
  const req = dlReq
  if (req) { try { typeof req.abort === 'function' ? req.abort() : req.destroy() } catch { /* 忽略 */ } }
  dlReq = null
  if (dlStream) { try { dlStream.destroy() } catch { /* 忽略 */ } dlStream = null }
  setDl({ phase: 'cancelled', bytesPerSecond: 0 })
  pushDownload()
  const token = dlToken
  setTimeout(() => { if (token === dlToken) { setDl({ phase: 'idle' }); pushDownload() } }, IDLE_DELAY_MS)
  return { ...dlState }
}

// electron net 优先（走 chromium 网络栈），无 electron 退化 https（harness）
function makeRequest(headers, url) {
  if (electron?.net?.request) return electron.net.request({ method: 'GET', url, headers })
  return httpsFollow(url, headers)
}

// 纯 Node https 降级不自动跟随 3xx（hf-mirror resolve/main 会 302 到 CDN）：
// 包一层手动重定向，对外保持 request 事件接口（on('response')/abort/destroy）。
// electron.net 走 Chromium 网络栈，本就自动跟随，直通即可。
function httpsFollow(url, headers) {
  const out = new events.EventEmitter()
  let inner = null
  let destroyed = false
  const go = (u, left) => {
    if (destroyed) return
    if (left <= 0) { process.nextTick(() => out.emit('error', new Error('重定向过多'))); return }
    const req = https.request(u, { method: 'GET', headers })
    inner = req
    req.on('response', (res) => {
      const loc = res.headers && res.headers.location
      if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume()                                     // 排空旧响应
        go(new URL(loc, u).toString(), left - 1)
        return
      }
      out.emit('response', res)
    })
    req.on('error', (e) => { if (!destroyed) out.emit('error', e) })
    req.end()
  }
  go(url, 5)
  out.abort = () => { destroyed = true; if (inner) { try { inner.destroy() } catch { /* 忽略 */ } } }
  out.destroy = out.abort
  out.end = () => {}                                   // 内层请求在 go() 里已 end，这里仅为对齐 request 接口
  return out
}

function runDownload(token) {
  fs.mkdirSync(modelDir(), { recursive: true })
  const total = MODELS[dlModel].bytes
  const partPath = modelPathOf(dlModel) + '.part'
  let resumeFrom = 0
  try { resumeFrom = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0 } catch { resumeFrom = 0 }

  setDl({
    phase: 'downloading', model: dlModel, receivedBytes: resumeFrom, totalBytes: total, error: null, bytesPerSecond: 0,
    percent: Math.min(100, Math.round((resumeFrom / total) * 100))
  })
  pushDownload()
  log('INFO', resumeFrom > 0 ? `从 ${resumeFrom} 字节处续传模型` : '开始下载模型')

  let req
  try {
    req = makeRequest(resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {}, MODELS[dlModel].url)
  } catch (e) {
    setDl({ phase: 'error', error: e.message })
    pushDownload()
    return
  }
  dlReq = req
  let received = resumeFrom
  let lastBytes = resumeFrom
  let lastAt = Date.now()
  let lastPushAt = lastAt
  req.on('response', (res) => {
    const code = res.statusCode
    if (code !== 200 && code !== 206) {
      setDl({ phase: 'error', error: `下载失败：HTTP ${code}` })
      pushDownload()
      log('ERROR', `下载失败：HTTP ${code}`)
      return
    }
    if (code === 200 && resumeFrom > 0) received = 0     // 服务端忽略 Range：截断重下
    const offset = received
    setDl({ receivedBytes: offset, percent: Math.min(100, Math.round((offset / total) * 100)) })

    const stream = fs.createWriteStream(partPath, { flags: offset > 0 ? 'a' : 'w' })
    dlStream = stream
    stream.on('error', (e) => {
      if (token !== dlToken) return
      setDl({ phase: 'error', error: e.message })        // .part 保留，下次续传
      pushDownload()
      log('ERROR', `写入失败: ${e.message}`)
    })
    res.on('data', (chunk) => {
      if (token !== dlToken) return
      received += chunk.length
      const now = Date.now()
      if (now - lastPushAt < DOWNLOAD_PROGRESS_MS) return
      const dt = (now - lastAt) / 1000
      const bps = dt > 0 ? (received - lastBytes) / dt : 0
      lastBytes = received
      lastAt = now
      lastPushAt = now
      setDl({
        receivedBytes: received, bytesPerSecond: bps,
        percent: Math.min(100, Math.round((received / total) * 100))
      })
      pushDownload()
    })
    res.pipe(stream)
    stream.on('finish', () => { dlStream = null; finishDownload(token, partPath) })
  })

  req.on('error', (e) => {
    if (token !== dlToken) return                        // 已取消 / 已被新下载取代
    setDl({ phase: 'error', error: e.message })          // .part 保留，断点续传
    pushDownload()
    log('ERROR', `下载失败: ${e.message}`)
  })
  req.end()
}

// 下载完成：校验字节数 + GGUF 魔数，通过后原子改为正式名
function finishDownload(token, partPath) {
  dlReq = null
  if (token !== dlToken) return
  try {
    const size = fs.statSync(partPath).size
    const head = Buffer.alloc(4)
    const fd = fs.openSync(partPath, 'r')
    fs.readSync(fd, head, 0, 4, 0)
    fs.closeSync(fd)
    if (size !== MODELS[dlModel].bytes || head.toString('latin1') !== 'GGUF') {
      fs.rmSync(partPath, { force: true })
      setDl({ phase: 'error', error: '模型文件校验失败，请重新下载', receivedBytes: 0, percent: 0, bytesPerSecond: 0 })
      pushDownload()
      log('ERROR', '模型文件校验失败，已删除残件')
      return
    }
    fs.renameSync(partPath, modelPathOf(dlModel))
    setDl({ phase: 'done', receivedBytes: size, percent: 100, bytesPerSecond: 0, error: null })
    pushDownload()
    log('INFO', `模型下载完成（${size} 字节）`)
    setTimeout(() => { if (token === dlToken) { setDl({ phase: 'idle' }); pushDownload() } }, IDLE_DELAY_MS)
  } catch (e) {
    setDl({ phase: 'error', error: e.message })
    pushDownload()
    log('ERROR', `模型落盘失败: ${e.message}`)
  }
}

// ============ 配置查询 ============
function getConfig() {
  const local = scanLocalModels()
  const catalog = Object.entries(MODELS).map(([name, m]) => {
    const fp = modelPathOf(name)
    let size = 0
    try { if (fs.existsSync(fp)) size = fs.statSync(fp).size } catch { size = 0 }
    return { name, url: m.url, bytes: m.bytes, isDefault: !!m.isDefault, present: modelFileOk(name), size }
  })
  return {
    models: local,        // 模型目录实际存在的可运行模型（GGUF 校验通过）
    catalog,              // 内置下载目录（注册表）；本地已有者由渲染层过滤
    defaultModel: DEFAULT_MODEL,
    // 兼容字段：目录内有可运行模型即视为就绪；activeModel 为下次 start 实际加载者（显式选择优先）
    modelExists: local.length > 0,
    selectedModel: selectedModel && isRunnableModel(selectedModel) ? selectedModel : null,
    activeModel: resolveSelection(),
    binRoot: binRoot(),
    binaries: { vulkan: fs.existsSync(exePathOf('vulkan')), cpu: fs.existsSync(exePathOf('cpu')) }
  }
}

function openModelsDir() {
  const dir = modelDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const shell = electron?.shell
  if (!shell || typeof shell.openPath !== 'function') throw new Error('当前环境不支持打开目录')
  return shell.openPath(dir)
}

// ============ IPC 注册 ============
let registered = false
function initAiEngine(loggerFn) {
  logger = typeof loggerFn === 'function' ? loggerFn : null
  const ipc = electron?.ipcMain
  if (ipc && !registered) {
    registered = true
    // 统一兜底：handler 抛错转 { error }，不让渲染层收到无响应的 invoke
    const handle = (channel, fn) => ipc.handle(channel, async (...args) => {
      try { return await fn(...args) } catch (e) {
        log('ERROR', `${channel} 失败: ${e.message}`)
        return { error: e.message }
      }
    })
    handle('ai-engine:get-status', () => snapshot())
    handle('ai-engine:start', () => start())
    handle('ai-engine:stop', () => stop())
    handle('ai-engine:get-config', () => getConfig())
    handle('ai-engine:download', (_e, modelName) => downloadModel(modelName))
    handle('ai-engine:download-cancel', () => downloadCancel())
    handle('ai-engine:set-model', (_e, name) => setModel(name))
    handle('ai-engine:open-models-dir', () => openModelsDir())
  }
  // downloadModel/downloadCancel 供 harness（纯 Node）直驱；渲染层仍走 IPC 通道
  // setModel 供 harness（纯 Node）直驱；渲染层仍走 IPC 通道
  return { start, stop, kill, snapshot, getConfig, downloadModel, downloadCancel, setModel }
}

module.exports = { initAiEngine }
