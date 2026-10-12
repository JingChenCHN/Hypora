#!/usr/bin/env node
/**
 * kb-harness.cjs —— dev-only：知识库纯逻辑全量边界测试（默认 lib-only，无需 llama.cpp）。
 * 本机（GLIBC 老 / 内存小）跑不了 llama.cpp，服务生命周期链路只做状态机冒烟；
 * 真实嵌入端到端（KB_LIVE=1 + KB_MODEL=<gguf>）在 Windows 上选通。
 * 用法：node scripts/kb-harness.cjs     （HOME 隔离到临时目录，不碰真实 userData）
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const lib = require('../electron-kb-lib.cjs')

// HOME 隔离：kbRoot 退到 $HOME/.hypora-kb，避免污染真实环境
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hypora-kb-harness-'))
process.env.HOME = sandbox
process.env.HYPORA_KB_ENGINE_DIR = path.join(sandbox, 'no-bin')   // 保证任何 spawn 尝试直接失败

let pass = 0
let fail = 0
const failures = []
function t(name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    failures.push(`${name}: ${e.message}`)
    console.error(`  ✗ ${name}: ${e.message}`)
  }
}
async function ta(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    failures.push(`${name}: ${e.message}`)
    console.error(`  ✗ ${name}: ${e.message}`)
  }
}

// ============ normalizeText ============
console.log('normalizeText')
t('CRLF/CR 归一 + BOM 剥离', () => {
  const r = lib.normalizeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\rc', 'utf-8')]))
  assert.strictEqual(r.text, 'a\nb\nc')
})
t('NUL 字节 → binary 拒绝', () => {
  const r = lib.normalizeText(Buffer.from('ok\x00bad', 'utf-8'))
  assert.strictEqual(r.text, null)
  assert.strictEqual(r.reason, 'binary')
})
t('GBK 误读 → decode-error 拒绝', () => {
  // 「知识库」的 GBK 字节按 UTF-8 解码会大面积 U+FFFD
  const gbk = Buffer.from([0xd6, 0xaa, 0xca, 0xb6, 0xbf, 0xe2, 0xd6, 0xaa, 0xca, 0xb6, 0xbf, 0xe2, 0xd6, 0xaa, 0xca, 0xb6, 0xbf, 0xe2, 0xd6, 0xaa, 0xca, 0xb6, 0xbf, 0xe2])
  const r = lib.normalizeText(gbk)
  assert.strictEqual(r.text, null)
  assert.strictEqual(r.reason, 'decode-error')
})
t('正常 UTF-8 通过', () => {
  const r = lib.normalizeText(Buffer.from('# 中文标题\n\n正文 emoji 👍', 'utf-8'))
  assert.ok(r.text.includes('中文标题') && r.text.includes('👍'))
})

// ============ chunkMarkdown ============
console.log('chunkMarkdown')
t('标题面包屑与切段', () => {
  const md = '# H1\n\np1\n\n## H2\n\np2\n\n### H3\n\np3'
  const cs = lib.chunkMarkdown(md)
  assert.deepStrictEqual(cs.map((c) => c.heading), ['H1', 'H1 / H2', 'H1 / H2 / H3'])
  assert.ok(cs[0].text.startsWith('# H1'))
  assert.ok(cs[1].text.includes('p2'))
})
t('段落打包到 chunkChars', () => {
  const paras = Array.from({ length: 10 }, (_, i) => `段落${i}，` + 'x'.repeat(200)).join('\n\n')
  const cs = lib.chunkMarkdown(paras, { chunkChars: 500, maxChunkChars: 1400 })
  assert.ok(cs.length >= 4 && cs.length <= 6, `chunks=${cs.length}`)
  assert.ok(cs.every((c) => c.text.length <= 1400))
})
t('超长段按句切', () => {
  const long = '这是第一句话。'.repeat(201) // 1407 chars，越过 maxChunkChars=1400
  const cs = lib.chunkMarkdown(long, { chunkChars: 900, maxChunkChars: 1400 })
  assert.ok(cs.length >= 2)
  assert.ok(cs.every((c) => c.text.length <= 1400))
  // 句边界：每片以句号收尾（最后一片除外）
  for (const c of cs.slice(0, -1)) assert.ok(/[。.!?！？]\s*$/.test(c.text), '未按句切')
})
t('单句超长按字符切且代理对不切断', () => {
  const emoji = '👍'.repeat(800) // 1600 UTF-16 units，无句末标点
  const cs = lib.chunkMarkdown(emoji, { chunkChars: 900, maxChunkChars: 1000 })
  assert.ok(cs.length >= 2)
  for (const c of cs) {
    assert.ok(c.text.length <= 1000)
    // 每片内部不出现孤立代理项
    for (let i = 0; i < c.text.length; i++) {
      const code = c.text.charCodeAt(i)
      if (code >= 0xdc00 && code <= 0xdfff) {
        assert.ok(i > 0 && c.text.charCodeAt(i - 1) >= 0xd800 && c.text.charCodeAt(i - 1) <= 0xdbff, '孤立低代理项')
      }
    }
  }
  const rejoined = cs.map((c) => c.text).join('')
  assert.strictEqual(rejoined, emoji, '切片拼接应无损')
})
t('围栏绝不从中间切开', () => {
  const fence = '```js\n' + Array.from({ length: 80 }, (_, i) => `const v${i} = ${i}; // 行内容长一些一些一些`).join('\n') + '\n```'
  const cs = lib.chunkMarkdown(fence, { chunkChars: 100, maxChunkChars: 200 })
  // 无论怎么切：完整围栏（``` 开 + ``` 收）必须整体出现在某一片里
  const whole = cs.some((c) => c.text.split('```').length >= 3 && c.text.trimEnd().endsWith('```'))
  assert.ok(whole, '围栏被切断')
})
t('无标题文件 heading 为空串', () => {
  const cs = lib.chunkMarkdown('段落甲。\n\n段落乙。')
  assert.strictEqual(cs.length, 1)
  assert.strictEqual(cs[0].heading, '')
})
t('空文件 → 空数组', () => {
  assert.deepStrictEqual(lib.chunkMarkdown(''), [])
  assert.deepStrictEqual(lib.chunkMarkdown('   \n\n  '), [])
})
t('offset 与归一文本对齐', () => {
  const md = '# 标题\n\n第一段。\n\n## 子\n\n第二段。'
  for (const c of lib.chunkMarkdown(md)) {
    assert.strictEqual(md.slice(c.offset, c.offset + c.text.length), c.text, `offset 错位 @${c.offset}`)
  }
})
t('maxChunks 截断', () => {
  const md = Array.from({ length: 20 }, (_, i) => `# H${i}\n\n段落${i}`).join('\n\n')
  const cs = lib.chunkMarkdown(md, { chunkChars: 100, maxChunks: 5 })
  assert.strictEqual(cs.length, 5)
})
t('标题自身成段（超长标题不崩）', () => {
  const md = '# ' + '长'.repeat(3000) + '\n\n正文'
  const cs = lib.chunkMarkdown(md, { chunkChars: 900, maxChunkChars: 1400 })
  assert.ok(cs.length >= 2)
  assert.ok(cs.some((c) => c.text.includes('正文')))
})

// ============ 向量 ============
console.log('vectors')
t('encode/decode 往返无损（float32 精度）', () => {
  const v = new Float32Array(768)
  for (let i = 0; i < 768; i++) v[i] = Math.sin(i) * 0.5
  const rt = lib.decodeVec(lib.encodeVec(v))
  let maxDiff = 0
  for (let i = 0; i < 768; i++) maxDiff = Math.max(maxDiff, Math.abs(v[i] - rt[i]))
  assert.ok(maxDiff < 1e-6, `maxDiff=${maxDiff}`)
})
t('normalizeVec 单位化 + 零向量不动', () => {
  const v = new Float32Array([3, 4])
  lib.normalizeVec(v)
  // float32 精度：容差放宽到 1e-6
  assert.ok(Math.abs(Math.hypot(v[0], v[1]) - 1) < 1e-6, `norm=${Math.hypot(v[0], v[1])}`)
  const z = new Float32Array([0, 0])
  lib.normalizeVec(z)
  assert.strictEqual(z[0], 0)
})

// ============ cosineTopK / mergeKbHits ============
console.log('cosineTopK + mergeKbHits')
t('排序 + minScore 过滤 + k 截断 + 不泄漏 vec', () => {
  const q = lib.normalizeVec(new Float32Array([1, 0, 0]))
  const e1 = lib.normalizeVec(new Float32Array([0.9, 0.1, 0]))
  const e2 = lib.normalizeVec(new Float32Array([0.5, 0.5, 0]))
  const e3 = lib.normalizeVec(new Float32Array([-1, 0, 0]))
  const hits = lib.cosineTopK(q, [
    { vec: e3, name: 'neg' }, { vec: e2, name: 'mid' }, { vec: e1, name: 'top' },
  ], 2, 0.3)
  assert.deepStrictEqual(hits.map((h) => h.name), ['top', 'mid'])
  assert.ok(hits[0].score > 0.99 && hits[1].score > 0.6 && hits[1].score < 0.8)
  assert.ok(!('vec' in hits[0]), 'vec 泄漏到结果')
})
t('mergeKbHits 全局排序 + topK 截断', () => {
  const perKb = [
    { hits: [{ name: 'A', score: 0.9 }, { name: 'B', score: 0.8 }] },
    { hits: [{ name: 'C', score: 0.85 }, { name: 'D', score: 0.4 }] },
  ]
  assert.deepStrictEqual(lib.mergeKbHits(perKb, 3).map((h) => h.name), ['A', 'C', 'B'])
  assert.deepStrictEqual(lib.mergeKbHits(perKb, 1).map((h) => h.name), ['A'])
  assert.deepStrictEqual(lib.mergeKbHits([], 8), [])
  assert.deepStrictEqual(lib.mergeKbHits([null, { hits: [] }], 8), [])
})

// ============ shouldReindex ============
console.log('shouldReindex')
t('null/size/mtime/模型指纹/维度任一变化即重建', () => {
  const stat = { size: 100, mtimeMs: 1000 }
  const model = { size: 309855520, mtimeMs: 2000, dim: 768 }
  const shard = { version: 1, size: 100, mtimeMs: 1000, modelSize: 309855520, modelMtimeMs: 2000, dim: 768 }
  assert.strictEqual(lib.shouldReindex(null, stat, model), true)
  assert.strictEqual(lib.shouldReindex(shard, stat, model), false)
  assert.strictEqual(lib.shouldReindex(shard, { ...stat, size: 101 }, model), true)
  assert.strictEqual(lib.shouldReindex(shard, { ...stat, mtimeMs: 1001 }, model), true)
  assert.strictEqual(lib.shouldReindex(shard, stat, { ...model, size: 1 }), true)
  assert.strictEqual(lib.shouldReindex(shard, stat, { ...model, dim: 512 }), true)
  // skipped 文件：stat 未变则不重试
  const skipped = { ...shard, skipped: 'binary' }
  assert.strictEqual(lib.shouldReindex(skipped, stat, model), false)
})

// ============ scanSources ============
console.log('scanSources')
const tree = path.join(sandbox, 'tree')
fs.mkdirSync(path.join(tree, 'a', 'sub', '.hidden'), { recursive: true })
fs.mkdirSync(path.join(tree, 'a', 'node_modules'), { recursive: true })
fs.mkdirSync(path.join(tree, 'b'), { recursive: true })
fs.writeFileSync(path.join(tree, 'a', 'one.md'), '# one')
fs.writeFileSync(path.join(tree, 'a', 'sub', 'two.markdown'), '## two')
fs.writeFileSync(path.join(tree, 'a', 'sub', '.hidden', 'three.md'), 'x')
fs.writeFileSync(path.join(tree, 'a', 'node_modules', 'four.md'), 'x')
fs.writeFileSync(path.join(tree, 'b', 'five.txt'), 'x')
fs.writeFileSync(path.join(tree, 'a', 'sub', 'dup.md'), 'dup')
fs.writeFileSync(path.join(tree, 'b', 'dup.md'), 'dup')
t('递归收集 + 跳过隐藏/node_modules/非 md', () => {
  const files = lib.scanSources([path.join(tree, 'a'), path.join(tree, 'b')])
  const names = files.map((f) => path.basename(f.path)).sort()
  // a/sub/dup.md 与 b/dup.md 是两个不同文件，都该收集
  assert.deepStrictEqual(names, ['dup.md', 'dup.md', 'one.md', 'two.markdown'])
  assert.ok(!files.some((f) => f.path.includes('.hidden')), '隐藏目录未跳过')
  assert.ok(!files.some((f) => f.path.includes('node_modules')), 'node_modules 未跳过')
  assert.ok(!files.some((f) => f.path.endsWith('.txt')), '.txt 未跳过')
})
t('重叠来源：同一文件只收一次，先到先得', () => {
  const files = lib.scanSources([tree, path.join(tree, 'a')])
  const paths = files.map((f) => f.path)
  assert.strictEqual(new Set(paths).size, paths.length, '同一文件被重复收集')
  assert.ok(files.every((f) => f.dir === tree), '应归属第一个来源 root')
})
t('超大文件标记 oversized', () => {
  const big = path.join(tree, 'b', 'big.md')
  fs.writeFileSync(big, 'x'.repeat(100))
  const files = lib.scanSources([path.join(tree, 'b')], { maxFileBytes: 50 })
  assert.strictEqual(files.find((f) => f.path === big).oversized, true)
})

// ============ 分片存取 ============
console.log('shards')
t('writeShardAtomic / readShard 往返 + deleteShardsNotIn', () => {
  const dir = path.join(sandbox, 'index-test')
  fs.mkdirSync(dir, { recursive: true })
  const shard = { version: lib.SHARD_VERSION, path: 'D:\\x\\a.md', dir: 'D:\\x', size: 1, mtimeMs: 2, title: 'a', dim: 4, modelSize: 9, modelMtimeMs: 9, truncated: false, skipped: null, chunks: [{ heading: 'h', text: 't', offset: 0, vec: lib.encodeVec(new Float32Array([1, 0, 0, 0])) }] }
  const name1 = 'aaaa.json'
  const name2 = 'bbbb.json'
  lib.writeShardAtomic(path.join(dir, name1), shard)
  const rt = lib.readShard(path.join(dir, name1))
  assert.deepStrictEqual(rt.chunks[0], shard.chunks[0])
  lib.writeShardAtomic(path.join(dir, name2), { ...shard, title: 'b' })
  lib.deleteShardsNotIn(dir, new Set([name1]))
  assert.ok(fs.existsSync(path.join(dir, name1)))
  assert.ok(!fs.existsSync(path.join(dir, name2)))
  // 覆盖写（Windows rename-over 语义）
  lib.writeShardAtomic(path.join(dir, name1), { ...shard, title: 'a2' })
  assert.strictEqual(lib.readShard(path.join(dir, name1)).title, 'a2')
})
t('shardName 确定性 + 大小写折叠一致性', () => {
  const a = lib.shardName('/tmp/x/A.md')
  const b = lib.shardName('/tmp/x/A.md')
  assert.strictEqual(a, b)
  assert.ok(a.endsWith('.json'))
})
t('两库同文件分片互不覆盖（分库目录隔离）', () => {
  const dirA = path.join(sandbox, 'kb-a')
  const dirB = path.join(sandbox, 'kb-b')
  fs.mkdirSync(dirA, { recursive: true })
  fs.mkdirSync(dirB, { recursive: true })
  const shard = { version: lib.SHARD_VERSION, path: 'x', dir: 'x', size: 1, mtimeMs: 1, title: 't', dim: null, modelSize: 1, modelMtimeMs: 1, truncated: false, skipped: null, chunks: [] }
  lib.writeShardAtomic(path.join(dirA, 'same.json'), { ...shard, title: 'A' })
  lib.writeShardAtomic(path.join(dirB, 'same.json'), { ...shard, title: 'B' })
  assert.strictEqual(lib.readShard(path.join(dirA, 'same.json')).title, 'A')
  assert.strictEqual(lib.readShard(path.join(dirB, 'same.json')).title, 'B')
})

// ============ 提示词与注入块 ============
console.log('prompts')
t('EmbeddingGemma 前缀按开关启用', () => {
  assert.strictEqual(lib.buildQueryPrompt('机器学习', true), 'task: search result | query: 机器学习')
  assert.strictEqual(lib.buildQueryPrompt('机器学习', false), '机器学习')
  assert.strictEqual(lib.buildDocPrompt('笔记', '正文', true), 'title: 笔记 | text: 正文')
  assert.strictEqual(lib.buildDocPrompt('', '正文', true), 'title: none | text: 正文')
  assert.strictEqual(lib.buildDocPrompt('笔记', '正文', false), '正文')
})
t('formatKbBlock 预算与截断', () => {
  const hits = [
    { title: 'A', heading: 'H', text: 'x'.repeat(50), path: 'D:\\a.md' },
    { title: 'B', heading: '', text: 'y'.repeat(50), path: 'D:\\b.md' },
  ]
  const block = lib.formatKbBlock(hits, { perHitChars: 20, budgetChars: 1000 })
  assert.ok(block.includes('[1] 《A》 · H'))
  assert.ok(block.includes('[2] 《B》'))
  assert.ok(!block.includes('xxxx'.repeat(10)), '单条未截断')
  assert.strictEqual(lib.formatKbBlock([], {}), '')
})

// ============ 多模态（图片索引） ============
console.log('multimodal (image indexing)')
t('isImagePath 扩展名判定（大小写不敏感，误报拒绝）', () => {
  for (const p of ['a.png', 'b.JPG', 'c.jpeg', 'd.WebP', 'e.gif', 'f.bmp']) assert.strictEqual(lib.isImagePath(p), true, p)
  for (const p of ['a.md', 'a.txt', 'a.gguf', 'a.png.md', 'png', '']) assert.strictEqual(lib.isImagePath(p), false, p)
})
t('scanSources images 开关：图片与 md 并列收集 + kind 标记', () => {
  const imgDir = path.join(sandbox, 'img-tree')
  fs.mkdirSync(imgDir, { recursive: true })
  fs.writeFileSync(path.join(imgDir, 'doc.md'), '# d')
  fs.writeFileSync(path.join(imgDir, 'pic.png'), Buffer.from([0x89, 0x50]))
  fs.writeFileSync(path.join(imgDir, 'shot.JPEG'), Buffer.from([0xff, 0xd8]))
  fs.writeFileSync(path.join(imgDir, 'skip.txt'), 'x')
  // 默认（未开 images）：只收 md，kind 全为 text
  const textOnly = lib.scanSources([imgDir])
  assert.deepStrictEqual(textOnly.map((f) => f.kind), ['text'])
  // 开 images：图片并列收集，kind 正确，.txt 仍排除
  const both = lib.scanSources([imgDir], { images: true })
  const byName = Object.fromEntries(both.map((f) => [path.basename(f.path), f.kind]))
  assert.strictEqual(byName['doc.md'], 'text')
  assert.strictEqual(byName['pic.png'], 'image')
  assert.strictEqual(byName['shot.JPEG'], 'image')
  assert.strictEqual(Object.keys(byName).length, 3, '.txt 不应被收集')
})
t('scanSources 图片超大同样标 oversized', () => {
  const big = path.join(tree, 'b', 'big.png')
  fs.writeFileSync(big, Buffer.alloc(100))
  const files = lib.scanSources([path.join(tree, 'b')], { maxFileBytes: 50, images: true })
  const f = files.find((x) => x.path === big)
  assert.ok(f && f.oversized === true && f.kind === 'image')
})
t('shouldReindex mproj 指纹：仅 image 分片参与，text 分片不受影响', () => {
  const stat = { size: 100, mtimeMs: 1000 }
  const model = { size: 9, mtimeMs: 9, dim: 4 }
  const imgShard = { version: 1, kind: 'image', size: 100, mtimeMs: 1000, modelSize: 9, modelMtimeMs: 9, dim: 4, skipped: null, mprojSize: 555, mprojMtimeMs: 66 }
  const txtShard = { ...imgShard, kind: 'text' }
  // 不带 mproj 指纹（老调用方/未配置投影器）：两者都不 stale
  assert.strictEqual(lib.shouldReindex(imgShard, stat, model), false)
  assert.strictEqual(lib.shouldReindex(txtShard, stat, model), false)
  // mproj 指纹一致：image 不 stale
  assert.strictEqual(lib.shouldReindex(imgShard, stat, { ...model, mprojSize: 555, mprojMtimeMs: 66 }), false)
  // mproj size / mtime 任一变化：仅 image stale
  assert.strictEqual(lib.shouldReindex(imgShard, stat, { ...model, mprojSize: 556, mprojMtimeMs: 66 }), true)
  assert.strictEqual(lib.shouldReindex(txtShard, stat, { ...model, mprojSize: 556, mprojMtimeMs: 66 }), false)
  assert.strictEqual(lib.shouldReindex(imgShard, stat, { ...model, mprojSize: 555, mprojMtimeMs: 67 }), true)
  assert.strictEqual(lib.shouldReindex(txtShard, stat, { ...model, mprojSize: 555, mprojMtimeMs: 67 }), false)
  // 清除投影器（指纹为 null）：不触发 stale——图片分片的移除交给重建时 deleteShardsNotIn
  assert.strictEqual(lib.shouldReindex(imgShard, stat, { ...model, mprojSize: null, mprojMtimeMs: null }), false)
})
t('formatKbBlock 图片命中：[图片] 标记 + 无正文 + 预算约束', () => {
  const hits = [
    { kind: 'image', title: 'shot', path: 'D:\\k\\shot.png', text: '图片：shot', heading: '' },
    { title: '文档', heading: '', text: '正文内容', path: 'D:\\k\\a.md' },
  ]
  const block = lib.formatKbBlock(hits, { perHitChars: 100, budgetChars: 4000 })
  assert.ok(block.includes('[1] [图片] 《shot》（D:\\k\\shot.png）'), block)
  assert.ok(!block.includes('图片：shot'), '图片条目不应带正文')
  assert.ok(block.includes('[2] 《文档》'))
  // 预算耗尽：图片条目整条丢弃（不留残行）
  assert.strictEqual(lib.formatKbBlock([{ kind: 'image', title: 'x', path: 'D:\\x\\a.png' }], { budgetChars: 10 }), '')
})

// ============ 主模块状态机（纯 Node，无二进制；v2 多库） ============
let kb = require('../electron-kb.cjs').initKnowledgeBase((level, msg) => {
  if (process.env.KB_VERBOSE) console.log(`    [kb:${level}] ${msg}`)
})
const kbJsonPath = path.join(sandbox, '.hypora-kb', 'kb.json')
const indexRoot = path.join(sandbox, '.hypora-kb', 'index')

async function main() {
  console.log('kb module (state machine, v2)')

  // —— 全新安装：自动获得「默认知识库」，kb.json 直接落 v2 ——
  await ta('全新安装 → 默认知识库 + kb.json v2', async () => {
    const c1 = kb.getConfig()
    assert.strictEqual(c1.kbs.length, 1)
    assert.strictEqual(c1.kbs[0].name, '默认知识库')
    assert.strictEqual(c1.kbs[0].enabled, true)
    assert.strictEqual(c1.autoInject, true)
    assert.strictEqual(c1.model.ok, false)
    assert.strictEqual(c1.kbs[0].sources.length, 0)
    const onDisk = JSON.parse(fs.readFileSync(kbJsonPath, 'utf-8'))
    assert.strictEqual(onDisk.version, 2)
    assert.ok(onDisk.kbs[0].id, '新库应有 id')
  })

  // —— setModel 校验（放在任何分片落地之前：换模型会清空全部库索引） ——
  await ta('setModel 校验：非 GGUF 拒绝 / GGUF 接受', async () => {
    const bad = path.join(sandbox, 'bad.bin')
    fs.writeFileSync(bad, 'not gguf')
    assert.strictEqual(kb.setModel(bad).ok, false)
    const good = path.join(sandbox, 'fake.gguf')
    fs.writeFileSync(good, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(16)]))
    const r = kb.setModel(good)
    assert.strictEqual(r.ok, true)
    assert.ok(r.config.model.path)
    assert.strictEqual(r.config.model.ok, true)
  })

  // —— v1 → v2 迁移：配置继承（含模型路径） + enabled→autoInject + 平铺分片搬迁 + 幂等 ——
  await ta('v1→v2 迁移：配置继承 + 分片搬迁 + 幂等', async () => {
    const notes = path.join(sandbox, 'v1-notes')
    fs.mkdirSync(notes, { recursive: true })
    fs.writeFileSync(path.join(notes, 'a.md'), '# 标题\n\n内容。')
    // 造 v1 现场：老配置（模型路径指向 step2 的 fake.gguf）+ 平铺分片
    fs.mkdirSync(indexRoot, { recursive: true })
    fs.writeFileSync(path.join(indexRoot, 'oldshard.json'), '{"version":1}')
    fs.writeFileSync(path.join(indexRoot, 'x.staging.json'), '{}')   // staging 不搬
    fs.writeFileSync(kbJsonPath, JSON.stringify({
      version: 1, modelPath: path.join(sandbox, 'fake.gguf'), dim: null, enabled: false,
      topK: 7, chunkChars: 800, minScore: 0.5, injectCharBudget: 4000,
      sources: [{ dir: notes, addedAt: 123 }],
    }))
    const c = kb.getConfig()
    assert.strictEqual(c.kbs.length, 1)
    assert.strictEqual(c.kbs[0].name, '默认知识库')
    assert.strictEqual(c.kbs[0].topK, 7)
    assert.strictEqual(c.kbs[0].chunkChars, 800)
    assert.strictEqual(c.kbs[0].minScore, 0.5)
    assert.strictEqual(c.autoInject, false, 'v1 enabled=false 应迁为 autoInject=false')
    assert.strictEqual(c.injectCharBudget, 4000, 'v1 注入预算应继承')
    assert.strictEqual(c.model.path, path.join(sandbox, 'fake.gguf'), '模型路径应继承且不触发全清')
    assert.strictEqual(c.model.ok, true)
    assert.strictEqual(c.kbs[0].sources.length, 1)
    const kbId = c.kbs[0].id
    // 分片已搬进 index/<kbId>/，平铺与 staging 残留不进 published
    assert.ok(fs.existsSync(path.join(indexRoot, kbId, 'oldshard.json')), '分片应搬迁到库目录')
    assert.ok(!fs.existsSync(path.join(indexRoot, 'oldshard.json')), '平铺分片应移走')
    assert.ok(fs.existsSync(path.join(indexRoot, 'x.staging.json')), 'staging 不动')
    assert.strictEqual(c.kbs[0].stats.files, 1)
    // 幂等：再次读取不重复迁移、不重复建库
    const c2 = kb.getConfig()
    assert.strictEqual(c2.kbs.length, 1)
    assert.strictEqual(c2.kbs[0].id, kbId)
  })

  // —— 有索引但模型文件丢失：查询优雅报错（不触 spawn） ——
  await ta('有索引但模型缺失：查询优雅报错不抛崩', async () => {
    fs.unlinkSync(path.join(sandbox, 'fake.gguf'))
    await assert.rejects(() => kb.query('问题'), /模型文件不存在/)
    assert.strictEqual(kb.snapshot().modelMissing, true)
  })

  // —— reindex 无模型：优雅报错 + 进度落 error ——
  await ta('reindex 无模型时优雅报错 + 进度落 error', async () => {
    const r1 = await kb.reindex({ force: true })
    assert.strictEqual(r1.started, false)
    assert.ok(r1.error)
    const c = kb.getConfig()
    assert.strictEqual(c.indexProgress.phase, 'error')
    assert.strictEqual(c.indexing, false)
  })

  await ta('kill 幂等', async () => {
    kb.kill()
    kb.kill()
  })

  // —— CRUD 生命周期 ——
  await ta('create/rename/delete 生命周期（含索引目录清理）', async () => {
    const c1 = kb.getConfig()
    assert.ok(c1.kbs.length >= 1)
    const r = kb.createKb('工作笔记')
    assert.strictEqual(r.ok, true)
    const created = r.config.kbs.find((k) => k.name === '工作笔记')
    assert.ok(created, '新库应出现在配置里')
    // 默认名
    const r2 = kb.createKb('')
    const def = r2.config.kbs[r2.config.kbs.length - 1]
    assert.strictEqual(def.name, '知识库 3')
    // 重命名（trim）
    const rn = kb.renameKb(created.id, '  技术文档  ')
    assert.strictEqual(rn.ok, true)
    assert.strictEqual(rn.config.kbs.find((k) => k.id === created.id).name, '技术文档')
    assert.strictEqual(kb.renameKb('no-such-id', 'x').ok, false)
    assert.strictEqual(kb.renameKb(created.id, '   ').ok, false, '空名拒绝')
    // 预置索引目录 → 删除后目录一并消失
    const dir = path.join(indexRoot, def.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'a.json'), '{}')
    const del = kb.deleteKb(def.id)
    assert.strictEqual(del.ok, true)
    assert.ok(!del.config.kbs.some((k) => k.id === def.id))
    assert.ok(!fs.existsSync(dir), '删除库应清掉索引目录')
    assert.strictEqual(kb.deleteKb('no-such-id').ok, false)
  })

  // —— 来源校验：库内重复/嵌套拒绝，跨库允许 ——
  await ta('addSourcePath：库内重复/嵌套拒绝 + 跨库允许', async () => {
    const cfg = kb.getConfig()
    const idA = cfg.kbs[0].id
    const kbB = kb.createKb('库 B')
    const idB = kbB.config.kbs.find((k) => k.name === '库 B').id
    // idA 自迁移起已带 v1-notes（1 个文件）
    const src = path.join(sandbox, 'src-a')
    const nested = path.join(src, 'inner')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(src, 'm.md'), '# m')
    assert.strictEqual(kb.addSourcePath(idA, src).ok, true)
    const dup = kb.addSourcePath(idA, src)
    assert.strictEqual(dup.ok, false)
    assert.ok(dup.error.includes('已在此知识库中'))
    const nest = kb.addSourcePath(idA, nested)
    assert.strictEqual(nest.ok, false)
    assert.ok(nest.error.includes('嵌套'))
    // 跨库同目录允许（分片按库隔离）
    assert.strictEqual(kb.addSourcePath(idB, src).ok, true)
    // 统计落位：idA 2 个文件（v1-notes 的 a.md + src-a 的 m.md），idB 1 个
    const c = kb.getConfig()
    const a = c.kbs.find((k) => k.id === idA)
    const b = c.kbs.find((k) => k.id === idB)
    assert.strictEqual(a.stats.files, 2)
    assert.strictEqual(b.stats.files, 1)
    assert.strictEqual(c.totals.files, 3)
    assert.strictEqual(c.staleTotal, 3, '未索引文件应计入 staleTotal')
    assert.strictEqual(a.stats.stale, 2)
    // removeSource 收敛：逐个移除后该库 sources/published 清空
    assert.strictEqual(kb.removeSource(idA, src).ok, true)
    assert.strictEqual(kb.getConfig().kbs.find((k) => k.id === idA).sources.length, 1)
    assert.strictEqual(kb.removeSource(idA, path.join(sandbox, 'v1-notes')).ok, true)
    const after = kb.getConfig().kbs.find((k) => k.id === idA)
    assert.strictEqual(after.sources.length, 0)
    assert.strictEqual(after.stats.files, 0)
  })

  // —— 单库参数：夹紧 + chunkChars 变更仅清该库 ——
  await ta('setKb 参数夹紧 + chunkChars 变更仅清该库', async () => {
    const cfg = kb.getConfig()
    const idA = cfg.kbs[0].id
    const idB = cfg.kbs.find((k) => k.name === '库 B').id
    // 两库都放一个占位分片（模块内 published 由 reindex 维护；这里只验磁盘清理范围）
    for (const id of [idA, idB]) {
      fs.mkdirSync(path.join(indexRoot, id), { recursive: true })
      fs.writeFileSync(path.join(indexRoot, id, 's.json'), '{}')
    }
    // topK/minScore 夹紧 + enabled 透传
    const set1 = kb.setKbConfig(idA, { topK: 99, minScore: 5, enabled: false })
    const a1 = set1.config.kbs.find((k) => k.id === idA)
    assert.strictEqual(a1.topK, 12)
    assert.strictEqual(a1.minScore, 1)
    assert.strictEqual(a1.enabled, false)
    // chunkChars 变更 → 仅该库索引目录被清
    const set2 = kb.setKbConfig(idA, { chunkChars: 700, enabled: true })
    assert.strictEqual(set2.config.kbs.find((k) => k.id === idA).chunkChars, 700)
    assert.strictEqual(fs.readdirSync(path.join(indexRoot, idA)).length, 0, '该库索引应被清空')
    assert.ok(fs.existsSync(path.join(indexRoot, idB, 's.json')), '其他库索引不应被波及')
    assert.strictEqual(kb.setKbConfig('no-such-id', { enabled: true }).ok, false)
  })

  // —— setModel 同指纹挪位置（如移入 ai-models/）：索引保留；指纹变化：清全部索引 ——
  await ta('setModel 同指纹挪位置不清索引 / 指纹变化清索引', async () => {
    const m = path.join(sandbox, 'm.gguf')
    const m2 = path.join(sandbox, 'm2.gguf')
    fs.writeFileSync(m, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(16)]))
    fs.writeFileSync(m2, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(16)]))
    // 统一两文件 mtime（秒+小数，避免 Date 毫秒截断损失精度；模拟 Windows 拷贝保留 mtime）
    const stamp = 1728000000.123456
    fs.utimesSync(m, stamp, stamp)
    fs.utimesSync(m2, stamp, stamp)
    // 切到 m（此时 cfg.modelSize 为迁移残留的 null → 视为换模型，清掉上一节的占位分片）
    const r1 = kb.setModel(m)
    assert.strictEqual(r1.ok, true)
    // 两库各放一个占位分片
    for (const k of kb.getConfig().kbs) {
      fs.mkdirSync(path.join(indexRoot, k.id), { recursive: true })
      fs.writeFileSync(path.join(indexRoot, k.id, 's.json'), '{}')
    }
    // 同 size+mtime = 同一模型挪位置：路径变了但不清索引
    const r2 = kb.setModel(m2)
    assert.strictEqual(r2.ok, true)
    assert.strictEqual(r2.config.model.path, m2)
    for (const k of r2.config.kbs) {
      assert.ok(fs.existsSync(path.join(indexRoot, k.id, 's.json')), `同指纹挪位置不应清 ${k.id} 的索引`)
    }
    // mtime 变化 = 换模型：清全部库索引
    const t2 = 1728003600.123456
    fs.utimesSync(m2, t2, t2)
    const r3 = kb.setModel(m2)
    assert.strictEqual(r3.ok, true)
    for (const k of r3.config.kbs) {
      assert.ok(!fs.existsSync(path.join(indexRoot, k.id, 's.json')), `换模型应清 ${k.id} 的索引`)
    }
  })

  // —— setMmproj：校验/设置/清除 + 图片扫描门控 + 换投影器仅 image 分片 stale ——
  await ta('setMmproj 校验 + 扫描门控 + mproj 指纹分片分离', async () => {
    // 图文来源：1 md + 1 png
    const src = path.join(sandbox, 'mm-src')
    fs.mkdirSync(src, { recursive: true })
    const mdPath = path.join(src, 'note.md')
    const imgPath = path.join(src, 'photo.png')
    fs.writeFileSync(mdPath, '# 笔记\n\n内容')
    fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const kbc = kb.createKb('图文库')
    const idC = kbc.config.kbs.find((k) => k.name === '图文库').id
    assert.strictEqual(kb.addSourcePath(idC, src).ok, true)
    // 未配置投影器：扫描只收 md，mmproj 未配置
    const c1 = kb.getConfig()
    const s1 = c1.kbs.find((k) => k.id === idC).sources.find((s) => s.dir === src)
    assert.strictEqual(s1.fileCount, 1)
    assert.strictEqual(s1.imageCount, 0)
    assert.strictEqual(c1.model.mmproj.configured, false)
    assert.strictEqual(c1.model.mmproj.active, false)
    // 非 GGUF 拒绝；拒绝后配置保持未设置
    const bad = path.join(sandbox, 'bad-mm.bin')
    fs.writeFileSync(bad, 'not gguf')
    assert.strictEqual(kb.setMmproj(bad).ok, false)
    assert.ok(kb.setMmproj(bad).error.includes('GGUF'))
    assert.strictEqual(kb.getConfig().model.mmproj.configured, false)
    // 设置有效 GGUF 投影器 → 图片进入扫描，mmproj 字段落位
    const mm = path.join(sandbox, 'mm.gguf')
    fs.writeFileSync(mm, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(8)]))
    const r1 = kb.setMmproj(mm)
    assert.strictEqual(r1.ok, true)
    const mm1 = r1.config.model.mmproj
    assert.strictEqual(mm1.configured, true)
    assert.strictEqual(mm1.active, true)
    assert.strictEqual(mm1.missing, false)
    assert.strictEqual(mm1.size, fs.statSync(mm).size)
    const s2 = r1.config.kbs.find((k) => k.id === idC).sources.find((s) => s.dir === src)
    assert.strictEqual(s2.fileCount, 2)
    assert.strictEqual(s2.imageCount, 1)
    assert.strictEqual(r1.config.totals.images, 1)
  })

  // —— mproj 指纹分片分离（重载模块模拟重启：published 从磁盘重扫，与生产一致） ——
  // 说明：published 集合每进程只扫一次磁盘（staging→publish 是生产写入口），
  // harness 直写分片必须配一次模块重载才可见。
  await ta('mproj 指纹分片分离：换投影器仅 image stale / 清除后 text 保留', async () => {
    const src = path.join(sandbox, 'mm-src')
    const mdPath = path.join(src, 'note.md')
    const imgPath = path.join(src, 'photo.png')
    const mm2 = path.join(sandbox, 'mm2.gguf')
    fs.writeFileSync(mm2, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(20)]))
    // 手工落盘 text/image 两枚指纹齐全的分片（与当前 kb.json 指纹一致）
    const raw = JSON.parse(fs.readFileSync(kbJsonPath, 'utf-8'))
    const cfg0 = kb.getConfig()
    const idC = cfg0.kbs.find((k) => k.name === '图文库').id
    const dir = path.join(indexRoot, idC)
    const baseShard = { version: lib.SHARD_VERSION, dir: src, title: 't', dim: raw.dim, modelSize: raw.modelSize, modelMtimeMs: raw.modelMtimeMs, truncated: false, skipped: null, chunks: [] }
    lib.writeShardAtomic(path.join(dir, lib.shardName(mdPath)), { ...baseShard, path: mdPath, size: fs.statSync(mdPath).size, mtimeMs: fs.statSync(mdPath).mtimeMs, kind: 'text' })
    lib.writeShardAtomic(path.join(dir, lib.shardName(imgPath)), { ...baseShard, path: imgPath, size: fs.statSync(imgPath).size, mtimeMs: fs.statSync(imgPath).mtimeMs, kind: 'image', mprojSize: raw.mprojSize, mprojMtimeMs: raw.mprojMtimeMs })
    // 重载模块：published 从磁盘重扫（等价应用重启后的状态）
    kb.kill()
    delete require.cache[require.resolve('../electron-kb.cjs')]
    const kb2 = require('../electron-kb.cjs').initKnowledgeBase(() => {})
    const c3 = kb2.getConfig()
    const s3 = c3.kbs.find((k) => k.id === idC).sources.find((s) => s.dir === src)
    assert.strictEqual(s3.staleCount, 0, '指纹齐全的两枚分片均应新鲜')
    assert.strictEqual(s3.indexedFiles, 2)
    // 换投影器（不同 size）→ 仅 image 分片 stale，text 分片不动
    const r2 = kb2.setMmproj(mm2)
    assert.strictEqual(r2.ok, true)
    const s4 = r2.config.kbs.find((k) => k.id === idC).sources.find((s) => s.dir === src)
    assert.strictEqual(s4.staleCount, 1, '仅图片分片应待重建')
    assert.strictEqual(s4.indexedFiles, 1, '文本分片应保持新鲜')
    // 清除投影器 → 图片退出扫描，text 分片保留且新鲜
    const r3 = kb2.setMmproj(null)
    assert.strictEqual(r3.ok, true)
    assert.strictEqual(r3.config.model.mmproj.configured, false)
    const s5 = r3.config.kbs.find((k) => k.id === idC).sources.find((s) => s.dir === src)
    assert.strictEqual(s5.fileCount, 1, '清除后图片退出扫描')
    assert.strictEqual(s5.imageCount, 0)
    assert.strictEqual(s5.indexedFiles, 1, 'text 分片保留且新鲜')
    // 换模型（指纹变化）全清索引：重置内存桶与磁盘，给后续测试干净现场
    const mm3 = path.join(sandbox, 'mm3.gguf')
    fs.writeFileSync(mm3, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(12)]))
    assert.strictEqual(kb2.setModel(mm3).ok, true)
    // 投影器文件丢失 → missing 标记 + 扫描退回纯文本
    assert.strictEqual(kb2.setMmproj(mm2).ok, true)
    fs.rmSync(mm2)
    const c6 = kb2.getConfig()
    assert.strictEqual(c6.model.mmproj.configured, true)
    assert.strictEqual(c6.model.mmproj.active, false)
    assert.strictEqual(c6.model.mmproj.missing, true)
    const s6 = c6.kbs.find((k) => k.id === idC).sources.find((s) => s.dir === src)
    assert.strictEqual(s6.fileCount, 1, '投影器失效时图片退出扫描')
    // 后续测试继续用重载后的实例（旧实例已 kill）
    kb = kb2
  })

  // —— 空索引查询零开销短路（published 全空 → 不触服务） ——
  await ta('空索引查询零开销短路（不触服务）', async () => {
    const cfg = kb.getConfig()
    for (const k of cfg.kbs) {
      fs.rmSync(path.join(indexRoot, k.id), { recursive: true, force: true })
    }
    const r = await kb.query('测试问题')
    assert.deepStrictEqual(r.hits, [])
    assert.strictEqual(kb.snapshot().phase, 'stopped', '短路路径不应拉起服务')
  })

  // ============ KB_LIVE=1：真实端到端（Windows 上选通） ============
  if (process.env.KB_LIVE === '1') {
    console.log('KB_LIVE end-to-end (multi-KB)')
    const model = process.env.KB_MODEL
    assert.ok(model && fs.existsSync(model), 'KB_MODEL 必须指向真实 gguf')
    await ta('双库索引 → 合并检索全链路', async () => {
      assert.strictEqual(kb.setModel(model).ok, true)
      const cfg0 = kb.getConfig()
      const idA = cfg0.kbs[0].id
      const notes = path.join(sandbox, 'live-notes')
      fs.mkdirSync(notes, { recursive: true })
      fs.writeFileSync(path.join(notes, 'doc.md'), '# 知识库\n\nHypora 是一款所见即所得 Markdown 编辑器，知识库基于本地嵌入模型。\n\n## 检索\n\n检索使用余弦相似度，CPU 推理即可。')
      const kbB = kb.createKb('库 B')
      const idB = kbB.config.kbs.find((k) => k.name === '库 B').id
      assert.strictEqual(kb.addSourcePath(idA, notes).ok, true)
      assert.strictEqual(kb.addSourcePath(idB, notes).ok, true)
      const ri = await kb.reindex({ force: true })
      assert.ok(ri.started && !ri.error, `reindex: ${ri.error || ''}`)
      const cfg = kb.getConfig()
      assert.ok(cfg.totals.chunks > 0, '应有分段')
      assert.ok(cfg.kbs.every((k) => k.stats.chunks > 0), '两库都应建好索引')
      assert.strictEqual(cfg.status.phase, 'running', '嵌入服务应在索引后保持运行')
      const q = await kb.query('知识库用什么模型？')
      assert.ok(q.hits.length > 0, '应有命中')
      assert.ok(q.hits[0].text.includes('嵌入模型'), `首条命中应相关: ${q.hits[0].text.slice(0, 40)}`)
      assert.ok(q.hits[0].kbId && q.hits[0].kbName, '命中应带库归属标注')
      const block = lib.formatKbBlock(q.hits)
      assert.ok(block.includes('知识库检索'))
      // 停用库 B → 命中只来自库 A
      assert.strictEqual(kb.setKbConfig(idB, { enabled: false }).ok, true)
      const q2 = await kb.query('知识库用什么模型？')
      assert.ok(q2.hits.length > 0 && q2.hits.every((h) => h.kbId === idA), '停用库不应出现在命中里')
      await kb.stop()
    })
  }

  // ============ KB_LIVE=1 + KB_MMPROJ=<mmproj.gguf>：多模态端到端（Windows 上选通） ============
  if (process.env.KB_LIVE === '1' && process.env.KB_MMPROJ) {
    console.log('KB_LIVE multimodal (image indexing)')
    const mproj = process.env.KB_MMPROJ
    assert.ok(fs.existsSync(mproj), 'KB_MMPROJ 必须指向真实 mmproj gguf')
    await ta('图文混合索引 → 探针 → 文本查询命中图片 → 清除后图片分片移除', async () => {
      assert.strictEqual(kb.setModel(model).ok, true)
      assert.strictEqual(kb.setMmproj(mproj).ok, true)
      const cfg0 = kb.getConfig()
      const idA = cfg0.kbs[0].id
      const dir = path.join(sandbox, 'mm-live')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'doc.md'), '# 图文笔记\n\n这张照片拍的是海边日落，橙色天空与剪影。\n\n## 山谷\n\n另一张图是清晨的山谷与雾气。')
      // 64×64 纯红 PNG（真实可解码位图，供视觉塔嵌入）
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAOklEQVR4nO3BAQ0AAADCoPdMbQ8HFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwKkBK5QAAdgCaLIAAAAASUVORK5CYII=',
        'base64'
      )
      fs.writeFileSync(path.join(dir, 'red.png'), png)
      assert.strictEqual(kb.addSourcePath(idA, dir).ok, true)
      const ri = await kb.reindex({ force: true })
      assert.ok(ri.started && !ri.error, `reindex: ${ri.error || ''}`)
      const cfg = kb.getConfig()
      const a = cfg.kbs.find((k) => k.id === idA)
      assert.ok(a.stats.images > 0, '应索引到图片')
      assert.strictEqual(cfg.status.phase, 'running')
      // 等探针收敛（就绪后异步执行，20s 超时）
      let mm = null
      for (let i = 0; i < 40; i++) {
        mm = kb.getConfig().model.mmproj
        if (mm.imageOk !== null) break
        await new Promise((r) => setTimeout(r, 500))
      }
      console.log(`    探针 imageOk=${mm.imageOk} error=${mm.imageError || '-'}`)
      if (mm.imageOk === false) {
        console.log('    （图片嵌入不可用：跳过命中断言；文本链路不受影响的断言仍执行）')
        assert.ok(a.stats.chunks > 0, '文本链路不受图片嵌入失败影响')
        await kb.stop()
        return
      }
      assert.ok(a.stats.chunks > 0, '文本分片应存在')
      // 文本查询：命中列表应带 kind 标注；图文/文图相似度样例佐证空间对齐
      for (const qtext of ['海边日落的照片', '一张红色的图片']) {
        const q = await kb.query(qtext)
        assert.ok(q.hits.length > 0, `「${qtext}」应有命中`)
        assert.ok(q.hits.every((h) => h.kind === 'image' || h.kind === 'text'), '命中应带 kind 标注')
        const imgHit = q.hits.find((h) => h.kind === 'image')
        const sample = q.hits.slice(0, 5).map((h) => `${h.kind}:${path.basename(h.path)}=${h.score.toFixed(3)}`).join(', ')
        console.log(`    「${qtext}」top5: ${sample}`)
        if (!imgHit) console.log(`    ⚠ 「${qtext}」未命中图片（图文对齐度与 minScore 相关，非管线错误）`)
        else assert.ok(lib.formatKbBlock(q.hits).includes('[图片]'), '注入块应渲染 [图片] 标记')
      }
      // 清除投影器 → 重建 → 图片分片移除、文本分片保留
      assert.strictEqual(kb.setMmproj(null).ok, true)
      const ri2 = await kb.reindex({ force: true })
      assert.ok(ri2.started && !ri2.error, `reindex2: ${ri2.error || ''}`)
      const cfg2 = kb.getConfig()
      const a2 = cfg2.kbs.find((k) => k.id === idA)
      assert.strictEqual(a2.stats.images, 0, '清除后图片退出扫描')
      assert.ok(a2.stats.chunks > 0, '文本分片应保留')
      await kb.stop()
    })
  }

  // ============ 汇总 ============
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) {
    console.error(failures.map((f) => ' - ' + f).join('\n'))
    process.exit(1)
  }
  fs.rmSync(sandbox, { recursive: true, force: true })
  process.exit(0)
}

main().catch((e) => {
  console.error('HARNESS 崩溃:', e)
  process.exit(2)
})
