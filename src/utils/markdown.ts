/**
 * Markdown 块模型：解析 / 序列化 / 内联渲染（§6.1 编辑管线）
 *
 * 块级 WYSIWYG 的模型约定：
 * - 文本块持有已渲染的内联 HTML（block.html），编辑时作为活 DOM；
 * - 序列化走 blocksToMarkdown（turndown 回写），写回源文件；
 * - 解析走 parseMarkdown（打开/撤销/AI 插入时重建块数组）。
 */
import { marked } from 'marked'
import TurndownService from 'turndown'

/* ───────────── 类型 ───────────── */

export type BlockType =
  | 'p'
  | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  | 'quote'
  | 'ul' | 'ol' | 'task'
  | 'code' | 'mermaid'
  | 'image' | 'hr' | 'table'

export interface Block {
  id: string
  type: BlockType
  /** 文本块：已渲染内联 HTML（活内容） */
  html?: string
  /** 代码 / mermaid：源码文本 */
  code?: string
  /** 代码块语言 */
  lang?: string
  /** 有序列表起始序号 */
  start?: number
  /** 图片 */
  src?: string
  alt?: string
  /** 表格原始 markdown（读多写少，源码视图编辑） */
  tableMd?: string
}

/* ───────────── 工具 ───────────── */

export function genId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

/* ───────────── 内联渲染：markdown 片段 → HTML ───────────── */

marked.setOptions({ gfm: true, breaks: false })

export function renderInline(md: string): string {
  if (!md) return ''
  try {
    const out = marked.parseInline(md) as string
    return out.trim()
  } catch {
    return escapeHtml(md)
  }
}

/* ───────────── HTML → markdown（turndown，供序列化）───────────── */

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
})

function htmlToMd(html: string): string {
  try {
    return turndown.turndown(html).trim()
  } catch {
    return html.replace(/<[^>]*>/g, '').trim()
  }
}

/* ───────────── 解析：markdown 文本 → 块数组 ───────────── */

export function parseMarkdown(md: string): Block[] {
  const lines = (md || '').replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  const push = (b: Omit<Block, 'id'>) => blocks.push({ id: genId(), ...b })

  while (i < lines.length) {
    const trimmed = lines[i].trim()

    // 空行：跳过（块以空行分隔）
    if (!trimmed) { i++; continue }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { push({ type: 'hr' }); i++; continue }

    // 代码围栏（含 mermaid）
    const fence = trimmed.match(/^(`{3,}|~{3,})(.*)$/)
    if (fence) {
      const marker = fence[1][0]
      const lang = fence[2].trim()
      const content: string[] = []
      i++
      while (i < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i])) {
        content.push(lines[i]); i++
      }
      i++ // 跳过闭合围栏
      if (lang === 'mermaid') push({ type: 'mermaid', code: content.join('\n') })
      else push({ type: 'code', code: content.join('\n'), lang })
      continue
    }

    // 标题
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length as 1 | 2 | 3 | 4 | 5 | 6
      push({ type: `h${level}` as BlockType, html: renderInline(heading[2]) })
      i++; continue
    }

    // 任务列表
    if (/^\s*[-*+]\s+\[[ xX]\]\s/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length) {
        const m = lines[i].trim().match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/)
        if (!m) break
        const checked = m[1].toLowerCase() === 'x'
        items.push(`<li class="task-item" data-checked="${checked}"><input type="checkbox"${checked ? ' checked' : ''}/> ${renderInline(m[2])}</li>`)
        i++
      }
      push({ type: 'task', html: items.join('') })
      continue
    }

    // 无序列表
    if (/^\s*[-*+]\s+\S/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length) {
        const m = lines[i].trim().match(/^[-*+]\s+(.*)$/)
        if (!m) break
        items.push(`<li>${renderInline(m[1])}</li>`)
        i++
      }
      push({ type: 'ul', html: items.join('') })
      continue
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+\S/.test(trimmed)) {
      const items: string[] = []
      const startMatch = trimmed.match(/^\s*(\d+)/)
      const start = startMatch ? parseInt(startMatch[1], 10) : 1
      while (i < lines.length) {
        const m = lines[i].trim().match(/^\d+[.)]\s+(.*)$/)
        if (!m) break
        items.push(`<li>${renderInline(m[1])}</li>`)
        i++
      }
      push({ type: 'ol', html: items.join(''), start })
      continue
    }

    // 引用
    if (/^\s*>\s?/.test(trimmed)) {
      const content: string[] = []
      while (i < lines.length) {
        const t = lines[i].trim()
        if (!t.startsWith('>')) break
        content.push(t.replace(/^>\s?/, ''))
        i++
      }
      push({ type: 'quote', html: renderInline(content.join('\n')) })
      continue
    }

    // 图片（独占一行）
    const img = trimmed.match(/^!\[([^\]]*)\]\((.*?)\)$/)
    if (img) { push({ type: 'image', src: img[2], alt: img[1] }); i++; continue }

    // 表格：表头 + 分隔行
    if (
      trimmed.startsWith('|') &&
      i + 1 < lines.length &&
      /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1]) &&
      lines[i + 1].includes('-')
    ) {
      const tableLines: string[] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i].trim())) {
        tableLines.push(lines[i].trim()); i++
      }
      push({ type: 'table', tableMd: tableLines.join('\n') })
      continue
    }

    // 普通段落：收集连续普通行
    const para: string[] = []
    while (i < lines.length) {
      const t = lines[i].trim()
      if (!t) break
      if (/^(#{1,6}\s|```|~~~|[-*+]\s|>\s?|\d+[.)]\s|!\[)/.test(t)) break
      para.push(t)
      i++
    }
    push({ type: 'p', html: renderInline(para.join(' ')) })
  }

  return blocks
}

/* ───────────── 序列化：块数组 → markdown ───────────── */

function headingLevel(t: BlockType): number | null {
  const m = /^h([1-6])$/.exec(t)
  return m ? parseInt(m[1], 10) : null
}

export function blockToMarkdown(b: Block): string {
  const lvl = headingLevel(b.type)
  switch (b.type) {
    case 'p':
      return htmlToMd(b.html || '')
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      return `${'#'.repeat(lvl as number)} ${htmlToMd(b.html || '')}`
    case 'quote':
      return htmlToMd(b.html || '')
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')
    case 'ul':
      return htmlToMd(`<ul>${b.html || ''}</ul>`)
    case 'ol':
      return htmlToMd(`<ol>${b.html || ''}</ol>`)
    case 'task':
      return htmlToMd(`<ul>${b.html || ''}</ul>`)
    case 'code':
      return '```' + (b.lang || '') + '\n' + (b.code ?? '') + '\n```'
    case 'mermaid':
      return '```mermaid\n' + (b.code ?? '') + '\n```'
    case 'image':
      return `![${b.alt || ''}](${b.src || ''})`
    case 'hr':
      return '---'
    case 'table':
      return b.tableMd ?? ''
    default:
      return htmlToMd(b.html || '')
  }
}

export function blocksToMarkdown(blocks: Block[]): string {
  return blocks.map(blockToMarkdown).filter((s) => s.trim() !== '').join('\n\n') + '\n'
}

/* ───────────── 统计辅助 ───────────── */

export function blocksText(blocks: Block[]): string {
  const strip = (h: string) => h.replace(/<[^>]*>/g, '')
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'code': case 'mermaid': return b.code ?? ''
        case 'table': return b.tableMd ?? ''
        default: return strip(b.html || '')
      }
    })
    .join('\n')
}

/** 转 HTML 供导出：整个 markdown → 完整 HTML 片段（§6.4 导出管线） */
export function markdownToHtml(md: string): string {
  return marked.parse(md, { breaks: true }) as string
}
