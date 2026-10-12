// ============ 知识库纯逻辑库 ============
// 分块 / 文本归一 / 向量编解码 / 相似度检索 / 增量判定 / 来源扫描 / 分片存取。
// 零 electron 依赖：electron-kb.cjs（主进程编排）与 scripts/kb-harness.cjs（测试）共用本模块。

const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

// ============ 常量 ============
const SHARD_VERSION = 1
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024   // 超过则整个文件跳过（too-large）
const DEFAULT_MAX_CHUNKS = 5000                  // 单文件分块上限（超出置 truncated）

// ============ 文本归一 ============
// UTF-8 解码 + BOM 剥离 + CRLF 归一；二进制/乱码文件拒绝索引（返回 null + 原因）。
// NUL 字节（前 8KB）⇒ binary；U+FFFD 占比 >1% ⇒ decode-error（覆盖 GBK/Latin-1 误读）。
function normalizeText(buf) {
  let text = buf.toString('utf-8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const head = buf.subarray(0, 8192)
  if (head.includes(0)) return { text: null, reason: 'binary' }
  const fffd = (text.match(/�/g) || []).length
  if (text.length > 0 && fffd / text.length > 0.01) return { text: null, reason: 'decode-error' }
  text = text.replace(/\r\n?/g, '\n')
  return { text }
}

// ============ Markdown 分块 ============
// 规则：ATX 标题切段并携带面包屑；段落打包至 chunkChars；超长段落先按句末标点、
// 再按字符硬切（UTF-16 代理对不切断）；围栏代码块绝不从中间切开。
// 返回 [{ heading, text, offset }]，offset 为归一文本上的 UTF-16 字符偏移。
function chunkMarkdown(text, opts = {}) {
  const chunkChars = opts.chunkChars || 900
  const maxChunkChars = Math.max(opts.maxChunkChars || 1400, chunkChars)
  const maxChunks = opts.maxChunks || DEFAULT_MAX_CHUNKS

  // —— 第一遍：按标题切成段（heading 面包屑 + 段内段落数组）——
  const segments = []           // [{ heading, paras: [{ text, start }] }]
  let stack = []                // 各级标题文本（stack[0] = h1）
  let cur = null                // 当前段
  let fenceOpen = false         // 围栏状态：开启时标题/空行皆视为普通文本
  let fenceCh = '`'
  let fenceLen = 3
  let paraBuf = []              // 当前段落行缓冲
  let paraStart = 0
  let pos = 0
  const lines = text.split('\n')

  const flushPara = () => {
    if (!paraBuf.length) return
    const t = paraBuf.join('\n')
    if (t.trim()) {
      if (!cur) { cur = { heading: breadcrumb(stack), paras: [] }; segments.push(cur) }
      cur.paras.push({ text: t, start: paraStart })
    }
    paraBuf = []
  }
  const startSegment = (nextStack) => {
    flushPara()
    cur = { heading: breadcrumb(nextStack), paras: [] }
    segments.push(cur)
  }

  for (const line of lines) {
    const m = !fenceOpen ? /^(#{1,6})\s+(.*)$/.exec(line) : null
    const fm = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceOpen) {
      paraBuf.push(line)
      if (fm && fm[1][0] === fenceCh && fm[1].length >= fenceLen) fenceOpen = false
    } else if (m) {
      const lvl = m[1].length
      const title = m[2].replace(/\s+#+\s*$/, '').trim()
      const next = stack.slice(0, lvl)
      next[lvl - 1] = title
      stack = next
      startSegment(stack)
      // 标题行自身并入本段（检索文本自带上下文）
      paraStart = pos
      paraBuf.push(line)
    } else if (fm) {
      flushPara()
      paraStart = pos
      paraBuf.push(line)
      fenceOpen = true
      fenceCh = fm[1][0]
      fenceLen = fm[1].length
    } else if (/^\s*$/.test(line)) {
      flushPara()
    } else {
      if (!paraBuf.length) paraStart = pos
      paraBuf.push(line)
    }
    pos += line.length + 1 // +1 补回 split 掉的 \n（末行多计 1 无碍：只用于相对序）
  }
  flushPara()

  // —— 第二遍：段内打包 ——
  const out = []
  const pushChunk = (heading, text, offset) => {
    if (out.length >= maxChunks) return
    const t = text.trim()
    if (!t) return
    // offset 校正 trim 掉的前导空白（尾部空白不影响偏移）
    const lead = text.length - text.trimStart().length
    out.push({ heading: heading || '', text: t, offset: offset + lead })
  }

  for (const seg of segments) {
    if (out.length >= maxChunks) break
    let buf = null                  // { parts: [para], len }
    const emit = () => {
      if (!buf) return
      const text2 = buf.parts.map((p) => p.text).join('\n\n')
      pushChunk(seg.heading, text2, buf.parts[0].start)
      buf = null
    }
    for (const para of seg.paras) {
      if (out.length >= maxChunks) break
      if (para.text.length > maxChunkChars) {
        emit()
        for (const piece of splitOversized(para, maxChunkChars)) {
          pushChunk(seg.heading, piece.text, piece.start)
        }
      } else if (!buf) {
        buf = { parts: [para] }
      } else if (bufLen(buf) + 2 + para.text.length <= chunkChars) {
        buf.parts.push(para)
      } else {
        emit()
        buf = { parts: [para] }
      }
    }
    emit()
  }
  return out
}

function bufLen(buf) {
  let n = 0
  for (const p of buf.parts) n += p.text.length + 2
  return n - 2
}

// 超长段落拆分：含围栏行 ⇒ 围栏整块原子保留、围栏外文本按句切；纯文本按句切，单句超长按字符切
function splitOversized(para, maxChunkChars) {
  const fenceLines = []
  const lines = para.text.split('\n')
  lines.forEach((l, i) => { if (/^\s{0,3}(`{3,}|~{3,})/.test(l)) fenceLines.push(i) })
  if (!fenceLines.length) return splitSentences(para, maxChunkChars)

  const pieces = []
  let runStart = 0
  let i = 0
  while (i < lines.length) {
    if (fenceLines.includes(i)) {
      if (i > runStart) pieces.push(...sliceProse(para, runStart, i, maxChunkChars))
      // 围栏整块：开栏行到闭栏行（找不到闭栏则到末尾）原子成段
      let close = lines.findIndex((l, j) => j > i && /^\s{0,3}(`{3,}|~{3,})/.test(l))
      if (close === -1) close = lines.length
      const text = lines.slice(i, close + 1 > lines.length ? lines.length : close + 1).join('\n')
      pieces.push({ text, start: para.start + lineOffset(para.text, i) })
      i = close + 1
      runStart = i
    } else {
      i++
    }
  }
  if (runStart < lines.length) pieces.push(...sliceProse(para, runStart, lines.length, maxChunkChars))
  return pieces
}

// 文本行区间 [a,b) 按句切（行偏移换算成全局偏移）
function sliceProse(para, a, b, maxChunkChars) {
  const text = para.text
  const offA = lineOffset(text, a)
  const offB = lineOffset(text, b)
  const sub = text.slice(offA, offB)
  return splitSentences({ text: sub, start: para.start + offA }, maxChunkChars)
}

// 第 a 行在 text 中的字符偏移
function lineOffset(text, a) {
  if (a <= 0) return 0
  let off = 0
  const lines = text.split('\n')
  for (let i = 0; i < a && i < lines.length; i++) off += lines[i].length + 1
  return Math.min(off, text.length)
}

// 句子级拆分：贪心打包到 maxChunkChars；单句超长按字符硬切（代理对安全）
function splitSentences(para, maxChunkChars) {
  const { text, start } = para
  const out = []
  // 中英句末标点 + 收尾引号/括号
  const re = /[^。！？.!?]*[。！？.!?]+["'」』）)]*\s*/g
  const pieces = []
  let m
  let last = 0
  while ((m = re.exec(text)) !== null) {
    pieces.push({ off0: last, off1: m.index + m[0].length })
    last = m.index + m[0].length
  }
  if (last < text.length) pieces.push({ off0: last, off1: text.length })

  let buf = null
  const emit = () => {
    if (!buf) return
    out.push({ text: text.slice(buf.off0, buf.off1), start: start + buf.off0 })
    buf = null
  }
  for (const p of pieces) {
    const len = p.off1 - p.off0
    if (len > maxChunkChars) {
      emit()
      for (const c of charSlices(text, p.off0, p.off1, maxChunkChars)) {
        out.push({ text: text.slice(c.off0, c.off1), start: start + c.off0 })
      }
    } else if (!buf) {
      buf = p
    } else if (buf.off1 - buf.off0 + len <= maxChunkChars) {
      buf.off1 = p.off1
    } else {
      emit()
      buf = p
    }
  }
  emit()
  return out
}

// 字符硬切：切点落在低代理项上时回退一个 UTF-16 单元
function charSlices(text, from, to, size) {
  const out = []
  let i = from
  while (i < to) {
    let j = Math.min(i + size, to)
    if (j < to && j > i && text.charCodeAt(j) >= 0xdc00 && text.charCodeAt(j) <= 0xdfff) j--
    if (j <= i) j = Math.min(i + size, to) // 极端兜底：保证推进
    out.push({ off0: i, off1: j })
    i = j
  }
  return out
}

function breadcrumb(stack) {
  return stack.filter(Boolean).join(' / ')
}

// ============ 向量编解码 ============
// base64(Float32LE)；写入前 L2 归一化 ⇒ 检索退化为点积
function encodeVec(f32) {
  const buf = Buffer.alloc(f32.length * 4)
  for (let i = 0; i < f32.length; i++) buf.writeFloatLE(f32[i], i * 4)
  return buf.toString('base64')
}
function decodeVec(b64) {
  const buf = Buffer.from(b64, 'base64')
  const n = buf.length >> 2
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4)
  return out
}
// 原地 L2 归一化（零向量保持原样）
function normalizeVec(f32) {
  let s = 0
  for (let i = 0; i < f32.length; i++) s += f32[i] * f32[i]
  if (s > 0) {
    const inv = 1 / Math.sqrt(s)
    for (let i = 0; i < f32.length; i++) f32[i] *= inv
  }
  return f32
}

// ============ 相似度检索 ============
// 归一化向量点积即余弦；minScore 过滤 + 降序取前 k；返回条目去掉 vec
function cosineTopK(q, entries, k, minScore = 0) {
  const scored = []
  for (const e of entries) {
    const v = e.vec
    let d = 0
    const n = Math.min(q.length, v.length)
    for (let i = 0; i < n; i++) d += q[i] * v[i]
    if (d >= minScore) scored.push({ e, score: d })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k).map(({ e, score }) => {
    const { vec, ...rest } = e
    return { ...rest, score }
  })
}

// ============ 增量判定 ============
// 分片指纹：文件 mtime+size + 模型指纹（size+mtime）+ 维度 + 版本，任一不符即需重建
function shouldReindex(prevShard, stat, model = {}) {
  if (!prevShard) return true
  if (!prevShard.skipped) {
    if (prevShard.version !== SHARD_VERSION) return true
    if (model.size != null && prevShard.modelSize !== model.size) return true
    if (model.mtimeMs != null && prevShard.modelMtimeMs !== model.mtimeMs) return true
    if (model.dim != null && prevShard.dim !== model.dim) return true
  }
  return prevShard.size !== stat.size || prevShard.mtimeMs !== stat.mtimeMs
}

// ============ 来源扫描 ============
// 递归收集 *.md / *.markdown；跳过 . 开头目录与 node_modules；目录符号链接只在
// realpath 仍位于已注册来源内时跟随（防环 + 防越界）；重叠来源按解析路径去重（先到先得）。
function scanSources(sources, opts = {}) {
  const maxFileBytes = opts.maxFileBytes || DEFAULT_MAX_FILE_BYTES
  const roots = [...new Set(sources.map((s) => path.resolve(s)))]
  const seenDirs = new Set()   // 已递归的目录 realpath（防符号链接环）
  const seenFiles = new Map()  // 大小写折叠路径 → 已归属来源
  const out = []

  const caseFold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)

  const walk = (dir, root) => {
    let rp = null
    try { rp = fs.realpathSync(dir) } catch { return }
    if (seenDirs.has(rp)) return
    seenDirs.add(rp)
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.') || ent.name === 'node_modules') continue
        // 目录符号链接：realpath 越出所有来源根则不跟随
        if (ent.isSymbolicLink()) {
          try {
            const real = fs.realpathSync(full)
            if (!roots.some((r) => caseFold(real) === caseFold(r) || caseFold(real).startsWith(caseFold(r) + path.sep))) continue
          } catch { continue }
        }
        walk(full, root)
      } else if (ent.isFile()) {
        if (!/\.(md|markdown)$/i.test(ent.name)) continue
        const key = caseFold(path.resolve(full))
        if (seenFiles.has(key)) continue        // 重叠来源：先到先得
        seenFiles.set(key, true)
        let st = null
        try { st = fs.statSync(full) } catch { continue }
        out.push({ path: path.resolve(full), dir: root, size: st.size, mtimeMs: st.mtimeMs, oversized: st.size > maxFileBytes })
      }
    }
  }

  for (const root of roots) walk(root, root)
  return out
}

// ============ 分片存取 ============
const shardName = (absPath) => {
  const folded = process.platform === 'win32' ? path.resolve(absPath).toLowerCase() : path.resolve(absPath)
  return crypto.createHash('sha1').update(folded).digest('hex') + '.json'
}

function readShard(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (!j || j.version !== SHARD_VERSION || !Array.isArray(j.chunks)) return null
    return j
  } catch { return null }
}

function writeShardAtomic(file, shard) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(shard))
  fs.renameSync(tmp, file)   // libuv 在 Windows 用 MOVEFILE_REPLACE_EXISTING，可覆盖
}

function deleteShardsNotIn(indexDir, keepNames) {
  let names = []
  try { names = fs.readdirSync(indexDir) } catch { return }
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    if (keepNames.has(n)) continue
    try { fs.unlinkSync(path.join(indexDir, n)) } catch { /* 忽略 */ }
  }
}

// ============ 嵌入提示词 ============
// EmbeddingGemma 官方推荐前缀（检索任务）；其他嵌入模型退化为纯文本
function buildQueryPrompt(raw, isGemma) {
  const t = (raw || '').trim()
  return isGemma ? `task: search result | query: ${t}` : t
}
function buildDocPrompt(title, body, isGemma) {
  return isGemma ? `title: ${title || 'none'} | text: ${body}` : body
}

// ============ 多库合并 ============
// 各库已按自身 topK/minScore 截取（防大库淹没小库）；扁平化后按 score 全局降序取前 globalTopK
function mergeKbHits(perKbResults, globalTopK) {
  const all = []
  for (const r of perKbResults || []) {
    if (r && Array.isArray(r.hits)) all.push(...r.hits)
  }
  all.sort((a, b) => (b.score || 0) - (a.score || 0))
  return all.slice(0, Math.max(1, globalTopK || 8))
}

// ============ 注入块格式化 ============
// hits: [{ title, heading, text, path?, score? }]；逐条截断 + 总预算截断
function formatKbBlock(hits, opts = {}) {
  const perHit = opts.perHitChars || 1200
  const budget = opts.budgetChars || 6000
  if (!hits || !hits.length) return ''
  const lines = ['--- 知识库检索（参考资料：回答时优先依据以下内容；与问题无关请忽略，不要虚构资料外的事实）---']
  let used = 0
  hits.forEach((h, i) => {
    const head = `[${i + 1}] 《${h.title || path.basename(h.path || '文档', '.md')}》${h.heading ? ' · ' + h.heading : ''}`
    const body = (h.text || '').slice(0, perHit)
    const cost = head.length + body.length + 2
    if (used + cost > budget) return
    used += cost
    lines.push(head, body)
  })
  return lines.length > 1 ? lines.join('\n') : ''
}

module.exports = {
  SHARD_VERSION,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_CHUNKS,
  normalizeText,
  chunkMarkdown,
  encodeVec,
  decodeVec,
  normalizeVec,
  cosineTopK,
  mergeKbHits,
  shouldReindex,
  scanSources,
  shardName,
  readShard,
  writeShardAtomic,
  deleteShardsNotIn,
  buildQueryPrompt,
  buildDocPrompt,
  formatKbBlock,
}
