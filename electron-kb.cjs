// ============ 知识库（本地 RAG）主模块 ============
// 托管第二个 llama-server 实例（--embedding --pooling mean，CPU 优先）做本地嵌入，
// 索引 <userData>/knowledge/index/ 下按文件分片的向量库；检索供 AI 对话自动注入。
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
const DEFAULT_KB = {
  version: 1,
  modelPath: null,
  modelSize: null,
  modelMtimeMs: null,
  dim: null,
  enabled: true,
  topK: 5,
  chunkChars: 900,
  minScore: 0.3,
  injectCharBudget: 6000,
  sources: [],
  lastPort: null,
}

// ============ 路径 ============
function kbRoot() {
  const app = electron?.app
  if (app && typeof app.getPath === 'function') return path.join(app.getPath('userData'), 'knowledge')
  return path.join(os.homedir(), '.hypora-kb')
}
const kbJsonPath = () => path.join(kbRoot(), 'kb.json')
const indexDir = () => path.join(kbRoot(), 'index')

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

// ============ 配置 ============
function readKbJson() {
  try {
    const j = JSON.parse(fs.readFileSync(kbJsonPath(), 'utf-8')) || {}
    return { ...DEFAULT_KB, ...j }
  } catch { return { ...DEFAULT_KB } }
}
const clamp = (v, lo, hi, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt
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

// ============ 嵌入服务状态机 ============
// phase ∈ stopped | starting | running | stopping | failed
let phase = 'stopped'
let backend = null
let port = null
let pid = null
let startedAt = null
let error = null
let child = null
let startToken = 0
let startPromise = null    // ensureRunning 单飞

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
  const args = [
    '--host', '127.0.0.1', '--port', String(free),
    '--model', modelPath,
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
      log('INFO', `嵌入服务就绪: http://127.0.0.1:${free} (dim=${v.length})`)
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

// 维度落定：与已存 dim 不符 ⇒ 旧向量全部失效（清索引，等用户重建）
function onDimProbed(dim) {
  const cfg = readKbJson()
  if (cfg.dim && cfg.dim !== dim) {
    log('WARN', `向量维度变化 ${cfg.dim} → ${dim}，清空旧索引`)
    wipeIndex()
  }
  if (cfg.dim !== dim) writeKbJson({ dim })
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
  error = '启动失败（CPU 与 Vulkan 均不可用）：' + usable.map((b) => {
    const tail = tailLogs(b, 3).join(' / ') || '(无输出)'
    return `[${b}] ${attempts[b] || '未知原因'}；日志末尾: ${tail}`
  }).join('；')
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
      err.code = error && error.includes('模型') ? 'MODEL_MISSING' : 'START_FAILED'
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

// ============ 索引库 ============
// 可见性模型：published 集合 = 查询可见的分片快照；重建期间新分片写 <sha1>.staging.json，
// 完成时统一改名 + 原子换 published —— 查询在重建期间始终读到旧快照，无撕裂。
let published = new Set()   // 分片文件名集合（查询快照）
let shardCache = new Map()  // 文件名 → { meta, chunks: [{heading,text,offset,vec}] }
let metaCache = new Map()   // 文件名 → 轻量元数据（统计/增量判定用，避免整片解析）
let indexLoaded = false
let runToken = 0
let indexing = false
let indexProgress = { runId: 0, phase: 'idle', dir: null, file: null, done: 0, total: 0, chunks: 0, error: null }
let lastPushAt = 0
let lastAutoScan = 0

function loadPublished() {
  if (indexLoaded) return
  indexLoaded = true
  try { fs.mkdirSync(indexDir(), { recursive: true }) } catch { /* 忽略 */ }
  try {
    for (const n of fs.readdirSync(indexDir())) {
      if (n.endsWith('.json') && !n.endsWith('.staging.json')) published.add(n)
    }
  } catch { /* 忽略 */ }
}

function clearCaches(name) {
  shardCache.delete(name)
  metaCache.delete(name)
}

function wipeIndex() {
  published = new Set()
  shardCache = new Map()
  metaCache = new Map()
  try {
    for (const n of fs.readdirSync(indexDir())) {
      if (n.endsWith('.json')) { try { fs.unlinkSync(path.join(indexDir(), n)) } catch { /* 忽略 */ } }
    }
  } catch { /* 忽略 */ }
}

// 惰性加载分片（首次全量解析后缓存；含 base64 向量解码）
function loadShard(name) {
  if (shardCache.has(name)) return shardCache.get(name)
  const shard = lib.readShard(path.join(indexDir(), name))
  if (!shard) { clearCaches(name); published.delete(name); return null }
  const chunks = []
  for (const c of shard.chunks || []) {
    if (!c.vec) continue
    let vec
    try { vec = lib.decodeVec(c.vec) } catch { continue }
    chunks.push({ heading: c.heading || '', text: c.text || '', offset: c.offset || 0, vec })
  }
  const entry = {
    meta: { path: shard.path, dir: shard.dir, title: shard.title, dim: shard.dim, size: shard.size, mtimeMs: shard.mtimeMs, chunkCount: chunks.length },
    chunks,
  }
  shardCache.set(name, entry)
  metaCache.set(name, { ...entry.meta, modelSize: shard.modelSize, modelMtimeMs: shard.modelMtimeMs, truncated: !!shard.truncated, skipped: shard.skipped || null })
  return entry
}

// 轻量元数据（统计/增量判定用）：解析一次后缓存，不保留 chunks 解码向量
function shardMeta(name) {
  if (metaCache.has(name)) return metaCache.get(name)
  const shard = lib.readShard(path.join(indexDir(), name))
  if (!shard) { clearCaches(name); published.delete(name); return null }
  const meta = {
    path: shard.path, dir: shard.dir, title: shard.title, dim: shard.dim,
    size: shard.size, mtimeMs: shard.mtimeMs,
    modelSize: shard.modelSize, modelMtimeMs: shard.modelMtimeMs,
    truncated: !!shard.truncated, skipped: shard.skipped || null,
    chunkCount: Array.isArray(shard.chunks) ? shard.chunks.length : 0,
  }
  metaCache.set(name, meta)
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
function shardStale(meta, stat, cfg) {
  if (!meta) return true
  return lib.shouldReindex(
    { version: 1, size: meta.size, mtimeMs: meta.mtimeMs, modelSize: meta.modelSize, modelMtimeMs: meta.modelMtimeMs, dim: meta.dim, skipped: meta.skipped },
    { size: stat.size, mtimeMs: stat.mtimeMs },
    { size: cfg.modelSize, mtimeMs: cfg.modelMtimeMs, dim: cfg.dim }
  )
}

// 单文件索引：读取 → 归一 → 分块 → 嵌入 → 写 staging 分片。返回 staging 文件名（或 null）
async function indexFile(token, file, cfg, baseUrl) {
  const isGemma = /embeddinggemma/i.test(path.basename(cfg.modelPath || ''))
  const name = lib.shardName(file.path)
  let raw = null
  try { raw = fs.readFileSync(file.path) } catch {
    log('WARN', `读取失败跳过: ${file.path}`)
    return null
  }
  const norm = lib.normalizeText(raw)
  let shard
  if (!norm.text) {
    shard = { version: lib.SHARD_VERSION, path: file.path, dir: file.dir, size: file.size, mtimeMs: file.mtimeMs, title: path.basename(file.path, path.extname(file.path)), dim: null, modelPath: cfg.modelPath, modelSize: cfg.modelSize, modelMtimeMs: cfg.modelMtimeMs, truncated: false, skipped: norm.reason, chunks: [] }
  } else {
    const chunks = lib.chunkMarkdown(norm.text, { chunkChars: cfg.chunkChars, maxChunks: lib.DEFAULT_MAX_CHUNKS })
    const truncated = chunks.length >= lib.DEFAULT_MAX_CHUNKS
    const title = path.basename(file.path, path.extname(file.path))
    const docs = chunks.map((c) => lib.buildDocPrompt(title && c.heading ? `${title} ${c.heading}` : (title || c.heading), c.text, isGemma))
    const vecs = await embedTexts(baseUrl, docs)
    shard = {
      version: lib.SHARD_VERSION, path: file.path, dir: file.dir, size: file.size, mtimeMs: file.mtimeMs,
      title, dim: cfg.dim, modelPath: cfg.modelPath, modelSize: cfg.modelSize, modelMtimeMs: cfg.modelMtimeMs,
      truncated, skipped: null,
      chunks: chunks.map((c, i) => ({ heading: c.heading, text: c.text, offset: c.offset, vec: lib.encodeVec(vecs[i]) })),
    }
  }
  const staging = name.replace(/\.json$/, '.staging.json')
  try {
    fs.mkdirSync(indexDir(), { recursive: true })
    lib.writeShardAtomic(path.join(indexDir(), staging), shard)
  } catch (e) {
    log('ERROR', `写分片失败 ${staging}: ${e.message}`)
    return null
  }
  indexProgress = { ...indexProgress, chunks: indexProgress.chunks + shard.chunks.length }
  return staging
}

// 重建索引：staging 写入 → 完成时统一改名换 published → 清理多余分片
async function reindex(opts = {}) {
  const runId = ++runToken
  loadPublished()
  const cfg = readKbJson()
  const ms = modelStat()
  if (ms.missing) {
    indexProgress = { runId, phase: 'error', dir: opts.dir || null, file: null, done: 0, total: 0, chunks: 0, error: ms.reason }
    pushProgress(true)
    return { started: false, error: ms.reason }
  }
  // 清掉历史遗留 staging（含被取代的上一轮在途产物——runToken 已作废其回调）
  try {
    for (const n of fs.readdirSync(indexDir())) {
      if (n.endsWith('.staging.json')) { try { fs.unlinkSync(path.join(indexDir(), n)) } catch { /* 忽略 */ } }
    }
  } catch { /* 忽略 */ }

  const r = await ensureRunning(0)
  if (!r.ok) {
    indexProgress = { runId, phase: 'error', dir: opts.dir || null, file: null, done: 0, total: 0, chunks: 0, error: r.error }
    pushProgress(true)
    return { started: false, error: r.error }
  }

  indexing = true
  indexProgress = { runId, phase: 'scanning', dir: opts.dir || null, file: null, done: 0, total: 0, chunks: 0, error: null }
  pushProgress(true)
  log('INFO', `开始${opts.force ? '强制' : '增量'}索引${opts.dir ? `（${opts.dir}）` : ''}`)

  try {
    const dirs = opts.dir ? [opts.dir] : cfg.sources.map((s) => s.dir)
    const files = lib.scanSources(dirs)
    // 作用域重建：其余来源的文件也要保进 keep（不被 deleteShardsNotIn 误删）
    const others = opts.dir ? cfg.sources.map((s) => s.dir).filter((d) => d !== opts.dir) : []
    const otherFiles = others.length ? lib.scanSources(others) : []

    indexProgress = { ...indexProgress, phase: 'embedding', total: files.length, done: 0 }
    pushProgress(true)

    const stagingNames = new Set()
    const keepNames = new Set()
    for (const f of otherFiles) keepNames.add(lib.shardName(f.path))

    let done = 0
    for (const file of files) {
      if (runToken !== runId) { indexing = false; indexProgress = { ...indexProgress, phase: 'cancelled', file: null, error: null }; pushProgress(true); log('INFO', '索引已取消/被新任务取代'); return { started: true, cancelled: true } }
      const name = lib.shardName(file.path)
      const prevMeta = published.has(name) ? shardMeta(name) : null
      if (!opts.force && !shardStale(prevMeta, file, cfg)) {
        keepNames.add(name)
        done++
        indexProgress = { ...indexProgress, done }
        pushProgress()
        continue
      }
      if (file.oversized) {
        // 超大文件：直接写 skipped 分片（不读入内存）
        const shard = { version: lib.SHARD_VERSION, path: file.path, dir: file.dir, size: file.size, mtimeMs: file.mtimeMs, title: path.basename(file.path, path.extname(file.path)), dim: null, modelPath: cfg.modelPath, modelSize: cfg.modelSize, modelMtimeMs: cfg.modelMtimeMs, truncated: false, skipped: 'too-large', chunks: [] }
        const staging = name.replace(/\.json$/, '.staging.json')
        try { lib.writeShardAtomic(path.join(indexDir(), staging), shard); stagingNames.add(staging); keepNames.add(name) } catch { /* 忽略 */ }
        done++
        indexProgress = { ...indexProgress, done }
        pushProgress(true)
        continue
      }
      indexProgress = { ...indexProgress, file: file.path }
      pushProgress(true)
      const staging = await indexFile(runToken, file, cfg, r.baseUrl)
      if (staging) { stagingNames.add(staging); keepNames.add(name) }
      done++
      indexProgress = { ...indexProgress, done }
      pushProgress(true)
    }

    if (runToken !== runId) { indexing = false; indexProgress = { ...indexProgress, phase: 'cancelled', file: null, error: null }; pushProgress(true); return { started: true, cancelled: true } }

    // —— 发布快照：staging → 正式名原子改名，换 published，清理不再收录的分片 ——
    for (const staging of stagingNames) {
      const finalName = staging.replace(/\.staging\.json$/, '.json')
      try { fs.renameSync(path.join(indexDir(), staging), path.join(indexDir(), finalName)) } catch { /* 忽略 */ }
    }
    published = keepNames
    for (const name of Array.from(shardCache.keys())) if (!keepNames.has(name)) shardCache.delete(name)
    for (const name of Array.from(metaCache.keys())) if (!keepNames.has(name)) metaCache.delete(name)
    lib.deleteShardsNotIn(indexDir(), keepNames)

    indexing = false
    indexProgress = { ...indexProgress, phase: 'done', file: null, error: null }
    pushProgress(true)
    log('INFO', `索引完成：${done}/${files.length} 个文件，${indexProgress.chunks} 段`)
    return { started: true, done, total: files.length, chunks: indexProgress.chunks }
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

// ============ 查询 ============
async function query(text, topK) {
  loadPublished()
  const cfg = readKbJson()
  if (!text || !text.trim()) return { hits: [], tookMs: 0 }
  if (!published.size) return { hits: [], tookMs: 0 }
  const k = clamp(topK ?? cfg.topK, 1, 12, cfg.topK)
  const t0 = Date.now()
  const r = await ensureRunning(0)
  if (!r.ok) { const e = new Error(r.error); e.code = r.code; throw e }
  const isGemma = /embeddinggemma/i.test(path.basename(cfg.modelPath || ''))
  const qVec = (await embedTexts(r.baseUrl, [lib.buildQueryPrompt(text.slice(0, 1200), isGemma)]))[0]
  const entries = []
  for (const name of published) {
    const entry = loadShard(name)
    if (!entry || !entry.chunks.length) continue
    for (const c of entry.chunks) {
      entries.push({ vec: c.vec, path: entry.meta.path, title: entry.meta.title, dir: entry.meta.dir, heading: c.heading, text: c.text })
    }
  }
  const hits = lib.cosineTopK(qVec, entries, k, cfg.minScore)
  maybeAutoReindex()
  return { hits, tookMs: Date.now() - t0 }
}

// 后台增量：文件变动后下次查询顺手触发（不阻塞本次结果；30s 冷却防空转）
function maybeAutoReindex() {
  // 异步触发：绝不阻塞当前查询响应（首次扫描需 stat 全部文件）
  setTimeout(() => {
    try {
      if (indexing) return
      const cfg = readKbJson()
      if (!published.size || !cfg.sources.length) return
      if (Date.now() - lastAutoScan < AUTO_REINDEX_COOLDOWN_MS) return
      lastAutoScan = Date.now()
      const files = lib.scanSources(cfg.sources.map((s) => s.dir))
      let stale = 0
      for (const f of files) {
        const name = lib.shardName(f.path)
        const meta = published.has(name) ? shardMeta(name) : null
        if (shardStale(meta, f, cfg)) stale++
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
  loadPublished()
  const cfg = readKbJson()
  const ms = modelStat()
  const sources = []
  const totals = { files: 0, chunks: 0 }
  let staleTotal = 0
  try {
    const files = lib.scanSources(cfg.sources.map((s) => s.dir))
    for (const src of cfg.sources) {
      const list = files.filter((f) => f.dir === src.dir)
      let chunks = 0, indexed = 0, stale = 0, bytes = 0
      // 来源目录当前不可访问 = 失联（保留分片与记录，UI 徽章提示；不自动移除）
      const missing = list.length === 0 && !fs.existsSync(src.dir)
      for (const f of list) {
        const name = lib.shardName(f.path)
        const meta = published.has(name) ? shardMeta(name) : null
        bytes += f.size
        if (shardStale(meta, f, cfg)) { stale++; staleTotal++ }
        else { indexed++; chunks += meta.chunkCount || 0; totals.chunks += meta.chunkCount || 0 }
      }
      totals.files += list.length
      sources.push({ dir: src.dir, addedAt: src.addedAt, fileCount: list.length, chunkCount: chunks, indexedFiles: indexed, staleCount: stale, missing, bytes })
    }
  } catch { /* 扫描失败按空处理 */ }
  return {
    config: {
      modelPath: cfg.modelPath, enabled: cfg.enabled, topK: cfg.topK, chunkChars: cfg.chunkChars,
      minScore: cfg.minScore, injectCharBudget: cfg.injectCharBudget,
      sources: cfg.sources, dim: cfg.dim,
    },
    modelOk: !ms.missing,
    modelMissing: ms.missing,
    modelError: ms.missing ? ms.reason : null,
    modelSize: ms.size || null,
    binaries: { vulkan: fs.existsSync(exePathOf('vulkan')), cpu: fs.existsSync(exePathOf('cpu')) },
    indexDir: indexDir(),
    indexing,
    indexProgress,
    status: snapshot(),
    sources,
    totals,
    staleTotal,
  }
}

// ============ 配置与来源操作 ============
function setConfig(patch) {
  const clean = {}
  if (patch && typeof patch.enabled === 'boolean') clean.enabled = patch.enabled
  if (patch && patch.topK != null) clean.topK = clamp(patch.topK, 1, 12, DEFAULT_KB.topK)
  if (patch && patch.chunkChars != null) clean.chunkChars = clamp(patch.chunkChars, 300, 2000, DEFAULT_KB.chunkChars)
  if (patch && patch.minScore != null) clean.minScore = Math.min(1, Math.max(0, Number(patch.minScore) || 0))
  if (patch && patch.injectCharBudget != null) clean.injectCharBudget = clamp(patch.injectCharBudget, 1000, 12000, DEFAULT_KB.injectCharBudget)
  const next = writeKbJson(clean)
  if (clean.chunkChars != null) {
    // 分块粒度变了：旧向量分段不再对齐，全部重建
    wipeIndex()
    log('INFO', `分块粒度调整为 ${next.chunkChars}，已清空旧索引`)
  }
  return getConfig()
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

// 落定模型：持久化指纹 + 清空旧索引（换模型向量必失效）；运行中则自动重启
function setModel(absPath) {
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
  const changed = cfg.modelPath !== p
  writeKbJson({ modelPath: p, modelSize: st.size, modelMtimeMs: st.mtimeMs })
  if (changed) {
    wipeIndex()
    log('INFO', `检索模型已切换为 ${path.basename(p)}，旧索引已清空`)
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

// 目录来源：拒绝重复与嵌套（父目录已注册或包含已注册目录都会产生归属歧义）
async function addSource() {
  const dialog = electron?.dialog
  if (!dialog || typeof dialog.showOpenDialog !== 'function') throw new Error('当前环境不支持目录选择')
  const r = await dialog.showOpenDialog({ title: '添加知识库文件夹', properties: ['openDirectory'] })
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true }
  const dir = path.resolve(r.filePaths[0])
  const cfg = readKbJson()
  const caseFold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
  const d = caseFold(dir)
  for (const s of cfg.sources) {
    const e = caseFold(path.resolve(s.dir))
    if (e === d) return { canceled: false, error: '该文件夹已在知识库中' }
    if (d.startsWith(e + path.sep) || e.startsWith(d + path.sep)) {
      return { canceled: false, error: '与已有文件夹嵌套重叠，请选择其他目录' }
    }
  }
  writeKbJson({ sources: [...cfg.sources, { dir, addedAt: Date.now() }] })
  log('INFO', `添加知识库来源: ${dir}`)
  return { canceled: false, dir, config: getConfig() }
}

function removeSource(dir) {
  const target = dir ? path.resolve(String(dir)) : null
  if (!target) return { ok: false, error: '缺少目录参数' }
  const cfg = readKbJson()
  const caseFold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
  const rest = cfg.sources.filter((s) => caseFold(path.resolve(s.dir)) !== caseFold(target))
  if (rest.length === cfg.sources.length) return { ok: false, error: '未找到该来源' }
  writeKbJson({ sources: rest })
  // 收敛：把剩余来源之外的分片清掉
  try {
    const files = rest.length ? lib.scanSources(rest.map((s) => s.dir)) : []
    const keep = new Set(files.map((f) => lib.shardName(f.path)))
    published = keep
    for (const name of Array.from(shardCache.keys())) if (!keep.has(name)) shardCache.delete(name)
    for (const name of Array.from(metaCache.keys())) if (!keep.has(name)) metaCache.delete(name)
    lib.deleteShardsNotIn(indexDir(), keep)
  } catch { /* 忽略 */ }
  log('INFO', `移除知识库来源: ${target}`)
  return { ok: true, config: getConfig() }
}

function openIndexDir() {
  const dir = indexDir()
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
    handle('kb:pick-model', () => pickModel())
    handle('kb:set-model', (_e, p) => setModel(p))
    handle('kb:add-source', () => addSource())
    handle('kb:remove-source', (_e, dir) => removeSource(dir))
    handle('kb:reindex', (_e, opts) => { reindex(opts || {}).catch(() => {}); return { started: true } })
    handle('kb:cancel-index', () => ({ cancelled: cancelIndex() }))
    handle('kb:query', (_e, text, topK) => query(text, topK))
    handle('kb:open-index-dir', () => openIndexDir())
  }
  return {
    start, stop, kill, ensureRunning, snapshot, getConfig,
    reindex, cancelIndex, query, setModel, setConfig, addSourcePath: (dir) => {
      // harness 直驱：绕过原生对话框
      const cfg = readKbJson()
      writeKbJson({ sources: [...cfg.sources, { dir: path.resolve(dir), addedAt: Date.now() }] })
      return getConfig()
    },
    removeSource,
  }
}

module.exports = { initKnowledgeBase }
