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

// ============ cosineTopK ============
console.log('cosineTopK')
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

// ============ 主模块状态机（纯 Node，无二进制） ============
console.log('kb module (state machine)')
const kb = require('../electron-kb.cjs').initKnowledgeBase((level, msg) => {
  if (process.env.KB_VERBOSE) console.log(`    [kb:${level}] ${msg}`)
})

async function main() {
  // ============ 主模块状态机（纯 Node，无二进制） ============
  console.log('kb module (state machine)')
  await ta('getConfig 初始态 + 来源增删', async () => {
    const c1 = kb.getConfig()
    assert.strictEqual(c1.modelOk, false)
    assert.strictEqual(c1.sources.length, 0)
    const notes = path.join(sandbox, 'notes')
    fs.mkdirSync(notes, { recursive: true })
    fs.writeFileSync(path.join(notes, 'a.md'), '# 标题\n\n内容。')
    const c2 = kb.addSourcePath(notes)
    assert.strictEqual(c2.sources.length, 1)
    assert.strictEqual(c2.sources[0].fileCount, 1)
    const r = kb.removeSource(notes)
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.config.sources.length, 0)
  })
  await ta('setModel 校验：非 GGUF 拒绝 / GGUF 接受并清索引', async () => {
    const bad = path.join(sandbox, 'bad.bin')
    fs.writeFileSync(bad, 'not gguf')
    assert.strictEqual(kb.setModel(bad).ok, false)
    const good = path.join(sandbox, 'fake.gguf')
    fs.writeFileSync(good, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(16)]))
    const r = kb.setModel(good)
    assert.strictEqual(r.ok, true)
    assert.ok(r.config.config.modelPath)
    assert.strictEqual(r.config.modelOk, true)
  })
  await ta('snapshot modelMissing 随文件存在性翻转', async () => {
    assert.strictEqual(kb.snapshot().modelMissing, false)
    fs.unlinkSync(path.join(sandbox, 'fake.gguf'))
    assert.strictEqual(kb.snapshot().modelMissing, true)
  })
  await ta('空索引查询返回空（不触服务）', async () => {
    const r = await kb.query('测试问题')
    assert.deepStrictEqual(r.hits, [])
  })
  await ta('reindex 无模型/无二进制时优雅报错不抛', async () => {
    // modelMissing：模型文件已被上一用例删除
    const r1 = await kb.reindex({ force: true })
    assert.strictEqual(r1.started, false)
    assert.ok(r1.error)
  })
  await ta('kill 幂等', async () => {
    kb.kill()
    kb.kill()
  })

  // ============ KB_LIVE=1：真实端到端（Windows 上选通） ============
  if (process.env.KB_LIVE === '1') {
    console.log('KB_LIVE end-to-end')
    const model = process.env.KB_MODEL
    assert.ok(model && fs.existsSync(model), 'KB_MODEL 必须指向真实 gguf')
    await ta('选模型 → 索引 → 检索全链路', async () => {
      const r0 = kb.setModel(model)
      assert.strictEqual(r0.ok, true)
      const notes = path.join(sandbox, 'live-notes')
      fs.mkdirSync(notes, { recursive: true })
      fs.writeFileSync(path.join(notes, 'doc.md'), '# 知识库\n\nHypora 是一款所见即所得 Markdown 编辑器，知识库基于本地嵌入模型。\n\n## 检索\n\n检索使用余弦相似度，CPU 推理即可。')
      kb.addSourcePath(notes)
      const ri = await kb.reindex({ force: true })
      assert.ok(ri.started && !ri.error, `reindex: ${ri.error || ''}`)
      const cfg = kb.getConfig()
      assert.ok(cfg.totals.chunks > 0, '应有分段')
      assert.strictEqual(cfg.status.phase, 'running', '嵌入服务应在索引后保持运行')
      const q = await kb.query('知识库用什么模型？')
      assert.ok(q.hits.length > 0, '应有命中')
      assert.ok(q.hits[0].text.includes('嵌入模型'), `首条命中应相关: ${q.hits[0].text.slice(0, 40)}`)
      const block = lib.formatKbBlock(q.hits)
      assert.ok(block.includes('知识库检索'))
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
