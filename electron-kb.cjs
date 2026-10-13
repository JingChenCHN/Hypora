// ============ 知识库（本地 RAG）主模块 v2：多知识库 + 多模态 ============
// 托管第二个 llama-server 实例（--embedding --pooling mean，CPU 优先）做本地嵌入，
// 索引 <userData>/knowledge/index/<kbId>/ 下按文件分片的向量库；检索供 AI 对话自动注入。
// 模型全局共用（一个 GGUF 一个嵌入服务）；多库各自 sources/索引目录/开关，查询合并。
// 可选视觉投影器（mmproj）：配置后来源文件夹内图片一并嵌入（图文同空间），探针降级保文本。
// 结构镜像 electron-ai-engine.cjs：注入 logger、startToken 防僵尸迁移、handle() 错误兜底、
// taskkill 树杀。本模块只在 Electron 主进程加载；纯 Node 下 electron require 失败被吞，
// 导出函数仍可直接调用（KB_LIVE harness 用）。boot 不自动启动——首次查询/索引时按需拉起。

const path = require('path')
const fs = require('fs')
const os = require('os')
const net = require('net')
const http = require('http')
const crypto = require('crypto')
const { spawn } = require('child_process')

const lib = require('./electron-kb-lib.cjs')

// electron 惰性容错（同 electron-ai-engine.cjs）
let electron = null
try {
  const mod = require('electron')
  if (mod && typeof mod === 'object' && mod.app && mod.ipcMain) electron = mod
} catch { electron = null }

// ============ 常量 ============
const KB_VERSION = 2
const KB_MERGE_TOPK = 8              // 多库合并后的全局注入条数上限（各库先按自身 topK 截取）
const KB_PORT_CANDIDATES = [8910, 8911, 8912, 8913, 8914, 8915, 8916, 8917, 8918, 8919]
const HEALTH_TIMEOUT_MS = 45_000     // 300M Q8 模型冷启动数秒级；聊天路径另有 6s 上层预算
const HEALTH_POLL_MS = 400
const EMBED_BATCH = 8                // /v1/embeddings 单请求条数（约 2-3k token，安全越过 n_batch）
const EMBED_TIMEOUT_MS = 30_000
const PROGRESS_MS = 150              // 索引进度推送节流
const BACKENDS = ['cpu', 'vulkan']   // 嵌入 CPU 优先：避开与聊天模型争 GPU
const RING_LIMIT = 200
const STOP_EXIT_WAIT_MS = 3000
const AUTO_REINDEX_COOLDOWN_MS = 30_000

// 全局配置（模型 + 聊天注入总开关）；v1 的 enabled 语义 = 现在的 autoInject
const DEFAULT_GLOBAL = {
  version: KB_VERSION,
  modelPath: null,
  modelSize: null,
  modelMtimeMs: null,
  dim: null,
  mmprojPath: null,      // 视觉投影器（可选）：配置后索引来源文件夹内图片（多模态嵌入）
  mprojSize: null,       // mmproj 指纹（图片分片增量判定用，文本分片不校验）
  mprojMtimeMs: null,
  autoInject: true,
  autoStart: false,      // 应用启动时自动拉起嵌入服务（默认关，保持按需启动）
  injectCharBudget: 6000,
  lastPort: null,
}
// 单库默认（kb.json 的 kbs[] 元素）
const DEFAULT_KB_ITEM = {
  id: '',
  name: '',
  enabled: true,
  topK: 5,
  chunkChars: 900,
  minScore: 0.3,
  sources: [],
  createdAt: 0,
}

// ============ 路径 ============
function kbRoot() {
  const app = electron?.app
  if (app && typeof app.getPath === 'function') return path.join(app.getPath('userData'), 'knowledge')
  return path.join(os.homedir(), '.hypora-kb')
}
const kbJsonPath = () => path.join(kbRoot(), 'kb.json')
// 索引根（无 kbId）/ 单库索引目录（带 kbId）
const indexDir = (kbId) => (kbId ? path.join(kbRoot(), 'index', String(kbId)) : path.join(kbRoot(), 'index'))

// 二进制根：与聊天引擎共用一套 llama.cpp；KB 专属覆盖 → 引擎覆盖 → 常规解析
function binRoot() {
  if (process.env.HYPORA_KB_ENGINE_DIR) return process.env.HYPORA_KB_ENGINE_DIR
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
const exePathOf = (b) => path.join(binRoot(), b, exeName())

// ============ 日志 ============
let logger = null
const ringBuf = { cpu: [], vulkan: [] }
const pendingLine = { cpu: '', vulkan: '' }
const dateStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

function log(level, msg) {
  try { if (logger) logger(level, msg) } catch { /* 忽略 */ }
  const app = electron?.app
  if (!app || typeof app.getPath !== 'function') return
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, `kb-${dateStr()}.log`), `[${new Date().toISOString()}] [${level}] [knowledge] ${msg}\n`)
  } catch { /* 忽略写失败 */ }
}

function feedOutput(b, chunk) {
  let buf = (pendingLine[b] || '') + chunk.toString()
  const lines = buf.split(/\r?\n/)
  buf = lines.pop() || ''
  if (buf.length > 4000) { lines.push(buf.slice(0, 4000)); buf = '' }
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

// ============ 配置（kb.json v2 + v1 迁移） ============
const clamp = (v, lo, hi, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt
}
const newKbId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 4)

// 补齐/夹紧 v2 字段（kbs 元素逐个校正，坏数据不致命）
function fillConfig(raw) {
  const g = { ...DEFAULT_GLOBAL }
  for (const k of ['modelPath', 'modelSize', 'modelMtimeMs', 'dim', 'mmprojPath', 'mprojSize', 'mprojMtimeMs', 'lastPort']) {
    if (raw[k] != null) g[k] = raw[k]
  }
  if (typeof raw.autoInject === 'boolean') g.autoInject = raw.autoInject
  if (typeof raw.autoStart === 'boolean') g.autoStart = raw.autoStart
  if (raw.injectCharBudget != null) g.injectCharBudget = clamp(raw.injectCharBudget, 1000, 12000, DEFAULT_GLOBAL.injectCharBudget)
  const list = Array.isArray(raw.kbs) ? raw.kbs : []
  g.kbs = list.map((k, i) => ({
    ...DEFAULT_KB_ITEM,
    ...k,
    id: k.id || newKbId(),
    name: String(k.name || `知识库 ${i + 1}`),
    enabled: k.enabled !== false,
    topK: clamp(k.topK, 1, 12, DEFAULT_KB_ITEM.topK),
    chunkChars: clamp(k.chunkChars, 300, 2000, DEFAULT_KB_ITEM.chunkChars),
    minScore: Math.min(1, Math.max(0, Number(k.minScore) || 0)),
    sources: Array.isArray(k.sources) ? k.sources.filter((s) => s && s.dir) : [],
    createdAt: k.createdAt || Date.now(),
  }))
  return g
}

// v1 → v2：单库迁移为「默认知识库」，并把平铺分片搬进 index/<kbId>/（幂等：仅 version!==2 时进入）
function migrateConfig(raw) {
  const g = fillConfig({})
  for (const k of ['modelPath', 'modelSize', 'modelMtimeMs', 'dim', 'lastPort']) {
    if (raw[k] != null) g[k] = raw[k]
  }
  if (raw.injectCharBudget != null) g.injectCharBudget = clamp(raw.injectCharBudget, 1000, 12000, DEFAULT_GLOBAL.injectCharBudget)
  // v1 的 enabled 是「总开关」语义 → autoInject；新库各自 enabled 默认开
  g.autoInject = typeof raw.autoInject === 'boolean' ? raw.autoInject : raw.enabled !== false
  const kb = {
    ...DEFAULT_KB_ITEM,
    id: newKbId(),
    name: '默认知识库',
    topK: clamp(raw.topK, 1, 12, DEFAULT_KB_ITEM.topK),
    chunkChars: clamp(raw.chunkChars, 300, 2000, DEFAULT_KB_ITEM.chunkChars),
    minScore: Math.min(1, Math.max(0, Number(raw.minScore) || 0)),
    sources: Array.isArray(raw.sources) ? raw.sources.filter((s) => s && s.dir) : [],
    createdAt: Date.now(),
  }
  g.kbs = [kb]
  // v1 平铺分片搬迁（非 staging 的 *.json → index/<kbId>/）；失败不致命，残留文件不进 published
  let moved = 0
  try {
    const oldDir = indexDir()
    if (fs.existsSync(oldDir)) {
      const newDir = indexDir(kb.id)
      for (const n of fs.readdirSync(oldDir)) {
        if (!n.endsWith('.json') || n.endsWith('.staging.json')) continue
        const p = path.join(oldDir, n)
        try {
          if (!fs.statSync(p).isFile()) continue
          fs.mkdirSync(newDir, { recursive: true })
          fs.renameSync(p, path.join(newDir, n))
          moved++
        } catch { /* 单文件失败忽略 */ }
      }
    }
  } catch { /* 忽略 */ }
  try {
    fs.mkdirSync(kbRoot(), { recursive: true })
    fs.writeFileSync(kbJsonPath(), JSON.stringify(g, null, 2))
  } catch (e) { log('ERROR', `迁移写 kb.json 失败（内存 v2 兜底，下次启动重试）: ${e.message}`) }
  log('INFO', `kb.json v${raw.version || 1} → v2 迁移完成（「${kb.name}」${kb.sources.length} 个来源${moved ? `，搬迁 ${moved} 个分片` : ''}）`)
  return g
}

function readKbJson() {
  let raw = {}
  try { raw = JSON.parse(fs.readFileSync(kbJsonPath(), 'utf-8')) || {} } catch { raw = {} }
  if (raw.version === KB_VERSION) return fillConfig(raw)
  return migrateConfig(raw)
}

function writeKbJson(patch) {
  try {
    fs.mkdirSync(kbRoot(), { recursive: true })
    const next = { ...readKbJson(), ...patch }
    fs.writeFileSync(kbJsonPath(), JSON.stringify(next, null, 2))
    return next
  } catch (e) { log('ERROR', `写 kb.json 失败: ${e.message}`); return readKbJson() }
}

// 嵌入模型指纹：存在 + GGUF 魔数（size/mtime 用于分片增量判定）
function modelStat() {
  const cfg = readKbJson()
  if (!cfg.modelPath) return { missing: true, reason: '未配置检索模型' }
  try {
    const st = fs.statSync(cfg.modelPath)
    if (!st.isFile()) return { missing: true, reason: '模型文件不存在' }
    const head = Buffer.alloc(4)
    const fd = fs.openSync(cfg.modelPath, 'r')
    fs.readSync(fd, head, 0, 4, 0)
    fs.closeSync(fd)
    if (head.toString('latin1') !== 'GGUF') return { missing: true, reason: '不是有效的 GGUF 模型' }
    return { missing: false, size: st.size, mtimeMs: st.mtimeMs, path: cfg.modelPath }
  } catch {
    return { missing: true, reason: '模型文件不存在' }
  }
}

// 视觉投影器指纹：配置存在且为 GGUF 才生效；文件丢失视为未配置（payload 标 missing，不阻断文本）
function mprojStat() {
  const cfg = readKbJson()
  if (!cfg.mmprojPath) return { active: false, missing: false }
  try {
    const st = fs.statSync(cfg.mmprojPath)
    if (!st.isFile()) return { active: false, missing: true }
    const head = Buffer.alloc(4)
    const fd = fs.openSync(cfg.mmprojPath, 'r')
    fs.readSync(fd, head, 0, 4, 0)
    fs.closeSync(fd)
    if (head.toString('latin1') !== 'GGUF') return { active: false, missing: true }
    return { active: true, missing: false, path: cfg.mmprojPath, size: st.size }
  } catch {
    return { active: false, missing: true }
  }
}

// ============ 嵌入服务状态机 ============
// phase ∈ stopped | starting | running | stopping | failed（服务全局单例：一个模型供所有库共用）
let phase = 'stopped'
let backend = null
let port = null
let pid = null
let startedAt = null
let error = null
let child = null
let startToken = 0
let startPromise = null    // ensureRunning 单飞
let imageSupport = { ok: null, error: null }   // 图片嵌入探测结果：null=未探测/未配置

function snapshot() {
  return {
    phase, backend, port,
    baseUrl: phase === 'running' && port ? `http://127.0.0.1:${port}` : null,
    model: readKbJson().modelPath,
    pid, startedAt, error,
    modelMissing: modelStat().missing,
    dim: readKbJson().dim,
  }
}

function pushStatus() {
  const snap = snapshot()
  for (const win of electron?.BrowserWindow?.getAllWindows?.() || []) {
    try { win.webContents.send('kb-status', snap) } catch { /* 忽略 */ }
  }
}

// ============ 端口协商 ============
function canBind(p) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(p, '127.0.0.1')
  })
}
async function findFreePort() {
  const cfg = readKbJson()
  const list = cfg.lastPort ? [cfg.lastPort, ...KB_PORT_CANDIDATES] : [...KB_PORT_CANDIDATES]
  for (const p of [...new Set(list)]) if (await canBind(p)) return p
  return null
}

// ============ 健康轮询 ============
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

function waitExit(c, ms) {
  return new Promise((resolve) => {
    let over = false
    const fin = () => { if (!over) { over = true; resolve() } }
    c.once('exit', fin)
    setTimeout(fin, ms)
  })
}

// ============ HTTP JSON ============
function postJson(port_, urlPath, body, timeoutMs = EMBED_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body))
    const req = http.request({
      host: '127.0.0.1', port: port_, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8')
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`))
          return
        }
        try { resolve(JSON.parse(text)) } catch (e) { reject(new Error(`响应解析失败: ${e.message}`)) }
      })
    })
    req.on('timeout', () => { req.destroy(new Error('请求超时')) })
    req.on('error', reject)
    req.end(data)
  })
}

// 兼容 data[i].embedding 为数组或 base64 串（不同构建 encoding_format 默认不一）
function vecFromEntry(entry) {
  const raw = entry && entry.embedding
  if (Array.isArray(raw)) return new Float32Array(raw.map(Number))
  if (typeof raw === 'string' && raw.length) {
    const buf = Buffer.from(raw, 'base64')
    const n = buf.length >> 2
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4)
    return out
  }
  return null
}

// ============ 启动单后端 ============
async function runBackend(b, token, attempts, modelPath) {
  const free = await findFreePort()
  if (token !== startToken) return false
  if (!free) { attempts[b] = '候选端口全部被占用'; return false }
  const mps = mprojStat()
  const args = [
    '--host', '127.0.0.1', '--port', String(free),
    '--model', modelPath,
    ...(mps.active ? ['--mmproj', mps.path] : []),
    '--embedding', '--pooling', 'mean', '--ctx-size', '2048', '--no-webui',
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
  log('INFO', `启动嵌入服务 ${b} 后端 (pid=${c.pid}, port=${free})`)

  c.stdout.on('data', (chunk) => feedOutput(b, chunk))
  c.stderr.on('data', (chunk) => feedOutput(b, chunk))
  let timeoutTimer = null
  const exitP = new Promise((resolve) => c.once('exit', (code, signal) => resolve({ kind: 'exit', code, signal })))
  const errorP = new Promise((resolve) => c.once('error', (e) => resolve({ kind: 'error', message: e.message })))
  const timeoutP = new Promise((resolve) => { timeoutTimer = setTimeout(() => resolve({ kind: 'timeout' }), HEALTH_TIMEOUT_MS) })

  const outcome = await Promise.race([exitP, errorP, pollHealth(free, token), timeoutP])
  if (timeoutTimer) clearTimeout(timeoutTimer)
  if (token !== startToken) {
    try { c.kill() } catch { /* 忽略 */ }
    return false
  }
  if (outcome.kind === 'ready') {
    // 就绪后探测向量维度：不是嵌入模型（聊天模型误配）会在此暴露
    try {
      const r = await postJson(free, '/v1/embeddings', { input: ['hypora dim probe'] })
      const v = vecFromEntry(r && r.data && r.data[0])
      if (!v || !v.length) throw new Error('嵌入响应无向量数据')
      onDimProbed(v.length)
      phase = 'running'
      error = null
      writeKbJson({ lastPort: free })
      pushStatus()
      log('INFO', `嵌入服务就绪: http://127.0.0.1:${free} (dim=${v.length})${mps.active ? ' +mmproj' : ''}`)
      // 图片嵌入能力探测（异步不阻塞文本就绪；失败仅降级图片索引，文本链路不受影响）
      imageSupport = { ok: null, error: null }
      if (mps.active) {
        probeImageEmbedding(free).then((r) => {
          imageSupport = r
          pushStatus()
        }).catch(() => { imageSupport = { ok: false, error: '探测异常' } })
      }
      c.once('exit', () => {
        if (token !== startToken || phase !== 'running') return
        phase = 'stopped'
        error = null
        pid = null
        startedAt = null
        child = null
        pushStatus()
        log('INFO', '嵌入服务进程意外退出')
      })
      return true
    } catch (e) {
      attempts[b] = `嵌入探测失败：${e.message}（所选文件可能不是嵌入模型）`
      log('ERROR', `${b} 嵌入探测失败: ${e.message}`)
      try { c.kill() } catch { /* 忽略 */ }
      await waitExit(c, STOP_EXIT_WAIT_MS)
      if (token === startToken) child = null
      return false
    }
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

// 维度落定：与已存 dim 不符 ⇒ 旧向量全部失效（清所有库索引，等用户重建）
function onDimProbed(dim) {
  const cfg = readKbJson()
  if (cfg.dim && cfg.dim !== dim) {
    log('WARN', `向量维度变化 ${cfg.dim} → ${dim}，清空全部知识库索引`)
    wipeAllIndexes()
  }
  if (cfg.dim !== dim) writeKbJson({ dim })
}

// 1×1 透明 PNG：探测 /v1/embeddings 是否接受图片输入（格式/能力以服务端实际回答为准）
const PROBE_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
async function probeImageEmbedding(port_) {
  try {
    const r = await postJson(port_, '/v1/embeddings', imageEmbedBody(`data:image/png;base64,${PROBE_PNG_B64}`), 20_000)
    const v = vecFromEntry(r && r.data && r.data[0])
    if (!v || !v.length) throw new Error('嵌入响应无向量数据')
    log('INFO', `图片嵌入探测通过（dim=${v.length}）`)
    return { ok: true, error: null }
  } catch (e) {
    log('WARN', `图片嵌入探测失败：${e.message}（图片索引将跳过，文本不受影响）`)
    return { ok: false, error: e.message }
  }
}

// ============ start / stop / kill ============
async function start() {
  if (phase === 'starting' || phase === 'running') return snapshot()
  const ms = modelStat()
  if (ms.missing) {
    phase = 'stopped'
    error = ms.reason
    pushStatus()
    const err = new Error(ms.reason)
    err.code = 'MODEL_MISSING'
    throw err
  }
  const usable = BACKENDS.filter((b) => fs.existsSync(exePathOf(b)))
  if (!usable.length) {
    phase = 'failed'
    error = `引擎文件缺失（${exePathOf('cpu')}、${exePathOf('vulkan')} 均未找到）`
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
    const ok = await runBackend(b, token, attempts, ms.path)
    if (token !== startToken) return snapshot()
    if (ok) return snapshot()
    if (i < usable.length - 1) log('INFO', `${b} 不可用，回落 ${usable[i + 1]}`)
  }
  phase = 'failed'
  pid = null
  startedAt = null
  const detail = '启动失败（CPU 与 Vulkan 均不可用）：' + usable.map((b) => {
    const tail = tailLogs(b, 3).join(' / ') || '(无输出)'
    return `[${b}] ${attempts[b] || '未知原因'}；日志末尾: ${tail}`
  }).join('；')
  // llama.cpp 对不认识的 GGUF 架构统一报 "unknown model architecture"——给出可行动的提示。
  // 该行出现在加载早期，末三行截不到，必须扫整个 ring（上限 200 行）
  error = usable.some((b) => (ringBuf[b] || []).some((l) => /unknown model architecture/i.test(l)))
    ? '嵌入模型架构不被内置引擎支持（内置 llama.cpp 过旧，或该 GGUF 非官方转换）。请换用受支持的嵌入模型，或更新 Hypora 以获取新引擎。' + detail
    : detail
  pushStatus()
  log('ERROR', error)
  return snapshot()
}

// ensureRunning：单飞。waitMs>0 时限时等待（聊天路径 6s；索引/显式路径 0 = 不限时）
async function ensureRunning(waitMs = 0) {
  if (phase === 'running') return { ok: true, baseUrl: snapshot().baseUrl }
  if (phase === 'starting') {
    // 已有在途启动：搭车等待
    if (!startPromise) startPromise = start().finally(() => { startPromise = null })
  } else {
    startPromise = start().finally(() => { startPromise = null })
  }
  const mine = startPromise
  if (!waitMs) {
    try { await mine } catch { /* start 失败经 phase/error 体现，不向调用方抛异常 */ }
    return phase === 'running' ? { ok: true, baseUrl: snapshot().baseUrl } : { ok: false, error: error || '启动失败' }
  }
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (phase === 'running') return { ok: true, baseUrl: snapshot().baseUrl }
    if (phase === 'failed' || phase === 'stopped') {
      // failed = 两后端均败；stopped = MODEL_MISSING 或被停止
      const err = new Error(error || '嵌入服务未运行')
      // 仅真正的模型缺失/无效归 MODEL_MISSING（渲染层据此弹配置引导），其余启动失败一律 START_FAILED
      err.code = error && /未配置检索模型|模型文件不存在|不是有效的 GGUF/.test(error) ? 'MODEL_MISSING' : 'START_FAILED'
      return { ok: false, error: err.message, code: err.code }
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return { ok: false, error: '嵌入服务启动超时', code: 'START_TIMEOUT' }
}

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
  startToken++
  pushStatus()
  const c = child
  if (!c) { settleStopped(); return snapshot() }
  log('INFO', `停止嵌入服务 (pid=${c.pid})`)
  try { c.kill() } catch { /* 忽略 */ }
  if (process.platform === 'win32' && c.pid) {
    try { spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* 忽略 */ }
  }
  c.once('exit', settleStopped)
  setTimeout(settleStopped, STOP_EXIT_WAIT_MS)
  return snapshot()
}

function kill() {
  startToken++
  runToken++            // 索引在途一并作废
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
  imageSupport = { ok: null, error: null }
}

// ============ 嵌入调用 ============
async function embedTexts(baseUrl, texts) {
  const out = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH)
    const r = await postJson(new URL(baseUrl).port, '/v1/embeddings', { input: batch })
    const arr = (r && r.data) || []
    if (arr.length !== batch.length) throw new Error(`嵌入返回数量不符（${arr.length}/${batch.length}）`)
    for (const e of arr) {
      const v = vecFromEntry(e)
      if (!v || !v.length) throw new Error('嵌入响应无向量数据')
      out.push(lib.normalizeVec(v))
    }
  }
  return out
}

// ============ 图片嵌入（多模态） ============
// 请求格式单点收敛：OpenAI content-parts 约定（image_url data URL），外层按 llama.cpp
// /v1/embeddings 约定包 { content: [...] }（b11580 起 parts 必须置于 input 项的 content 字段）。
// 服务端不支持/格式不符 ⇒ 抛错（调用方按 skipped 处理，文本链路不受影响）；格式调整只改此函数。
function imageEmbedBody(url) {
  return { input: [{ content: [{ type: 'image_url', image_url: { url } }] }] }
}
async function embedImages(baseUrl, dataUrls) {
  const out = []
  for (const url of dataUrls) {
    const r = await postJson(new URL(baseUrl).port, '/v1/embeddings', imageEmbedBody(url), EMBED_TIMEOUT_MS * 2)   // 视觉塔首图含加载开销
    const v = vecFromEntry(r && r.data && r.data[0])
    if (!v || !v.length) throw new Error('图片嵌入响应无向量数据')
    out.push(lib.normalizeVec(v))
  }
  return out
}

// ============ 索引库（按 kbId 分桶） ============
// 可见性模型：每库 published 集合 = 查询可见的分片快照；重建期间新分片写 <sha1>.staging.json，
// 完成时统一改名 + 原子换 published —— 查询在重建期间始终读到旧快照，无撕裂。
const kbIndex = new Map()   // kbId → { published:Set, shardCache:Map, metaCache:Map, loaded:boolean }
function bucketOf(kbId) {
  let b = kbIndex.get(kbId)
  if (!b) {
    b = { published: new Set(), shardCache: new Map(), metaCache: new Map(), loaded: false }
    kbIndex.set(kbId, b)
  }
  return b
}
let runToken = 0
let indexing = false
let indexProgress = { runId: 0, phase: 'idle', kbId: null, kbName: null, dir: null, file: null, done: 0, total: 0, chunks: 0, error: null }
let lastPushAt = 0
let lastAutoScan = 0

function loadPublished(kbId) {
  const b = bucketOf(kbId)
  if (b.loaded) return b
  b.loaded = true
  const dir = indexDir(kbId)
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* 忽略 */ }
  try {
    for (const n of fs.readdirSync(dir)) {
      if (n.endsWith('.json') && !n.endsWith('.staging.json')) b.published.add(n)
    }
  } catch { /* 忽略 */ }
  return b
}

function clearCaches(kbId, name) {
  const b = bucketOf(kbId)
  b.shardCache.delete(name)
  b.metaCache.delete(name)
}

// 清空单库索引（内存桶 + 磁盘分片）
function wipeIndex(kbId) {
  const b = bucketOf(kbId)
  b.published = new Set()
  b.shardCache = new Map()
  b.metaCache = new Map()
  const dir = indexDir(kbId)
  try {
    for (const n of fs.readdirSync(dir)) {
      if (n.endsWith('.json')) { try { fs.unlinkSync(path.join(dir, n)) } catch { /* 忽略 */ } }
    }
  } catch { /* 忽略 */ }
}

// 清空全部库索引（换模型/维度变化 ⇒ 所有库向量失效）；顺带清 v1 平铺残留
function wipeAllIndexes() {
  const cfg = readKbJson()
  for (const k of cfg.kbs) wipeIndex(k.id)
  try {
    const root = indexDir()
    for (const n of fs.readdirSync(root)) {
      const p = path.join(root, n)
      try {
        if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true })
        else if (n.endsWith('.json')) fs.unlinkSync(p)
      } catch { /* 忽略 */ }
    }
  } catch { /* 忽略 */ }
}

// 惰性加载分片（首次全量解析后缓存；含 base64 向量解码）
function loadShard(kbId, name) {
  const b = bucketOf(kbId)
  if (b.shardCache.has(name)) return b.shardCache.get(name)
  const shard = lib.readShard(path.join(indexDir(kbId), name))
  if (!shard) { clearCaches(kbId, name); b.published.delete(name); return null }
  const chunks = []
  for (const c of shard.chunks || []) {
    if (!c.vec) continue
    let vec
    try { vec = lib.decodeVec(c.vec) } catch { continue }
    chunks.push({ heading: c.heading || '', text: c.text || '', offset: c.offset || 0, vec })
  }
  const entry = {
    meta: { path: shard.path, dir: shard.dir, title: shard.title, dim: shard.dim, size: shard.size, mtimeMs: shard.mtimeMs, kind: shard.kind || 'text', chunkCount: chunks.length },
    chunks,
  }
  b.shardCache.set(name, entry)
  b.metaCache.set(name, { ...entry.meta, modelSize: shard.modelSize, modelMtimeMs: shard.modelMtimeMs, mprojSize: shard.mprojSize, mprojMtimeMs: shard.mprojMtimeMs, truncated: !!shard.truncated, skipped: shard.skipped || null })
  return entry
}

// 轻量元数据（统计/增量判定用）：解析一次后缓存，不保留 chunks 解码向量
function shardMeta(kbId, name) {
  const b = bucketOf(kbId)
  if (b.metaCache.has(name)) return b.metaCache.get(name)
  const shard = lib.readShard(path.join(indexDir(kbId), name))
  if (!shard) { clearCaches(kbId, name); b.published.delete(name); return null }
  const meta = {
    path: shard.path, dir: shard.dir, title: shard.title, dim: shard.dim,
    size: shard.size, mtimeMs: shard.mtimeMs, kind: shard.kind || 'text',
    modelSize: shard.modelSize, modelMtimeMs: shard.modelMtimeMs,
    mprojSize: shard.mprojSize, mprojMtimeMs: shard.mprojMtimeMs,
    truncated: !!shard.truncated, skipped: shard.skipped || null,
    chunkCount: Array.isArray(shard.chunks) ? shard.chunks.length : 0,
  }
  b.metaCache.set(name, meta)
  return meta
}

function pushProgress(force = false) {
  const now = Date.now()
  if (!force && now - lastPushAt < PROGRESS_MS) return
  lastPushAt = now
  for (const win of electron?.BrowserWindow?.getAllWindows?.() || []) {
    try { win.webContents.send('kb-progress', indexProgress) } catch { /* 忽略 */ }
  }
}

// 分片增量判定：现分片指纹 vs 当前文件 stat + 模型指纹 + dim（复用 lib.shouldReindex 的规则）
// g = 全局配置（modelSize/modelMtimeMs/dim 为全局模型字段）
function shardStale(meta, stat, g) {
  if (!meta) return true
  return lib.shouldReindex(
    { version: 1, size: meta.size, mtimeMs: meta.mtimeMs, modelSize: meta.modelSize, modelMtimeMs: meta.modelMtimeMs, dim: meta.dim, skipped: meta.skipped, kind: meta.kind, mprojSize: meta.mprojSize, mprojMtimeMs: meta.mprojMtimeMs },
    { size: stat.size, mtimeMs: stat.mtimeMs },
    { size: g.modelSize, mtimeMs: g.modelMtimeMs, dim: g.dim, mprojSize: g.mprojSize, mprojMtimeMs: g.mprojMtimeMs }
  )
}

// 单文件索引：读取 → 归一 → 分块 → 嵌入 → 写 staging 分片。返回 staging 文件名（或 null）
// kb 提供分块粒度；g 提供模型指纹（含 mproj）。图片文件走多模态分支（一图一分片一向量）
async function indexFile(token, file, kb, g, baseUrl) {
  const isGemma = /embeddinggemma/i.test(path.basename(g.modelPath || ''))
  const name = lib.shardName(file.path)
  if (file.kind === 'image') {
    const title = path.basename(file.path, path.extname(file.path))
    let shard
    try {
      const raw = fs.readFileSync(file.path)
      const mime = /\.png$/i.test(file.path) ? 'image/png'
        : /\.jpe?g$/i.test(file.path) ? 'image/jpeg'
          : /\.webp$/i.test(file.path) ? 'image/webp'
            : /\.gif$/i.test(file.path) ? 'image/gif' : 'image/bmp'
      const vecs = await embedImages(baseUrl, [`data:${mime};base64,${raw.toString('base64')}`])
      shard = {
        version: lib.SHARD_VERSION, kind: 'image', path: file.path, dir: file.dir, size: file.size, mtimeMs: file.mtimeMs,
        title, dim: g.dim, modelPath: g.modelPath, modelSize: g.modelSize, modelMtimeMs: g.modelMtimeMs,
        mprojSize: g.mprojSize, mprojMtimeMs: g.mprojMtimeMs, truncated: false, skipped: null,
        chunks: [{ heading: '', text: `图片：${title}`, offset: 0, vec: lib.encodeVec(vecs[0]) }],
      }
    } catch (e) {
      log('WARN', `图片嵌入失败（按跳过落盘）: ${file.path} — ${e.message}`)
      shard = {
        version: lib.SHARD_VERSION, kind: 'image', path: file.path, dir: file.dir, size: file.size, mtimeMs: file.mtimeMs,
        title, dim: null, modelPath: g.modelPath, modelSize: g.modelSize, modelMtimeMs: g.modelMtimeMs,
        mprojSize: g.mprojSize, mprojMtimeMs: g.mprojMtimeMs, truncated: false, skipped: 'image-embed-failed', chunks: [],
      }
    }
    const staging = name.replace(/\.json$/, '.staging.json')
    try {
      fs.mkdirSync(indexDir(kb.id), { recursive: true })
      lib.writeShardAtomic(path.join(indexDir(kb.id), staging), shard)
    } catch (e) {
      log('ERROR', `写分片失败 ${staging}: ${e.message}`)
      return null
    }
    indexProgress = { ...indexProgress, chunks: indexProgress.chunks + shard.chunks.length }
    return staging
  }
  let raw = null
  try { raw = fs.readFileSync(file.path) } catch {
    log('WARN', `读取失败跳过: ${file.path}`)
    return null
  }
  const norm = lib.normalizeText(raw)
  let shard
  if (!norm.text) {
    shard = { version: lib.SHARD_VERSION, path: file.path, dir: file.dir, size: file.size, mtimeMs: file.mtimeMs, title: path.basename(file.path, path.extname(file.path)), dim: null, modelPath: g.modelPath, modelSize: g.modelSize, modelMtimeMs: g.modelMtimeMs, truncated: false, skipped: norm.reason, chunks: [] }
  } else {
    const chunks = lib.chunkMarkdown(norm.text, { chunkChars: kb.chunkChars, maxChunks: lib.DEFAULT_MAX_CHUNKS })
    const truncated = chunks.length >= lib.DEFAULT_MAX_CHUNKS
    const title = path.basename(file.path, path.extname(file.path))
    const docs = chunks.map((c) => lib.buildDocPrompt(title && c.heading ? `${title} ${c.heading}` : (title || c.heading), c.text, isGemma))
    const vecs = await embedTexts(baseUrl, docs)
    shard = {
      version: lib.SHARD_VERSION, path: file.path, dir: file.dir, size: file.size, mtimeMs: file.mtimeMs,
      title, dim: g.dim, modelPath: g.modelPath, modelSize: g.modelSize, modelMtimeMs: g.modelMtimeMs,
      truncated, skipped: null,
      chunks: chunks.map((c, i) => ({ heading: c.heading, text: c.text, offset: c.offset, vec: lib.encodeVec(vecs[i]) })),
    }
  }
  const staging = name.replace(/\.json$/, '.staging.json')
  try {
    fs.mkdirSync(indexDir(kb.id), { recursive: true })
    lib.writeShardAtomic(path.join(indexDir(kb.id), staging), shard)
  } catch (e) {
    log('ERROR', `写分片失败 ${staging}: ${e.message}`)
    return null
  }
  indexProgress = { ...indexProgress, chunks: indexProgress.chunks + shard.chunks.length }
  return staging
}

// 重建索引：opts.kbId 缺省 = 全部库；单库目录内 staging → 改名换 published → 清理多余分片
async function reindex(opts = {}) {
  const runId = ++runToken
  const cfg = readKbJson()
  const ms = modelStat()
  const failProgress = (msg) => {
    indexProgress = { runId, phase: 'error', kbId: opts.kbId || null, kbName: null, dir: null, file: null, done: 0, total: 0, chunks: 0, error: msg }
    pushProgress(true)
  }
  if (ms.missing) { failProgress(ms.reason); return { started: false, error: ms.reason } }
  const targets = opts.kbId ? cfg.kbs.filter((k) => k.id === opts.kbId) : cfg.kbs
  if (!targets.length) { failProgress('未找到该知识库'); return { started: false, error: '未找到该知识库' } }

  const r = await ensureRunning(0)
  if (!r.ok) { failProgress(r.error); return { started: false, error: r.error } }

  indexing = true
  indexProgress = { ...indexProgress, chunks: 0 }   // 本轮新增段数从零计
  log('INFO', `开始${opts.force ? '强制' : '增量'}索引${opts.kbId ? `（${targets[0].name}）` : `（${targets.length} 个知识库）`}`)

  let doneAll = 0
  let totalAll = 0
  try {
    for (const kb of targets) {
      if (runToken !== runId) {
        indexing = false
        indexProgress = { runId, phase: 'cancelled', kbId: null, kbName: null, dir: null, file: null, done: 0, total: 0, chunks: 0, error: null }
        pushProgress(true)
        log('INFO', '索引已取消/被新任务取代')
        return { started: true, cancelled: true }
      }
      const b = loadPublished(kb.id)
      const dir = indexDir(kb.id)
      try { fs.mkdirSync(dir, { recursive: true }) } catch { /* 忽略 */ }
      // 清本库历史 staging（含被取代的上一轮在途产物——runToken 已作废其回调）
      try {
        for (const n of fs.readdirSync(dir)) {
          if (n.endsWith('.staging.json')) { try { fs.unlinkSync(path.join(dir, n)) } catch { /* 忽略 */ } }
        }
      } catch { /* 忽略 */ }

      const dirs = kb.sources.map((s) => s.dir)
      const files = dirs.length ? lib.scanSources(dirs, { images: mprojStat().active }) : []
      indexProgress = { runId, phase: 'embedding', kbId: kb.id, kbName: kb.name, dir: null, file: null, done: 0, total: files.length, chunks: indexProgress.chunks, error: null }
      pushProgress(true)

      const stagingNames = new Set()
      const keepNames = new Set()
      let done = 0
      for (const file of files) {
        if (runToken !== runId) {
          indexing = false
          indexProgress = { runId, phase: 'cancelled', kbId: null, kbName: null, dir: null, file: null, done: 0, total: 0, chunks: 0, error: null }
          pushProgress(true)
          return { started: true, cancelled: true }
        }
        const name = lib.shardName(file.path)
        const prevMeta = b.published.has(name) ? shardMeta(kb.id, name) : null
        if (!opts.force && !shardStale(prevMeta, file, cfg)) {
          keepNames.add(name)
          done++
          doneAll++
          indexProgress = { ...indexProgress, done }
          pushProgress()
          continue
        }
        if (file.oversized) {
          // 超大文件：直接写 skipped 分片（不读入内存）
          const shard = { version: lib.SHARD_VERSION, path: file.path, dir: file.dir, size: file.size, mtimeMs: file.mtimeMs, title: path.basename(file.path, path.extname(file.path)), dim: null, modelPath: cfg.modelPath, modelSize: cfg.modelSize, modelMtimeMs: cfg.modelMtimeMs, truncated: false, skipped: 'too-large', chunks: [] }
          const staging = name.replace(/\.json$/, '.staging.json')
          try { lib.writeShardAtomic(path.join(dir, staging), shard); stagingNames.add(staging); keepNames.add(name) } catch { /* 忽略 */ }
          done++
          doneAll++
          indexProgress = { ...indexProgress, done }
          pushProgress(true)
          continue
        }
        indexProgress = { ...indexProgress, file: file.path }
        pushProgress(true)
        const staging = await indexFile(runToken, file, kb, cfg, r.baseUrl)
        if (staging) { stagingNames.add(staging); keepNames.add(name) }
        done++
        doneAll++
        indexProgress = { ...indexProgress, done }
        pushProgress(true)
      }

      if (runToken !== runId) {
        indexing = false
        indexProgress = { runId, phase: 'cancelled', kbId: null, kbName: null, dir: null, file: null, done: 0, total: 0, chunks: 0, error: null }
        pushProgress(true)
        return { started: true, cancelled: true }
      }

      // —— 发布本库快照：staging → 正式名原子改名，换 published，清理不再收录的分片 ——
      for (const staging of stagingNames) {
        const finalName = staging.replace(/\.staging\.json$/, '.json')
        try { fs.renameSync(path.join(dir, staging), path.join(dir, finalName)) } catch { /* 忽略 */ }
      }
      b.published = keepNames
      for (const name of Array.from(b.shardCache.keys())) if (!keepNames.has(name)) b.shardCache.delete(name)
      for (const name of Array.from(b.metaCache.keys())) if (!keepNames.has(name)) b.metaCache.delete(name)
      lib.deleteShardsNotIn(dir, keepNames)
      totalAll += files.length
    }

    indexing = false
    indexProgress = { runId, phase: 'done', kbId: null, kbName: null, dir: null, file: null, done: doneAll, total: totalAll, chunks: indexProgress.chunks, error: null }
    pushProgress(true)
    log('INFO', `索引完成：${doneAll}/${totalAll} 个文件，${indexProgress.chunks} 段`)
    return { started: true, done: doneAll, total: totalAll, chunks: indexProgress.chunks }
  } catch (e) {
    indexing = false
    indexProgress = { ...indexProgress, phase: 'error', error: e.message, file: null }
    pushProgress(true)
    log('ERROR', `索引失败: ${e.message}`)
    return { started: true, error: e.message }
  }
}

function cancelIndex() {
  if (!indexing) return false
  runToken++
  return true
}

// ============ 查询（多库合并） ============
// 每库按各自 topK/minScore 截取（防大库淹没小库）→ lib.mergeKbHits 全局排序取前 KB_MERGE_TOPK
async function query(text, topK) {
  const cfg = readKbJson()
  if (!text || !text.trim()) return { hits: [], tookMs: 0 }
  const active = cfg.kbs.filter((k) => k.enabled)
  let totalShards = 0
  for (const k of active) totalShards += loadPublished(k.id).published.size
  if (!totalShards) return { hits: [], tookMs: 0 }   // 空索引零开销短路（不触服务）
  const t0 = Date.now()
  const r = await ensureRunning(0)
  if (!r.ok) { const e = new Error(r.error); e.code = r.code; throw e }
  const isGemma = /embeddinggemma/i.test(path.basename(cfg.modelPath || ''))
  const qVec = (await embedTexts(r.baseUrl, [lib.buildQueryPrompt(text.slice(0, 1200), isGemma)]))[0]
  const perKb = []
  for (const k of active) {
    const b = loadPublished(k.id)
    if (!b.published.size) continue
    const entries = []
    for (const name of b.published) {
      const entry = loadShard(k.id, name)
      if (!entry || !entry.chunks.length) continue
      for (const c of entry.chunks) {
        entries.push({ vec: c.vec, path: entry.meta.path, title: entry.meta.title, dir: entry.meta.dir, heading: c.heading, text: c.text, kind: entry.meta.kind || 'text' })
      }
    }
    if (!entries.length) continue
    perKb.push({ hits: lib.cosineTopK(qVec, entries, clamp(k.topK, 1, 12, 5), k.minScore) })
  }
  const hits = lib.mergeKbHits(perKb, KB_MERGE_TOPK)
  maybeAutoReindex()
  return { hits, tookMs: Date.now() - t0 }
}

// 后台增量：文件变动后下次查询顺手触发（不阻塞本次结果；30s 冷却防空转）。
// 扫全部库的来源（不管 enabled——停用只是不参与检索，索引保持新鲜）
function maybeAutoReindex() {
  // 异步触发：绝不阻塞当前查询响应（首次扫描需 stat 全部文件）
  setTimeout(() => {
    try {
      if (indexing) return
      const cfg = readKbJson()
      if (Date.now() - lastAutoScan < AUTO_REINDEX_COOLDOWN_MS) return
      // 只在已有分片的库存在时做增量（全新未索引的库由 addSource 主动触发）
      let anyShards = false
      for (const k of cfg.kbs) if (loadPublished(k.id).published.size) { anyShards = true; break }
      if (!anyShards) return
      lastAutoScan = Date.now()
      let stale = 0
      for (const k of cfg.kbs) {
        const dirs = k.sources.map((s) => s.dir)
        if (!dirs.length) continue
        const files = lib.scanSources(dirs)
        const b = loadPublished(k.id)
        for (const f of files) {
          const name = lib.shardName(f.path)
          const meta = b.published.has(name) ? shardMeta(k.id, name) : null
          if (shardStale(meta, f, cfg)) stale++
        }
      }
      if (stale > 0) {
        log('INFO', `检测到 ${stale} 个文件有变动，后台增量索引`)
        reindex({}).catch(() => {})
      }
    } catch { /* 忽略 */ }
  }, 0)
}

// ============ 配置查询 ============
function getConfig() {
  const cfg = readKbJson()
  const ms = modelStat()
  const mps = mprojStat()
  const model = {
    ok: !ms.missing, missing: ms.missing, error: ms.missing ? ms.reason : null, path: cfg.modelPath, size: ms.size || null, dim: cfg.dim,
    mmproj: {
      configured: !!cfg.mmprojPath,
      active: mps.active,
      missing: !mps.active && !!cfg.mmprojPath,
      path: mps.active ? mps.path : (cfg.mmprojPath || null),
      size: mps.active ? mps.size : null,
      imageOk: mps.active ? imageSupport.ok : null,        // null=探测中/未探测
      imageError: mps.active && imageSupport.ok === false ? imageSupport.error : null,
    },
  }
  const kbs = []
  const totals = { files: 0, chunks: 0, images: 0 }
  let staleTotal = 0
  for (const kb of cfg.kbs) {
    const b = loadPublished(kb.id)
    const sources = []
    const stats = { files: 0, chunks: 0, stale: 0, images: 0 }
    try {
      const dirs = kb.sources.map((s) => s.dir)
      const files = dirs.length ? lib.scanSources(dirs, { images: mprojStat().active }) : []
      for (const src of kb.sources) {
        const list = files.filter((f) => f.dir === src.dir)
        let chunks = 0, indexed = 0, stale = 0, bytes = 0, images = 0
        // 来源目录当前不可访问 = 失联（保留分片与记录，UI 徽章提示；不自动移除）
        const missing = list.length === 0 && !fs.existsSync(src.dir)
        for (const f of list) {
          const name = lib.shardName(f.path)
          const meta = b.published.has(name) ? shardMeta(kb.id, name) : null
          bytes += f.size
          if (f.kind === 'image') images++
          if (shardStale(meta, f, cfg)) { stale++; stats.stale++; staleTotal++ }
          else { indexed++; chunks += meta.chunkCount || 0; stats.chunks += meta.chunkCount || 0; totals.chunks += meta.chunkCount || 0 }
        }
        stats.files += list.length
        stats.images += images
        totals.files += list.length
        totals.images += images
        sources.push({ dir: src.dir, addedAt: src.addedAt, fileCount: list.length, imageCount: images, chunkCount: chunks, indexedFiles: indexed, staleCount: stale, missing, bytes })
      }
    } catch { /* 扫描失败按空处理 */ }
    kbs.push({
      id: kb.id, name: kb.name, enabled: kb.enabled !== false,
      topK: kb.topK, chunkChars: kb.chunkChars, minScore: kb.minScore, createdAt: kb.createdAt,
      sources, stats,
    })
  }
  return {
    model,
    binaries: { vulkan: fs.existsSync(exePathOf('vulkan')), cpu: fs.existsSync(exePathOf('cpu')) },
    autoInject: cfg.autoInject !== false,
    autoStart: cfg.autoStart === true,
    injectCharBudget: cfg.injectCharBudget,
    indexDir: indexDir(),
    indexing,
    indexProgress,
    status: snapshot(),
    kbs,
    totals,
    staleTotal,
  }
}

// ============ 全局配置 ============
function setConfig(patch) {
  const clean = {}
  if (patch && typeof patch.autoInject === 'boolean') clean.autoInject = patch.autoInject
  if (patch && typeof patch.autoStart === 'boolean') clean.autoStart = patch.autoStart
  if (patch && patch.injectCharBudget != null) clean.injectCharBudget = clamp(patch.injectCharBudget, 1000, 12000, DEFAULT_GLOBAL.injectCharBudget)
  writeKbJson(clean)
  return getConfig()
}

// ============ 知识库 CRUD ============
function createKb(name) {
  const cfg = readKbJson()
  const n = String(name == null ? '' : name).trim()
  const kb = {
    ...DEFAULT_KB_ITEM,
    id: newKbId(),
    name: n || `知识库 ${cfg.kbs.length + 1}`,
    createdAt: Date.now(),
  }
  writeKbJson({ kbs: [...cfg.kbs, kb] })
  log('INFO', `创建知识库「${kb.name}」(${kb.id})`)
  return { ok: true, config: getConfig() }
}

function renameKb(kbId, name) {
  const cfg = readKbJson()
  const kb = cfg.kbs.find((k) => k.id === kbId)
  if (!kb) return { ok: false, error: '未找到该知识库' }
  const n = String(name == null ? '' : name).trim()
  if (!n) return { ok: false, error: '名称不能为空' }
  writeKbJson({ kbs: cfg.kbs.map((k) => (k.id === kbId ? { ...k, name: n } : k)) })
  return { ok: true, config: getConfig() }
}

function deleteKb(kbId) {
  if (indexing) return { ok: false, error: '索引进行中，请稍后再试' }
  const cfg = readKbJson()
  const kb = cfg.kbs.find((k) => k.id === kbId)
  if (!kb) return { ok: false, error: '未找到该知识库' }
  writeKbJson({ kbs: cfg.kbs.filter((k) => k.id !== kbId) })
  kbIndex.delete(kbId)
  try { fs.rmSync(indexDir(kbId), { recursive: true, force: true }) } catch { /* 忽略 */ }
  log('INFO', `删除知识库「${kb.name}」(${kbId})，索引已清除`)
  return { ok: true, config: getConfig() }
}

function setKbConfig(kbId, patch) {
  const cfg = readKbJson()
  const kb = cfg.kbs.find((k) => k.id === kbId)
  if (!kb) return { ok: false, error: '未找到该知识库' }
  const next = { ...kb }
  if (patch && typeof patch.enabled === 'boolean') next.enabled = patch.enabled
  if (patch && patch.topK != null) next.topK = clamp(patch.topK, 1, 12, DEFAULT_KB_ITEM.topK)
  if (patch && patch.minScore != null) next.minScore = Math.min(1, Math.max(0, Number(patch.minScore) || 0))
  let chunkChanged = false
  if (patch && patch.chunkChars != null) {
    const v = clamp(patch.chunkChars, 300, 2000, DEFAULT_KB_ITEM.chunkChars)
    chunkChanged = v !== kb.chunkChars
    next.chunkChars = v
  }
  writeKbJson({ kbs: cfg.kbs.map((k) => (k.id === kbId ? next : k)) })
  if (chunkChanged) {
    // 分块粒度变了：该库旧向量分段不再对齐，仅清该库
    wipeIndex(kbId)
    log('INFO', `「${next.name}」分块粒度调整为 ${next.chunkChars}，已清空该库索引`)
  }
  return { ok: true, config: getConfig() }
}

// gguf 文件选择（原生对话框）：只校验不持久化，落定走 set-model
async function pickModel() {
  const dialog = electron?.dialog
  if (!dialog || typeof dialog.showOpenDialog !== 'function') throw new Error('当前环境不支持文件选择')
  const r = await dialog.showOpenDialog({
    title: '选择嵌入模型（GGUF）',
    filters: [{ name: 'GGUF 模型', extensions: ['gguf'] }],
    properties: ['openFile'],
  })
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true }
  const p = path.resolve(r.filePaths[0])
  try {
    const st = fs.statSync(p)
    if (!st.isFile()) return { canceled: false, error: '不是有效的文件' }
    const head = Buffer.alloc(4)
    const fd = fs.openSync(p, 'r')
    fs.readSync(fd, head, 0, 4, 0)
    fs.closeSync(fd)
    if (head.toString('latin1') !== 'GGUF') return { canceled: false, error: '不是有效的 GGUF 模型文件' }
    return { canceled: false, path: p, name: path.basename(p), size: st.size }
  } catch (e) {
    return { canceled: false, error: e.message }
  }
}

// 落定模型：持久化指纹 + 清空全部库旧索引（换模型向量必失效）；运行中则自动重启
function setModel(absPath) {
  if (indexing) return { ok: false, error: '索引进行中，请稍后再试' }
  const p = absPath ? path.resolve(String(absPath)) : null
  if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) return { ok: false, error: '模型文件不存在' }
  try {
    const head = Buffer.alloc(4)
    const fd = fs.openSync(p, 'r')
    fs.readSync(fd, head, 0, 4, 0)
    fs.closeSync(fd)
    if (head.toString('latin1') !== 'GGUF') return { ok: false, error: '不是有效的 GGUF 模型文件' }
  } catch (e) { return { ok: false, error: e.message } }
  const st = fs.statSync(p)
  const cfg = readKbJson()
  // 以指纹（size+mtime）判定是否换模型：同指纹＝同一模型，挪位置（如移入 ai-models/）不清索引；
  // 指纹变化＝换了模型文件（含原路径覆盖新版本），向量必失效，必清全部库索引
  const sameModel = cfg.modelSize != null && cfg.modelMtimeMs != null && cfg.modelSize === st.size && cfg.modelMtimeMs === st.mtimeMs
  const changed = !sameModel
  writeKbJson({ modelPath: p, modelSize: st.size, modelMtimeMs: st.mtimeMs })
  if (changed) {
    wipeAllIndexes()
    log('INFO', `检索模型已切换为 ${path.basename(p)}，全部知识库旧索引已清空`)
    if (phase === 'running' || phase === 'starting') {
      stop()
      const t = setInterval(() => {
        if (phase === 'stopping') return
        clearInterval(t)
        start().catch(() => {})
      }, 120)
    }
  } else if (cfg.modelPath !== p) {
    log('INFO', `检索模型已指向 ${p}（指纹未变，各库索引保留）`)
  }
  return { ok: true, config: getConfig() }
}

// 视觉投影器（可选，多模态）：落定指纹 + 服务重启；不清任何索引——图片分片靠 mproj
// 指纹自动判 stale，文本分片不受影响；清除后图片分片由重建时的 deleteShardsNotIn 收敛
function setMmproj(absPath) {
  if (indexing) return { ok: false, error: '索引进行中，请稍后再试' }
  const p = absPath ? path.resolve(String(absPath)) : null
  if (p != null) {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return { ok: false, error: '视觉投影器文件不存在' }
    try {
      const head = Buffer.alloc(4)
      const fd = fs.openSync(p, 'r')
      fs.readSync(fd, head, 0, 4, 0)
      fs.closeSync(fd)
      if (head.toString('latin1') !== 'GGUF') return { ok: false, error: '不是有效的 GGUF 模型文件' }
    } catch (e) { return { ok: false, error: e.message } }
  }
  const st = p ? fs.statSync(p) : null
  const cfg = readKbJson()
  const changed = (cfg.mmprojPath || null) !== p
  writeKbJson(p ? { mmprojPath: p, mprojSize: st.size, mprojMtimeMs: st.mtimeMs } : { mmprojPath: null, mprojSize: null, mprojMtimeMs: null })
  if (changed) {
    log('INFO', p ? `视觉投影器已设置: ${p}（图片分片将按指纹自动重建，文本分片保留）` : '视觉投影器已清除（图片分片将在下次重建时移除）')
    if (phase === 'running' || phase === 'starting') {
      stop()
      const t = setInterval(() => {
        if (phase === 'stopping') return
        clearInterval(t)
        start().catch(() => {})
      }, 120)
    }
  }
  return { ok: true, config: getConfig() }
}

// mmproj 文件选择（原生对话框）：只校验不持久化，落定走 set-mmproj
async function pickMmproj() {
  const dialog = electron?.dialog
  if (!dialog || typeof dialog.showOpenDialog !== 'function') throw new Error('当前环境不支持文件选择')
  const r = await dialog.showOpenDialog({
    title: '选择视觉投影器（mmproj GGUF，可选）',
    filters: [{ name: 'GGUF 模型', extensions: ['gguf'] }],
    properties: ['openFile'],
  })
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true }
  const p = path.resolve(r.filePaths[0])
  try {
    const st = fs.statSync(p)
    if (!st.isFile()) return { canceled: false, error: '不是有效的文件' }
    const head = Buffer.alloc(4)
    const fd = fs.openSync(p, 'r')
    fs.readSync(fd, head, 0, 4, 0)
    fs.closeSync(fd)
    if (head.toString('latin1') !== 'GGUF') return { canceled: false, error: '不是有效的 GGUF 模型文件' }
    return { canceled: false, path: p, name: path.basename(p), size: st.size }
  } catch (e) {
    return { canceled: false, error: e.message }
  }
}

// 目录来源（单库作用域）：库内拒绝重复与嵌套；跨库允许收录同一目录（分片按库隔离）
async function addSource(kbId) {
  const dialog = electron?.dialog
  if (!dialog || typeof dialog.showOpenDialog !== 'function') throw new Error('当前环境不支持目录选择')
  const cfg = readKbJson()
  const kb = cfg.kbs.find((k) => k.id === kbId)
  if (!kb) return { canceled: false, error: '未找到该知识库' }
  const r = await dialog.showOpenDialog({ title: `添加文件夹到「${kb.name}」`, properties: ['openDirectory'] })
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true }
  const dir = path.resolve(r.filePaths[0])
  const err = validateSource(kb, dir)
  if (err) return { canceled: false, error: err }
  writeKbJson({ kbs: cfg.kbs.map((k) => (k.id === kbId ? { ...k, sources: [...k.sources, { dir, addedAt: Date.now() }] } : k)) })
  log('INFO', `「${kb.name}」添加来源: ${dir}`)
  return { canceled: false, dir, config: getConfig() }
}

// 来源合法性（库内重复/嵌套会产生归属歧义）；返回错误文案或 null
function validateSource(kb, dir) {
  const caseFold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
  const d = caseFold(dir)
  for (const s of kb.sources) {
    const e = caseFold(path.resolve(s.dir))
    if (e === d) return '该文件夹已在此知识库中'
    if (d.startsWith(e + path.sep) || e.startsWith(d + path.sep)) {
      return '与已有文件夹嵌套重叠，请选择其他目录'
    }
  }
  return null
}

function removeSource(kbId, dir) {
  if (indexing) return { ok: false, error: '索引进行中，请稍后再试' }
  const target = dir ? path.resolve(String(dir)) : null
  if (!target) return { ok: false, error: '缺少目录参数' }
  const cfg = readKbJson()
  const kb = cfg.kbs.find((k) => k.id === kbId)
  if (!kb) return { ok: false, error: '未找到该知识库' }
  const caseFold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
  const rest = kb.sources.filter((s) => caseFold(path.resolve(s.dir)) !== caseFold(target))
  if (rest.length === kb.sources.length) return { ok: false, error: '未找到该来源' }
  writeKbJson({ kbs: cfg.kbs.map((k) => (k.id === kbId ? { ...k, sources: rest } : k)) })
  // 收敛：把该库剩余来源之外的分片清掉
  try {
    const b = loadPublished(kbId)
    const files = rest.length ? lib.scanSources(rest.map((s) => s.dir), { images: mprojStat().active }) : []
    const keep = new Set(files.map((f) => lib.shardName(f.path)))
    b.published = keep
    for (const name of Array.from(b.shardCache.keys())) if (!keep.has(name)) b.shardCache.delete(name)
    for (const name of Array.from(b.metaCache.keys())) if (!keep.has(name)) b.metaCache.delete(name)
    lib.deleteShardsNotIn(indexDir(kbId), keep)
  } catch { /* 忽略 */ }
  log('INFO', `「${kb.name}」移除来源: ${target}`)
  return { ok: true, config: getConfig() }
}

function openIndexDir(kbId) {
  const dir = kbId ? indexDir(kbId) : indexDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const shell = electron?.shell
  if (!shell || typeof shell.openPath !== 'function') throw new Error('当前环境不支持打开目录')
  return shell.openPath(dir)
}

// ============ IPC 注册 ============
let registered = false
function initKnowledgeBase(loggerFn) {
  logger = typeof loggerFn === 'function' ? loggerFn : null
  const ipc = electron?.ipcMain
  if (ipc && !registered) {
    registered = true
    const handle = (channel, fn) => ipc.handle(channel, async (...args) => {
      try { return await fn(...args) } catch (e) {
        log('ERROR', `${channel} 失败: ${e.message}`)
        return { error: e.message }
      }
    })
    handle('kb:get-config', () => getConfig())
    handle('kb:set-config', (_e, patch) => setConfig(patch))
    handle('kb:create', (_e, name) => createKb(name))
    handle('kb:rename', (_e, kbId, name) => renameKb(kbId, name))
    handle('kb:delete', (_e, kbId) => deleteKb(kbId))
    handle('kb:set-kb', (_e, kbId, patch) => setKbConfig(kbId, patch))
    handle('kb:pick-model', () => pickModel())
    handle('kb:set-model', (_e, p) => setModel(p))
    handle('kb:pick-mmproj', () => pickMmproj())
    handle('kb:set-mmproj', (_e, p) => setMmproj(p))
    // 手动启停嵌入服务（start 幂等；模型缺失 → MODEL_MISSING 走 error，不抛给渲染层）
    handle('kb:start-service', async () => {
      try { await start(); return { ok: true } } catch (e) { return { ok: false, error: e.message } }
    })
    handle('kb:stop-service', () => { stop(); return { ok: true } })
    handle('kb:add-source', (_e, kbId) => addSource(kbId))
    handle('kb:remove-source', (_e, kbId, dir) => removeSource(kbId, dir))
    handle('kb:reindex', (_e, opts) => { reindex(opts || {}).catch(() => {}); return { started: true } })
    handle('kb:cancel-index', () => ({ cancelled: cancelIndex() }))
    handle('kb:query', (_e, text, topK) => query(text, topK))
    handle('kb:open-index-dir', (_e, kbId) => openIndexDir(kbId))
  }
  return {
    start, stop, kill, ensureRunning, snapshot, getConfig,
    reindex, cancelIndex, query, setModel, setMmproj, mprojStat, setConfig,
    createKb, renameKb, deleteKb, setKbConfig,
    addSourcePath: (kbId, dir) => {
      // harness 直驱：绕过原生对话框（与 addSource 同一套校验）
      const cfg = readKbJson()
      const kb = cfg.kbs.find((k) => k.id === kbId)
      if (!kb) return { ok: false, error: '未找到该知识库', config: getConfig() }
      const d = path.resolve(dir)
      const err = validateSource(kb, d)
      if (err) return { ok: false, error: err, config: getConfig() }
      writeKbJson({ kbs: cfg.kbs.map((k) => (k.id === kbId ? { ...k, sources: [...k.sources, { dir: d, addedAt: Date.now() }] } : k)) })
      return { ok: true, config: getConfig() }
    },
    removeSource,
  }
}

module.exports = { initKnowledgeBase }
