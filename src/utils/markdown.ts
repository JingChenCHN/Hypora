import { marked } from 'marked'
import Prism from 'prismjs'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import footnote from 'marked-footnote'

// Prism 语言组件（prismjs/components/*）是 CJS，内部直接用未声明的全局 `Prism`，
// 依赖 prismjs core 求值时挂的 `_self.Prism`。静态 import 时 rolldown 把它们 ESM 化后，
// 求值顺序不保证 core 先于语言组件，会抛 "Prism is not defined"（分包后尤其明显）。
// 改为运行时动态加载：core（上面静态 import）求值并挂全局后，再加载语言组件。
;(globalThis as any).Prism = Prism

const PRISM_LANGS = [
  'prismjs/components/prism-javascript',
  'prismjs/components/prism-typescript',
  'prismjs/components/prism-python',
  'prismjs/components/prism-java',
  'prismjs/components/prism-go',
  'prismjs/components/prism-c',
  'prismjs/components/prism-cpp',
  'prismjs/components/prism-css',
  'prismjs/components/prism-json',
  'prismjs/components/prism-yaml',
  'prismjs/components/prism-bash',
  'prismjs/components/prism-markup',
  'prismjs/components/prism-sql'
]
let prismLangsPromise: Promise<void> | null = null
// 预加载所有 Prism 语言组件（幂等，返回同一个 Promise）。加载完成前 Prism 高亮降级为纯文本（不报错）。
export function ensurePrismLangs(): Promise<void> {
  if (!prismLangsPromise) {
    prismLangsPromise = Promise.all(PRISM_LANGS.map(p => import(p))).then(() => {}, () => {})
  }
  return prismLangsPromise
}

// 配置marked
marked.setOptions({
  gfm: true,
  breaks: true,
  pedantic: false,
  sanitize: false,
  smartypants: false,
  highlight: function(code, lang) {
    let language = lang || 'plaintext'
    if (language === 'mermaid') {
      return `<div class="mermaid">${code}</div>`
    }
    if (language === 'math') {
      return `<div class="math-block">$$${code}$$</div>`
    }
    if (Prism.languages[language]) {
      try {
        return Prism.highlight(code, Prism.languages[language], language)
      } catch (e) {
        return code
      }
    }
    return code
  }
})

// 自定义渲染器扩展
const renderer = new marked.Renderer()

// 代码块处理 - 增加语言选择器
const originalCode = renderer.code.bind(renderer)
renderer.code = function({ text, lang, escaped }) {
  if (lang === 'mermaid') {
    return `<div class="code-block-wrapper">
      <div class="code-block-header">
        <span class="code-lang">mermaid</span>
      </div>
      <div class="mermaid">${text}</div>
    </div>`
  }
  if (lang === 'math') {
    // 用 KaTeX 渲染块级公式
    let html: string
    try { html = katex.renderToString(text, { displayMode: true, throwOnError: false }) }
    catch { html = `$$${text}$$` }
    return `<div class="math-block">${html}</div>`
  }
  const highlighted = Prism.languages[lang || 'plaintext']
    ? Prism.highlight(text, Prism.languages[lang || 'plaintext'], lang || 'plaintext')
    : text
  return `<div class="code-block-wrapper" contenteditable="false">
    <div class="code-block-header">
      <span class="code-lang">${lang || 'plaintext'}</span>
      <button class="code-copy-btn" onclick="window.copyCode(this)">复制</button>
    </div>
    <pre class="language-${lang || 'plaintext'}"><code class="language-${lang || 'plaintext'}">${highlighted}</code></pre>
  </div>`
}

// 行内代码（marked v18: 接收 token 对象 { text }）
renderer.codespan = function({ text }) {
  return `<code class="inline-code">${text}</code>`
}

// 任务列表项（marked v18: 接收 token 对象 { text, task, checked, tokens }）
renderer.listitem = function({ text, task, checked, tokens }: any) {
  // marked v18 默认用 this.parser.parse(tokens) 渲染列表项内容（parse 能正确分派内联 token 与
  // 嵌套 list 等 block token）。此前误用 parseInline(tokens)，嵌套列表时 tokens 含 list block token，
  // inline parser 不认，抛 "Token with list type was not found"，导致 mdToHtml 崩溃、
  // renderContent 抛错使 renderedContent 不更新、编辑区停留在上一个文档内容（即“打开A文件显示B文件内容”bug）。
  let content = (tokens && this.parser) ? this.parser.parse(tokens) : text
  if (task) {
    // parseInline 可能含 marked 内置 checkbox（开头 <input>），去掉避免与下面的自定义 checkbox 重复
    content = content.replace(/^<input[^>]*>\s*/, '')
    return `<li class="task-list-item">
      <input type="checkbox" ${checked ? 'checked' : ''} disabled class="task-checkbox">
      <span>${content}</span>
    </li>`
  }
  return `<li>${content}</li>`
}

// 表格、标题等其余元素使用 marked 默认渲染，避免 v18 签名不匹配导致 [object Object]


marked.use({ renderer })
marked.use(footnote())  // 脚注支持 [^1]

// 行内数学公式 $...$ 扩展（KaTeX 渲染）
marked.use({
  extensions: [{
    name: 'inlineMath',
    level: 'inline',
    start(src: string) { const i = src.indexOf('$'); return i > -1 ? i : undefined },
    tokenizer(src: string) {
      const m = /^\$([^$\n]+?)\$/.exec(src)
      if (m && m[1].trim()) return { type: 'inlineMath', raw: m[0], text: m[1] }
      return undefined
    },
    renderer(token: any) {
      try { return `<span class="math-inline">${katex.renderToString(token.text, { displayMode: false, throwOnError: false })}</span>` }
      catch { return `$${token.text}$` }
    }
  }]
})

// Markdown转HTML（mermaid/math 代码块由 renderer.code 处理，无需占位符）
export function mdToHtml(md: string): string {
  let html: string
  try {
    // $$...$$ 块级数学公式 → math 围栏代码块（renderer.code 处理为 .math-block）
    md = md.replace(/\$\$([\s\S]+?)\$\$/g, (_, p1) => '```math\n' + p1.trim() + '\n```')
    // [TOC] → 文档内可点击目录（占位，渲染后用 buildToc 填充）
    md = md.replace(/^\[TOC\]$/m, '<div class="toc-placeholder"></div>')
    html = marked.parse(md) as string
    // 给标题加 id（供 TOC 链接和大纲跳转）
    html = html.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/g, (_m, lvl, attrs, text) => {
      if (/id=/.test(attrs)) return `<h${lvl}${attrs}>${text}</h${lvl}>`
      const plain = text.replace(/<[^>]+>/g, '').trim() || 'heading'
      const id = 'h-' + plain.replace(/[^\w一-龥]+/g, '-').toLowerCase().replace(/^-+|-+$/g, '')
      return `<h${lvl} id="${id}">${text}</h${lvl}>`
    })
    // 填充 TOC 目录
    html = html.replace(/<div class="toc-placeholder"><\/div>/g, buildToc(html))
  } catch (e) {
    // 兜底：marked 对个别文档（特殊列表/嵌套结构等）可能解析失败。此前无兜底会让 renderContent 抛错、
    // renderedContent 不更新、编辑区停留在上一个文档内容（打开A显示B）。现降级为转义原文 <pre> 展示，
    // 至少保证显示当前文档内容，不串号。
    console.error('[mdToHtml] 渲染失败，降级显示原文:', e)
    html = `<pre class="markdown-fallback">${escapeHtml(md)}</pre>`
  }
  return html
}

// 从 HTML 提取标题生成目录
function buildToc(html: string): string {
  const heads = [...html.matchAll(/<h([1-6])[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g)]
  if (heads.length === 0) return '<div class="toc-empty">（无标题，无法生成目录）</div>'
  let out = '<div class="toc"><ul>'
  for (const h of heads) {
    const level = h[1]
    const id = h[2]
    const text = h[3].replace(/<[^>]+>/g, '').trim()
    out += `<li class="toc-level-${level}"><a href="#${id}">${text}</a></li>`
  }
  out += '</ul></div>'
  return out
}

// Turndown 实例（带 GFM 插件支持表格，自定义规则处理编辑器生成的元素）
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  strongDelimiter: '**'
})
turndown.use(gfm)  // 启用 GFM 表格、任务列表、删除线等

// 保留<br>转义，避免换行丢失
turndown.addRule('lineBreak', {
  filter: 'br',
  replacement: () => '\n'
})

// 行内代码
turndown.addRule('inlineCode', {
  filter: (node: any) => node.nodeName === 'CODE' && (node.classList.contains('inline-code') || !node.closest('pre')),
  replacement: (content: string) => '`' + content + '`'
})

// 代码块（自定义 wrapper 结构）
turndown.addRule('codeBlockWrapper', {
  filter: (node: any) => node.nodeName === 'DIV' && node.classList.contains('code-block-wrapper'),
  replacement: (_: string, node: any) => {
    const lang = node.querySelector('.code-lang')?.textContent?.trim() || ''
    const code = node.querySelector('code')?.textContent || ''
    return '\n\n```' + lang + '\n' + code + '\n```\n\n'
  }
})

// 任务列表项由 GFM 插件处理（识别 input[type=checkbox]），无需自定义规则

// 高亮
turndown.addRule('highlight', {
  filter: 'mark',
  replacement: (content: string) => '==' + content + '=='
})

// 删除线（contenteditable 可能生成 <s>/<del>）
turndown.addRule('strikethrough', {
  filter: ['del', 's', 'strike'],
  replacement: (content: string) => '~~' + content + '~~'
})

// 数学公式块
// 块级公式：从 KaTeX 的 annotation 提取原始 LaTeX，还原为 $$...$$
turndown.addRule('mathBlock', {
  filter: (node: any) => node.nodeName === 'DIV' && node.classList.contains('math-block'),
  replacement: (_: string, node: any) => {
    const ann = node.querySelector('annotation[encoding="application/x-tex"]')
    const tex = ann ? ann.textContent : (node.textContent || '').replace(/\$\$/g, '').trim()
    return '\n\n$$' + tex + '$$\n\n'
  }
})

// 行内公式：从 .math-inline 的 annotation 提取，还原为 $...$
turndown.addRule('mathInline', {
  filter: (node: any) => node.nodeName === 'SPAN' && node.classList.contains('math-inline'),
  replacement: (_: string, node: any) => {
    const ann = node.querySelector('annotation[encoding="application/x-tex"]')
    const tex = ann ? ann.textContent : (node.textContent || '')
    return '$' + tex + '$'
  }
})

// 脚注引用还原：sup#fnref-X → [^X]
turndown.addRule('footnoteRef', {
  filter: (node: any) => node.nodeName === 'SUP' && /^fnref-/.test(node.id || ''),
  replacement: (_: string, node: any) => `[^${(node.id || '').replace('fnref-', '')}]`
})

// 脚注定义还原：section.footnotes → [^X]: 内容
turndown.addRule('footnotes', {
  filter: (node: any) => node.nodeName === 'SECTION' && node.classList.contains('footnotes'),
  replacement: (_: string, node: any) => {
    let out = '\n\n'
    node.querySelectorAll('li').forEach((li: any) => {
      const id = (li.id || '').replace('fn-', '')
      const text = (li.textContent || '').replace(/↩/, '').trim()
      if (id) out += `[^${id}]: ${text}\n`
    })
    return out
  }
})

// 文档内目录还原：.toc / .toc-empty → [TOC]
turndown.addRule('toc', {
  filter: (node: any) => node.nodeName === 'DIV' && (node.classList.contains('toc') || node.classList.contains('toc-empty')),
  replacement: () => '[TOC]\n\n'
})

// Mermaid 图表（渲染后是 SVG，从 data-mermaid-source 还原源码，避免 SVG 污染）
turndown.addRule('mermaid', {
  filter: (node: any) => node.nodeName === 'DIV' && node.classList.contains('mermaid'),
  replacement: (_: string, node: any) => {
    const src = node.getAttribute('data-mermaid-source') || ''
    return src ? '\n\n```mermaid\n' + src + '\n```\n\n' : ''
  }
})

// 忽略复制按钮等非内容元素
turndown.addRule('removeCopyBtn', {
  filter: (node: any) => node.classList && node.classList.contains('code-copy-btn'),
  replacement: () => ''
})

// HTML转Markdown（用于 contenteditable 内容回写 store 和导出）
export function htmlToMd(html: string): string {
  let md = turndown.turndown(html)
  // 修正无序列表标记的多余空格（turndown 硬编码 '-   '，改为 '- ' 保持往返一致）
  md = md.replace(/^([*-]) {3,}/gm, '$1 ')
  // 修正任务列表项的多余空格（- [ ]   task → - [ ] task）
  md = md.replace(/^(- \[[ x]\]) {2,}/gm, '$1 ')
  // 转义裸 < > 为 \< \> 防止 marked 渲染为真实 HTML 元素（XSS/破坏DOM），代码块/行内代码内不转义
  const placeholders: string[] = []
  md = md.replace(/```[\s\S]*?```/g, (m) => { placeholders.push(m); return ` CB${placeholders.length - 1} ` })
  md = md.replace(/`[^`\n]+`/g, (m) => { placeholders.push(m); return ` CI${placeholders.length - 1} ` })
  md = md.replace(/</g, '\\<')
  md = md.replace(/ CB(\d+) /g, (_, i) => placeholders[+i])
  md = md.replace(/ CI(\d+) /g, (_, i) => placeholders[+i])
  // 清理多余空行
  md = md.replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '')
  return md
}

// Mermaid 模块缓存：动态 import，避免静态引入 ~3MB 库拖慢首屏；仅文档含 .mermaid 块时才按需加载
let mermaidMod: any = null
async function getMermaid(): Promise<any> {
  if (!mermaidMod) {
    const mod = await import('mermaid')
    mermaidMod = mod.default ?? mod
  }
  return mermaidMod
}

// 渲染Mermaid图表
export async function renderMermaid(container: HTMLElement) {
  const mermaid = await getMermaid()
  mermaid.initialize({
    startOnLoad: false,
    theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default',
    securityLevel: 'loose'
  })

  const mermaidElements = container.querySelectorAll('.mermaid')
  for (let i = 0; i < mermaidElements.length; i++) {
    const el = mermaidElements[i] as HTMLElement
    if (el.getAttribute('data-processed')) continue

    // 渲染前保存原始源码到 dataset，供 HTML→MD 回写时还原（避免 SVG 污染内容）
    const source = el.textContent || ''
    el.setAttribute('data-mermaid-source', source)

    const id = `mermaid-${Date.now()}-${i}`
    try {
      const { svg } = await mermaid.render(id, source)
      el.innerHTML = svg
      el.setAttribute('data-processed', 'true')
    } catch (e) {
      el.innerHTML = `<div class="mermaid-error">Mermaid语法错误: ${(e as Error).message}</div>`
    }
  }
}

// 提取文档大纲
export interface OutlineItem {
  level: number
  text: string
  id: string
}

// 提取文档大纲：在实际 DOM 的 heading 上设置 id（供大纲点击跳转）
export function extractOutline(container: HTMLElement): OutlineItem[] {
  const headings = container.querySelectorAll('h1, h2, h3, h4, h5, h6')
  const outline: OutlineItem[] = []

  headings.forEach((heading, index) => {
    const level = parseInt(heading.tagName.charAt(1))
    const text = heading.textContent || ''
    // 读取 mdToHtml 已设的 id；无则补一个（供大纲跳转）
    let id = heading.id
    if (!id) { id = `heading-${index}`; heading.id = id }
    outline.push({ level, text, id })
  })

  return outline
}

// 字数统计
export interface WordStats {
  characters: number
  charactersNoSpaces: number
  words: number
  lines: number
}

export function countWords(text: string): WordStats {
  const characters = text.length
  const charactersNoSpaces = text.replace(/\s/g, '').length
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const lines = text.split('\n').length

  return {
    characters,
    charactersNoSpaces,
    words,
    lines
  }
}

// 转义 HTML 特殊字符（无对应 Prism 语法的代码块兜底渲染，避免 < > 被当作标签）
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// 重新高亮代码块：依据 code 元素的 language-xxx 类名，用 Prism 重新渲染高亮 HTML
// 用于代码块编辑态退出后恢复语法高亮（编辑态下 code 是裸文本，无 token span）
export function highlightCodeElement(code: HTMLElement) {
  const lang = (code.className.match(/language-([\w-]+)/) || ['', 'plaintext'])[1] || 'plaintext'
  const raw = code.textContent || ''
  const grammar = Prism.languages[lang]
  code.innerHTML = grammar ? Prism.highlight(raw, grammar, lang) : escapeHtml(raw)
}

// 复制代码到剪贴板
export function copyCode(btn: HTMLElement) {
  const pre = btn.closest('.code-block-wrapper')?.querySelector('pre')
  if (!pre) return

  const code = pre.textContent || ''
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = '已复制'
    setTimeout(() => {
      btn.textContent = '复制'
    }, 2000)
  })
}

// 处理图片粘贴
export function handleImagePaste(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      resolve(e.target?.result as string)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// 插入Markdown语法
export function insertMarkdown(
  textarea: HTMLTextAreaElement | undefined,
  before: string,
  after: string = '',
  placeholder: string = ''
) {
  if (!textarea) return

  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const selectedText = textarea.value.substring(start, end)
  const text = selectedText || placeholder

  textarea.value = textarea.value.substring(0, start) + before + text + after + textarea.value.substring(end)
  textarea.selectionStart = start + before.length
  textarea.selectionEnd = start + before.length + text.length
  textarea.focus()

  return textarea.value
}