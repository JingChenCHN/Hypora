// Hypora Web 版静态服务器 + AI 同源代理 + 登录认证 (零依赖, node server.cjs [端口], 默认 8080)
//
// 1) 静态托管 dist/ 产物。
// 2) /api/ai* 同源代理:浏览器把访客自己的 API Key 放 Authorization 头发给同源 /api/ 端点,
//    本代理在白名单校验后,把该头原样转发给目标 LLM(DeepSeek / GLM / 本地 llama-server),
//    并把 SSE 流原样回传前端。保持开放(桌面版无登录态,上游 Key 由访客自带)。
// 3) /api/auth* /api/admin* /api/chats:授权账户体系(整站门禁 + 按用户聊天记录)。
//    - 会话:HMAC-SHA256 无状态 Cookie(hypora_session),校验 users.json 里的 tokenVersion,
//      重置密码/删除用户即踢掉该用户全部会话。
//    - 密码:scrypt + 每用户随机盐,只存哈希;管理员生成的默认长密码明文只在创建/重置响应出现一次。
//    - 数据目录:WEB 根的兄弟目录 `${根名}-data`(不在 nginx 静态根内),需预先 chown 给运行用户。
// 4) /api/cloud*:云端文档按用户隔离(DATA_ROOT/cloud/<用户名>/),需登录;
//    历史存量(旧共享池 `${根名}-cloud`)已全量迁入 admin 名下。
//
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

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

// ===== 认证与用户数据 =====
const DATA_ROOT = path.resolve(path.dirname(ROOT), path.basename(ROOT) + '-data')
const USERS_FILE = path.join(DATA_ROOT, 'users.json')
const SECRET_FILE = path.join(DATA_ROOT, 'secret.key')
const CHATS_DIR = path.join(DATA_ROOT, 'chats')
const BOOTSTRAP_FILE = path.join(DATA_ROOT, 'admin-initial-password.txt')
const SESSION_COOKIE = 'hypora_session'
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000
const CHAT_MAX_BYTES = 2 * 1024 * 1024
const USERNAME_RE = /^[A-Za-z0-9_]{2,32}$/
const ADMIN_USER = process.env.HYPERA_ADMIN_USER || 'admin'

let dataOk = false
let serverSecret = ''

function jsonErr(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: msg }))
}

function jsonOk(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

// 数据目录:pm2 运行用户必须对其有写权限。失败时响亮报错并继续服务静态 + /api/ai,
// auth/admin/chats/cloud 返回 500,避免把整站锁死在登录页且不留线索。
function ensureDataRoot() {
  try {
    fs.mkdirSync(DATA_ROOT, { recursive: true })
    fs.mkdirSync(CHATS_DIR, { recursive: true })
    fs.chmodSync(DATA_ROOT, 0o700)
    fs.chmodSync(CHATS_DIR, 0o700)
    dataOk = true
  } catch (e) {
    dataOk = false
    console.error('[hypora-auth] 数据目录不可用:', e.message)
    console.error('[hypora-auth] 请在服务器上执行:')
    console.error(`  sudo mkdir -p ${DATA_ROOT}/chats`)
    console.error(`  sudo chown -R $(whoami) ${DATA_ROOT}`)
    console.error(`  sudo chmod 700 ${DATA_ROOT} ${DATA_ROOT}/chats`)
    console.error('[hypora-auth] 然后重启本进程 (pm2 restart hypora-web-proxy)')
  }
}

// 原子写:同目录 tmp + rename,避免并发写留下半个 JSON;写入后收紧权限
function atomicWrite(file, str, mode) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, str)
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, mode || 0o600) } catch {}
}

// 单进程内 per-file 串行化读改写
const fileLocks = new Map()
function withLock(key, fn) {
  const prev = fileLocks.get(key) || Promise.resolve()
  const next = prev.then(fn, fn)
  fileLocks.set(key, next.catch(() => {}))
  return next
}

// 读 JSON:ENOENT → fallback;解析失败 → 改名留证并抛错(绝不能用旧数据静默放行)
function readJson(file, fallback) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return fallback
    throw e
  }
  try {
    return JSON.parse(raw)
  } catch (e) {
    const backup = `${file}.corrupt-${Date.now()}`
    try { fs.renameSync(file, backup) } catch {}
    throw new Error(`corrupt json at ${file} (moved to ${backup}): ${e.message}`)
  }
}

function loadSecret() {
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim()
    if (s.length >= 32) { serverSecret = s; return }
  } catch {}
  serverSecret = crypto.randomBytes(32).toString('hex')
  atomicWrite(SECRET_FILE, serverSecret + '\n', 0o600)
  // 注意:secret 更换会使全部已签发会话失效
}

// ===== users.json(mtime 缓存) =====
let usersCache = { mtimeMs: -1, data: null }
function getUsers() {
  const st = fs.statSync(USERS_FILE)
  if (st.mtimeMs !== usersCache.mtimeMs) {
    usersCache = { mtimeMs: st.mtimeMs, data: readJson(USERS_FILE, { users: [] }) }
  }
  return usersCache.data
}
function saveUsers(list) {
  atomicWrite(USERS_FILE, JSON.stringify({ users: list }, null, 2), 0o600)
  usersCache.mtimeMs = -1 // 下次读强制重载
  console.log('[hypora-auth] users.json 已写入 (' + list.length + ' 用户, ' + new Date().toISOString() + ')')
}

// 首次启动:创建管理员并落一份初始密码文件(0600),明文不进日志
function ensureBootstrapAdmin() {
  if (fs.existsSync(USERS_FILE)) {
    if (fs.existsSync(BOOTSTRAP_FILE)) {
      console.warn('[hypora-auth] 提示: ' + BOOTSTRAP_FILE + ' 仍存在,请查阅初始密码后删除该文件')
    }
    return
  }
  const pw = genPassword(24)
  const salt = crypto.randomBytes(16).toString('hex')
  const admin = {
    username: ADMIN_USER,
    salt,
    hash: hashPassword(pw, salt),
    role: 'admin',
    tokenVersion: Date.now(),
    createdAt: Date.now(),
    note: '内置管理员',
  }
  saveUsers([admin])
  atomicWrite(BOOTSTRAP_FILE, `账号: ${ADMIN_USER}\n初始密码: ${pw}\n(登录后请在「修改密码」中更换,并删除本文件)\n`, 0o600)
  console.log('[hypora-auth] 已创建管理员,初始密码见: ' + BOOTSTRAP_FILE)
}

// ===== 密码与令牌 =====
function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')
}
function verifyPassword(pw, salt, hex) {
  const calc = Buffer.from(hashPassword(pw, salt), 'hex')
  const expect = Buffer.from(hex, 'hex')
  if (calc.length !== expect.length) return false
  return crypto.timingSafeEqual(calc, expect)
}

// 生成可读性安全的随机密码:排除 0O1lI 等易混字符,强保大小写+数字各至少 1 个
function genPassword(len = 24) {
  const lower = 'abcdefghijkmnpqrstuvwxyz'
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const digits = '23456789'
  const all = lower + upper + digits
  const pick = (set) => set[crypto.randomInt(set.length)]
  for (;;) {
    const chars = Array.from({ length: len }, () => pick(all))
    if (chars.some((c) => lower.includes(c)) && chars.some((c) => upper.includes(c)) && chars.some((c) => digits.includes(c))) {
      return chars.join('')
    }
  }
}

function b64url(buf) { return Buffer.from(buf).toString('base64url') }

function sessionSig(payload) {
  return crypto.createHmac('sha256', serverSecret).update(payload).digest('base64url')
}

function issueSession(res, user) {
  const exp = Date.now() + SESSION_TTL_MS
  const payload = `${b64url(user.username)}.${exp}.${user.tokenVersion}`
  const val = `${payload}.${sessionSig(payload)}`
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`)
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

function parseCookies(header) {
  const out = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const k = part.slice(0, idx).trim()
    let v = part.slice(idx + 1).trim()
    try { v = decodeURIComponent(v) } catch {}
    out[k] = v
  }
  return out
}

// 校验会话:签名 → 过期 → 用户存在 → tokenVersion 一致;任一失败返回 null
function getSession(req) {
  if (!serverSecret) return null
  const val = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  if (!val) return null
  const parts = val.split('.')
  if (parts.length !== 4) return null
  const [uB64, expStr, tvStr, sig] = parts
  const payload = `${uB64}.${expStr}.${tvStr}`
  const expect = Buffer.from(sessionSig(payload))
  const got = Buffer.from(sig)
  if (expect.length !== got.length || !crypto.timingSafeEqual(expect, got)) return null
  const exp = parseInt(expStr, 10)
  if (!Number.isFinite(exp) || exp <= Date.now()) return null
  let username
  try { username = Buffer.from(uB64, 'base64url').toString('utf8') } catch { return null }
  let user
  try { user = getUsers().users.find((u) => u.username === username) } catch { return null }
  if (!user || String(user.tokenVersion) !== tvStr) return null
  return { username: user.username, role: user.role, tokenVersion: user.tokenVersion }
}

function withAuth(handler) {
  return (req, res) => {
    if (!dataOk) return jsonErr(res, 500, 'data dir unavailable')
    const session = getSession(req)
    if (!session) return jsonErr(res, 401, 'unauthorized')
    return handler(req, res, session)
  }
}

function withAdmin(handler) {
  return withAuth((req, res, session) => {
    if (session.role !== 'admin') return jsonErr(res, 403, 'forbidden')
    return handler(req, res, session)
  })
}

// 登录限流:内存 per-IP 失败计数,5 次失败锁 10 分钟(重启清零,可接受)
const loginFails = new Map()
const FAIL_LIMIT = 5
const LOCK_MS = 10 * 60 * 1000
function clientIp(req) { return req.socket.remoteAddress || 'unknown' }
function checkLock(req) {
  const ip = clientIp(req)
  const rec = loginFails.get(ip)
  if (!rec) return 0
  if (rec.lockUntil > Date.now()) return Math.ceil((rec.lockUntil - Date.now()) / 1000)
  if (rec.lockUntil) loginFails.delete(ip) // 锁已过期,重新计数
  return 0
}
function recordFail(req) {
  const ip = clientIp(req)
  const now = Date.now()
  // 清理 15 分钟无活动的旧条目(锁定中的保留)
  for (const [k, v] of loginFails) {
    if (v.lockUntil <= now && now - v.last > 15 * 60 * 1000) loginFails.delete(k)
  }
  const rec = loginFails.get(ip) || { count: 0, lockUntil: 0, last: 0 }
  rec.count += 1
  rec.last = now
  if (rec.count >= FAIL_LIMIT) rec.lockUntil = now + LOCK_MS
  loginFails.set(ip, rec)
}
function clearFails(req) { loginFails.delete(clientIp(req)) }

// 读请求体:超过 maxBytes 返回 null(不断连,排空后回 413)
function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let overflow = false
    req.on('data', (c) => {
      size += c.length
      if (size > maxBytes) { overflow = true; chunks.length = 0 }
      else if (!overflow) chunks.push(c)
    })
    req.on('error', () => resolve(null))
    req.on('end', () => resolve(overflow ? null : Buffer.concat(chunks)))
  })
}

// ===== Auth 路由 =====
async function applyAuthLogin(req, res) {
  if (!dataOk) return jsonErr(res, 500, 'data dir unavailable')
  if (req.method !== 'POST') return jsonErr(res, 405, 'Method Not Allowed')
  const lockLeft = checkLock(req)
  if (lockLeft > 0) return jsonErr(res, 429, `尝试过多,请 ${lockLeft} 秒后再试`)
  const bodyBuf = await readBody(req, 64 * 1024)
  if (!bodyBuf) return jsonErr(res, 413, 'body too large')
  let data
  try { data = JSON.parse(bodyBuf.toString('utf8')) } catch { return jsonErr(res, 400, 'invalid json') }
  const username = typeof data.username === 'string' ? data.username : ''
  const password = typeof data.password === 'string' ? data.password : ''
  if (!USERNAME_RE.test(username) || !password || password.length > 256) {
    return jsonErr(res, 400, 'bad username or password')
  }
  let users
  try { users = getUsers().users } catch (e) {
    console.error('[hypora-auth] users.json 读取失败:', e.message)
    return jsonErr(res, 500, 'user store unavailable')
  }
  const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase())
  // 用户不存在也跑一次 scrypt,避免时序差泄露用户是否存在
  const salt = user ? user.salt : '00000000000000000000000000000000'
  const hash = user ? user.hash : '00'
  let ok = false
  try { ok = user && verifyPassword(password, salt, hash) } catch { ok = false }
  if (!ok) {
    recordFail(req)
    return jsonErr(res, 401, '账号或密码错误')
  }
  clearFails(req)
  issueSession(res, user)
  jsonOk(res, { ok: true, user: { username: user.username, role: user.role } })
}

function applyAuthMe(req, res) {
  const session = dataOk ? getSession(req) : null
  jsonOk(res, { ok: true, user: session ? { username: session.username, role: session.role } : null })
}

function applyAuthLogout(req, res) {
  clearSession(res)
  jsonOk(res, { ok: true })
}

async function applyAuthPassword(req, res, session) {
  if (req.method !== 'POST') return jsonErr(res, 405, 'Method Not Allowed')
  const bodyBuf = await readBody(req, 64 * 1024)
  if (!bodyBuf) return jsonErr(res, 413, 'body too large')
  let data
  try { data = JSON.parse(bodyBuf.toString('utf8')) } catch { return jsonErr(res, 400, 'invalid json') }
  const oldPassword = typeof data.oldPassword === 'string' ? data.oldPassword : ''
  const newPassword = typeof data.newPassword === 'string' ? data.newPassword : ''
  if (!newPassword || newPassword.length < 8 || newPassword.length > 256) {
    return jsonErr(res, 400, '新密码至少 8 位')
  }
  let users
  try { users = getUsers().users } catch (e) {
    console.error('[hypora-auth] users.json 读取失败:', e.message)
    return jsonErr(res, 500, 'user store unavailable')
  }
  const user = users.find((u) => u.username === session.username)
  if (!user) return jsonErr(res, 401, 'unauthorized')
  let ok = false
  try { ok = verifyPassword(oldPassword, user.salt, user.hash) } catch { ok = false }
  if (!ok) return jsonErr(res, 401, '旧密码错误')
  // 不 bump tokenVersion:改完密码保持当前会话有效
  user.salt = crypto.randomBytes(16).toString('hex')
  user.hash = hashPassword(newPassword, user.salt)
  withLock('users', () => {
    const list = getUsers().users
    const target = list.find((u) => u.username === user.username)
    if (target) { target.salt = user.salt; target.hash = user.hash; saveUsers(list) }
  })
  jsonOk(res, { ok: true })
}

// ===== Admin 路由(仅 role=admin) =====
function chatStat(username) {
  const f = path.join(CHATS_DIR, `${username}.json`)
  try {
    const st = fs.statSync(f)
    return { chatBytes: st.size, chatUpdatedAt: Math.floor(st.mtimeMs) }
  } catch {
    return { chatBytes: 0, chatUpdatedAt: 0 }
  }
}

async function handleAdmin(req, res, session, urlPath) {
  if (req.method === 'GET' && urlPath === '/api/admin/users') {
    let users
    try { users = getUsers().users } catch (e) {
      console.error('[hypora-auth] users.json 读取失败:', e.message)
      return jsonErr(res, 500, 'user store unavailable')
    }
    const safe = users.map((u) => ({
      username: u.username, role: u.role, note: u.note || '',
      createdAt: u.createdAt || 0, ...chatStat(u.username),
    }))
    return jsonOk(res, { ok: true, users: safe })
  }

  if (req.method === 'POST' && urlPath === '/api/admin/users') {
    const bodyBuf = await readBody(req, 64 * 1024)
    if (!bodyBuf) return jsonErr(res, 413, 'body too large')
    let data
    try { data = JSON.parse(bodyBuf.toString('utf8')) } catch { return jsonErr(res, 400, 'invalid json') }
    const username = typeof data.username === 'string' ? data.username.trim() : ''
    if (!USERNAME_RE.test(username)) return jsonErr(res, 400, '用户名需 2-32 位字母/数字/下划线')
    const password = typeof data.password === 'string' && data.password ? data.password : genPassword(24)
    if (password.length > 256) return jsonErr(res, 400, '密码过长')
    const note = typeof data.note === 'string' ? data.note.slice(0, 200) : ''
    let exists = false
    try { exists = getUsers().users.some((u) => u.username.toLowerCase() === username.toLowerCase()) } catch (e) {
      console.error('[hypora-auth] users.json 读取失败:', e.message)
      return jsonErr(res, 500, 'user store unavailable')
    }
    if (exists) return jsonErr(res, 400, '用户名已存在')
    const salt = crypto.randomBytes(16).toString('hex')
    const user = {
      username, salt, hash: hashPassword(password, salt), role: 'user',
      tokenVersion: Date.now(), createdAt: Date.now(), note,
    }
    let result = 'ok'
    await withLock('users', () => {
      const list = getUsers().users
      if (list.some((u) => u.username.toLowerCase() === username.toLowerCase())) { result = 'exists'; return }
      list.push(user)
      saveUsers(list)
    })
    if (result === 'exists') return jsonErr(res, 400, '用户名已存在')
    return jsonOk(res, { ok: true, username, password }) // 明文仅此一次
  }

  if (req.method === 'POST' && urlPath === '/api/admin/users/reset') {
    const bodyBuf = await readBody(req, 64 * 1024)
    if (!bodyBuf) return jsonErr(res, 413, 'body too large')
    let data
    try { data = JSON.parse(bodyBuf.toString('utf8')) } catch { return jsonErr(res, 400, 'invalid json') }
    const username = typeof data.username === 'string' ? data.username : ''
    if (username === ADMIN_USER) return jsonErr(res, 400, '不能重置管理员,请用「修改密码」')
    const password = typeof data.password === 'string' && data.password ? data.password : genPassword(24)
    if (password.length > 256) return jsonErr(res, 400, '密码过长')
    let found = false
    await withLock('users', () => {
      const list = getUsers().users
      const target = list.find((u) => u.username === username)
      if (!target) return
      found = true
      target.salt = crypto.randomBytes(16).toString('hex')
      target.hash = hashPassword(password, target.salt)
      target.tokenVersion = Date.now() // 踢掉该用户全部现存会话
      saveUsers(list)
    })
    if (!found) return jsonErr(res, 404, '用户不存在')
    return jsonOk(res, { ok: true, username, password }) // 明文仅此一次
  }

  if (req.method === 'DELETE' && urlPath === '/api/admin/users') {
    const q = new URLSearchParams(req.url.split('?')[1] || '')
    const username = q.get('name') || ''
    if (!username) return jsonErr(res, 400, 'missing name')
    if (username === ADMIN_USER) return jsonErr(res, 403, '不能删除管理员')
    let found = false
    await withLock('users', () => {
      const list = getUsers().users
      const idx = list.findIndex((u) => u.username === username)
      if (idx === -1) return
      found = true
      list.splice(idx, 1)
      saveUsers(list)
    })
    if (!found) return jsonErr(res, 404, '用户不存在')
    fs.unlink(path.join(CHATS_DIR, `${username}.json`), () => {}) // 聊天记录一并清理
    fs.rm(path.join(USER_CLOUD_ROOT, username), { recursive: true, force: true }, () => {}) // 云端文档一并清理
    return jsonOk(res, { ok: true })
  }

  return jsonErr(res, 404, 'not found')
}

// ===== Chats 路由(登录用户各自的聊天记录,单文件 JSON) =====
function chatFile(username) { return path.join(CHATS_DIR, `${username}.json`) }

function applyChats(req, res, session) {
  const file = chatFile(session.username) // username 已过正则,无穿越风险
  if (req.method === 'GET') {
    const data = readJson(file, { messages: [], reasonings: [], rev: 0, updatedAt: 0 })
    return jsonOk(res, {
      ok: true,
      messages: Array.isArray(data.messages) ? data.messages : [],
      reasonings: Array.isArray(data.reasonings) ? data.reasonings : [],
      rev: data.rev || 0,
      updatedAt: data.updatedAt || 0,
    })
  }
  if (req.method === 'PUT') {
    return readBody(req, CHAT_MAX_BYTES).then((bodyBuf) => {
      if (!bodyBuf) return jsonErr(res, 413, '聊天记录超出 2MB,请清理后重试')
      let data
      try { data = JSON.parse(bodyBuf.toString('utf8')) } catch { return jsonErr(res, 400, 'invalid json') }
      const messages = Array.isArray(data.messages) ? data.messages : null
      const reasonings = Array.isArray(data.reasonings) ? data.reasonings : null
      if (!messages || !reasonings || messages.length !== reasonings.length) {
        return jsonErr(res, 400, 'bad chat payload')
      }
      return withLock(`chat:${session.username}`, () => {
        const prev = readJson(file, { rev: 0 })
        const doc = {
          messages, reasonings,
          rev: (prev.rev || 0) + 1,
          updatedAt: Date.now(),
        }
        atomicWrite(file, JSON.stringify(doc), 0o600)
        return doc
      }).then((doc) => jsonOk(res, { ok: true, rev: doc.rev, bytes: Buffer.byteLength(JSON.stringify(doc)) }))
    })
  }
  if (req.method === 'DELETE') {
    fs.unlink(file, () => jsonOk(res, { ok: true }))
    return
  }
  jsonErr(res, 405, 'Method Not Allowed')
}

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
    res.end(buf)
  })
}

// ===== 云存储：按用户隔离的云端文档 =====
// 每个账号独立目录 `${DATA_ROOT}/cloud/<用户名>/`（不在 nginx 静态根内），互相不可见。
// 历史数据（旧共享池 `${根名}-cloud`）已在上线账号体系时全量迁入 admin 名下。
const USER_CLOUD_ROOT = path.join(DATA_ROOT, 'cloud')

// POST /api/cloud/save  body: { filename, content }
function applyCloudSave(req, res, session) {
  if (req.method !== 'POST') return jsonErr(res, 405, 'Method Not Allowed')
  const chunks = []
  let size = 0
  const MAX = 128 * 1024 * 1024
  req.on('data', (c) => { size += c.length; if (size > MAX) req.destroy(); else chunks.push(c) })
  req.on('error', () => { if (!res.headersSent) jsonErr(res, 400, 'bad request body') })
  req.on('end', () => {
    let data
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return jsonErr(res, 400, 'invalid json') }
    const content = data && typeof data.content === 'string' ? data.content : null
    if (content == null) return jsonErr(res, 400, 'content required')
    // 文件名安全：去路径分隔符与非法字符，统一 .md 后缀，避开路径穿越
    let name = String(data.filename || 'document').split(/[\\/]/).pop() || 'document'
    name = name.replace(/[<>:"\\|?*]/g, '-').replace(/[^\x20-\x7E一-龥-]/g, '').replace(/[\s.]+$/g, '').trim() || 'document'
    if (!/\.md$/i.test(name)) name += '.md'
    const userDir = path.join(USER_CLOUD_ROOT, session.username)
    const target = path.join(userDir, name)
    if (!target.startsWith(userDir)) return jsonErr(res, 403, 'bad filename')
    fs.mkdir(userDir, { recursive: true }, (err) => {
      if (err) return jsonErr(res, 500, 'mkdir failed: ' + err.message)
      fs.writeFile(target, content, 'utf8', (err) => {
        if (err) return jsonErr(res, 500, 'write failed: ' + err.message)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, path: name }))
      })
    })
  })
}

// ===== 云存储 · 列表 / 读取 / 删除 =====
function sanitizeCloudName(raw) {
  let name = String(raw || 'document').split(/[\\/]/).pop() || 'document'
  name = name.replace(/[<>:"/\\|?*]/g, '-').replace(/[^\x20-\x7E一-龥-]/g, '').replace(/[\s.]+$/g, '').trim() || 'document'
  if (!/\.md$/i.test(name)) name += '.md'
  return name
}
function cloudFile(username, name) {
  const userDir = path.join(USER_CLOUD_ROOT, username)
  const target = path.join(userDir, name)
  return target.startsWith(userDir) ? target : null
}

// GET /api/cloud/list → { files: [{ name, size, mtime }] }（按修改时间倒序，仅当前用户）
function applyCloudList(req, res, session) {
  const userDir = path.join(USER_CLOUD_ROOT, session.username)
  fs.readdir(userDir, (err, names) => {
    if (err) {
      // 目录尚不存在 = 还没有云端文件
      if (err.code === 'ENOENT') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ files: [] }))
      }
      return jsonErr(res, 500, 'readdir failed: ' + err.message)
    }
    const mdNames = names.filter((n) => /\.md$/i.test(n))
    Promise.all(mdNames.map((n) => new Promise((resolveP) => {
      fs.stat(path.join(userDir, n), (err2, st) => {
        resolveP(err2 ? { name: n, size: 0, mtime: 0 } : { name: n, size: st.size, mtime: st.mtimeMs })
      })
    }))).then((files) => {
      files.sort((a, b) => b.mtime - a.mtime)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ files }))
    })
  })
}

// GET /api/cloud/file?name=… → { name, content }   DELETE → { ok }
function applyCloudFile(req, res, session) {
  const q = req.url.split('?')[1] || ''
  const safe = sanitizeCloudName(new URLSearchParams(q).get('name') || '')
  const target = safe ? cloudFile(session.username, safe) : null
  if (!target) return jsonErr(res, 400, 'bad name')
  if (req.method === 'GET') {
    fs.readFile(target, 'utf8', (err, content) => {
      if (err) return jsonErr(res, 404, 'not found')
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ name: safe, content }))
    })
  } else if (req.method === 'DELETE') {
    fs.unlink(target, (err) => {
      if (err) return jsonErr(res, 404, 'not found')
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true }))
    })
  } else {
    jsonErr(res, 405, 'Method Not Allowed')
  }
}

// 异步路由统一兜底:任何未捕获异常都转 500,避免连接悬挂
function safeAsync(fn) {
  return (req, res, ...rest) => {
    Promise.resolve(fn(req, res, ...rest)).catch((e) => {
      console.error('[hypora-auth] handler error:', e && e.message)
      if (!res.headersSent) jsonErr(res, 500, 'internal error')
      else res.end()
    })
  }
}

// ===== 启动:先准备数据目录与引导管理员,失败也不阻塞静态 + /api/ai =====
ensureDataRoot()
if (dataOk) {
  loadSecret()
  try {
    ensureBootstrapAdmin()
  } catch (e) {
    console.error('[hypora-auth] 管理员引导失败:', e.message)
  }
}

http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0]
  if (urlPath === '/api/ai' || urlPath.startsWith('/api/ai/')) {
    return applyProxy(req, res)
  }
  if (urlPath === '/api/auth/login') {
    return safeAsync(applyAuthLogin)(req, res)
  }
  if (urlPath === '/api/auth/me') {
    return applyAuthMe(req, res)
  }
  if (urlPath === '/api/auth/logout') {
    return applyAuthLogout(req, res)
  }
  if (urlPath === '/api/auth/password') {
    return withAuth(safeAsync(applyAuthPassword))(req, res)
  }
  if (urlPath.startsWith('/api/admin/')) {
    return withAdmin(safeAsync((rq, rs, ss) => handleAdmin(rq, rs, ss, urlPath)))(req, res)
  }
  if (urlPath === '/api/chats') {
    return withAuth(safeAsync(applyChats))(req, res)
  }
  if (urlPath === '/api/cloud/save') {
    return withAuth(applyCloudSave)(req, res)
  }
  if (urlPath === '/api/cloud/list') {
    return withAuth(applyCloudList)(req, res)
  }
  if (urlPath === '/api/cloud/file') {
    return withAuth(applyCloudFile)(req, res)
  }
  return serveStatic(req, res)
}).listen(PORT, () => console.log('Hypora Web 已启动(静态+AI代理+认证+云存储): http://localhost:' + PORT))
