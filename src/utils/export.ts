/**
 * 导出管线（§6.4）
 * flushSync + normalizeCodeBlocks → md / HTML / PDF / 图片（渲染层生成，内核 write_* 落盘）。
 */
import { tauriAPI } from '@/utils/tauriAPI'
import { markdownToHtml } from '@/utils/markdown'
import { useDocumentStore } from '@/stores/document'

/** 简单 HTML 转义 */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 内联样式片段，保证导出在无 WebView 样式时仍可读 */
const EXPORT_CSS = `
  body { font-family: 'Ubuntu','Noto Sans SC',system-ui,sans-serif; max-width: 820px; margin: 40px auto; padding: 0 24px; color: #1a1a1a; line-height: 1.7; }
  h1,h2,h3{line-height:1.3} h1{border-bottom:2px solid #E95420;padding-bottom:8px}
  pre{background:#f6f5f4;border-radius:6px;padding:14px;overflow:auto;font-family:'Ubuntu Mono',monospace;font-size:13px}
  code{font-family:'Ubuntu Mono',monospace;background:#f0eee b;background:#f0eeeb;padding:2px 5px;border-radius:4px}
  pre code{background:none;padding:0}
  table{border-collapse:collapse} th,td{border:1px solid #d9d5d2;padding:8px 12px}
  blockquote{border-left:4px solid #E95420;margin:0;padding:2px 16px;color:#555}
  img{max-width:100%} a{color:#00698d}
  hr{border:none;border-top:2px solid #d9d5d2;margin:28px 0}
`

function buildHtmlDocument(md: string): string {
  const body = markdownToHtml(md)
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Hypora 导出</title><style>${EXPORT_CSS}</style></head><body>${body}</body></html>`
}

function defaultExportName(): string {
  const doc = useDocumentStore()
  return (doc.fileName || '文档').replace(/\.md$/i, '')
}

/** 导出 Markdown */
export async function exportMarkdown(md: string): Promise<string | null> {
  const name = defaultExportName() + '.md'
  const target = await tauriAPI.saveFileDialog(name, md)
  if (target) await tauriAPI.writeFile(target, md)
  return target
}

/** 导出 HTML */
export async function exportHTML(md: string): Promise<string | null> {
  const html = buildHtmlDocument(md)
  const name = defaultExportName() + '.html'
  const target = await tauriAPI.saveFileDialog(name, html)
  if (target) await tauriAPI.writeFile(target, html)
  return target
}

/** 导出 PDF：新窗口打印（浏览器原生打印 → 另存为 PDF） */
export function exportPDF(md: string): void {
  const html = buildHtmlDocument(md)
  const w = window.open('', '_blank', 'width=900,height=1100')
  if (!w) {
    alert('浏览器拦截了新窗口，请允许弹出窗口后重试导出 PDF。')
    return
  }
  w.document.write(html)
  w.document.title = defaultExportName()
  w.document.close()
  w.focus()
  setTimeout(() => w.print(), 600)
}

/** 导出图片（SVG）：渲染 HTML 到 SVG 文本，内核 write_file 落盘 */
export async function exportSVG(md: string): Promise<string | null> {
  const body = markdownToHtml(md)
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" viewBox="0 0 1200 1600">
<rect width="1200" height="1600" fill="#ffffff"/>
<foreignObject width="1160" height="1560" x="20" y="20"><div xmlns="http://www.w3.org/1999/xhtml" style="font-family:Ubuntu,'Noto Sans SC',sans-serif;font-size:15px;line-height:1.7;color:#1a1a1a">${body}</div></foreignObject>
</svg>`
  const name = defaultExportName() + '.svg'
  const target = await tauriAPI.saveFileDialog(name, svg)
  if (target) await tauriAPI.writeFile(target, svg)
  return target
}

export type ExportKind = 'md' | 'html' | 'pdf' | 'svg'

export async function runExport(kind: ExportKind, md: string): Promise<string | null> {
  const doc = useDocumentStore()
  await doc.flushSave() // §6.4 flushSync：导出前落盘并取最新内容
  switch (kind) {
    case 'md':
      return exportMarkdown(md)
    case 'html':
      return exportHTML(md)
    case 'pdf':
      exportPDF(md)
      return null
    case 'svg':
      return exportSVG(md)
  }
}
