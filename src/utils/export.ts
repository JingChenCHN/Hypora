import { saveAs } from 'file-saver'
// html2canvas / jspdf 仅在导出 PDF/图片时使用,改为函数内动态 import(),避免拖慢首屏启动

// 导出签名：出现在 HTML/PDF/图片 导出产物底部（不写入 Markdown 原文，避免污染内容）
const EXPORT_SIGNATURE = '由 Hypora 提供支持'
const EXPORT_CONTACT = '更多支持请联系 hemo8212@outlook.com'
// 签名块 HTML（冷淡单色风格：发丝线上方、muted 小字、居中）
const SIGNATURE_HTML = `<div class="hypora-signature">
  <div class="sig-line"></div>
  <div class="sig-main">由 Hypora 提供支持</div>
  <div class="sig-sub">更多支持请联系 hemo8212@outlook.com</div>
</div>`

// 统一保存文件：Electron 用原生保存对话框（可选位置），Web 用浏览器下载
// 返回 true 表示已保存，false 表示用户取消
export async function saveFile(filename: string, content: string, mime: string = 'text/plain;charset=utf-8'): Promise<boolean> {
  const electronAPI = (window as any).electronAPI
  if (electronAPI?.showSaveDialog && electronAPI?.writeFile) {
    // Electron：原生保存对话框
    const result = await electronAPI.showSaveDialog(filename)
    if (!result || result.canceled || !result.filePath) return false
    const r = await electronAPI.writeFile(result.filePath, content)
    return !!(r && r.success)
  }
  // Web：浏览器下载
  const blob = new Blob([content], { type: mime })
  saveAs(blob, filename)
  return true
}

// 导出Markdown文件
export async function exportMarkdown(content: string, filename: string = 'document'): Promise<boolean> {
  return await saveFile(`${filename}.md`, content, 'text/markdown;charset=utf-8')
}

// 云端保存：把当前 Markdown 保存到本服务器（同源 /api/cloud/save，server.cjs 落盘到 -cloud 目录）
export async function cloudSave(content: string, filename: string = 'document'): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const res = await fetch('/api/cloud/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: `${filename}.md`, content }),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: j?.error || `HTTP ${res.status}` }
    return { ok: true, path: j.path || `${filename}.md` }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

// 云端文件列表
export async function cloudList(): Promise<{ name: string; size: number; mtime: number }[]> {
  const res = await fetch('/api/cloud/list')
  const j = await res.json().catch(() => ({}))
  return Array.isArray(j.files) ? j.files : []
}

// 读取某个云端文件内容
export async function cloudRead(name: string): Promise<{ name: string; content: string }> {
  const res = await fetch(`/api/cloud/file?name=${encodeURIComponent(name)}`)
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
  return { name: j.name || name, content: j.content ?? '' }
}

// 删除某个云端文件
export async function cloudDelete(name: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/cloud/file?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) return { ok: false, error: j?.error || `HTTP ${res.status}` }
  return { ok: true }
}

// 导出HTML文件（返回完整 HTML 字符串）
export function buildHTML(content: string, title: string = 'Document', theme: string = 'light'): string {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${theme}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --paper: #fafaf9; --paper-2: #efedea; --ink: #1a1a1a; --ink-2: #3f3f3c;
      --muted: #8a8a85; --hair: #e3e1dd;
      --serif: "Georgia", "Songti SC", "Source Han Serif SC", "Noto Serif SC", serif;
    }
    [data-theme="dark"]  { --paper: #0e0e0d; --paper-2: #161614; --ink: #d9d7d2; --ink-2: #b4b2ad; --muted: #8a8884; --hair: #26261f; }
    [data-theme="beige"] { --paper: #f5f0e6; --paper-2: #ebe5d8; --ink: #3b3b3b; --ink-2: #6b6357; --muted: #8a8072; --hair: #d9d2c5; }
    [data-theme="gray"]  { --paper: #f8f9fa; --paper-2: #e9ecef; --ink: #212529; --ink-2: #495057; --muted: #6c757d; --hair: #dee2e6; }
    [data-theme="ice"]   { --paper: #e8f0f4; --paper-2: #dde7ed; --ink: #1a3a4a; --ink-2: #3d5f6e; --muted: #5a7a88; --hair: #c9dbe4; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
      line-height: 1.6;
      padding: 40px;
      max-width: 900px;
      margin: 0 auto;
      color: var(--ink);
      background: var(--paper);
    }
    h1, h2, h3, h4, h5, h6 {
      font-family: var(--serif);
      font-weight: 500;
      letter-spacing: -0.01em;
      line-height: 1.25;
      margin: 24px 0 16px;
      color: var(--ink);
    }
    h1 { font-size: 2em; border-bottom: 1px solid var(--hair); padding-bottom: 0.3em; }
    h2 { font-size: 1.5em; border-bottom: 1px solid var(--hair); padding-bottom: 0.3em; }
    p { margin: 16px 0; }
    pre { background: var(--paper-2); padding: 16px; border-radius: 2px; overflow-x: auto; margin: 16px 0; border: 1px solid var(--hair); }
    code { font-family: "JetBrains Mono", "SF Mono", Consolas, Monaco, monospace; font-size: 0.9em; }
    .inline-code { background: var(--paper-2); padding: 2px 6px; border-radius: 2px; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0; }
    th, td { border: 1px solid var(--hair); padding: 8px 12px; text-align: left; }
    th { background: var(--paper-2); font-weight: 500; }
    blockquote { border-left: 2px solid var(--muted); padding: 0 1em; color: var(--ink-2); margin: 16px 0; }
    ul, ol { padding-left: 2em; margin: 16px 0; }
    li { margin: 4px 0; }
    img { max-width: 100%; margin: 16px 0; }
    hr { border: none; border-top: 1px solid var(--hair); margin: 24px 0; }
    a { color: var(--ink); text-decoration: none; border-bottom: 1px solid transparent; }
    a:hover { border-bottom-color: var(--muted); }
    .task-list-item { list-style: none; margin-left: -1.5em; }
    .task-checkbox { margin-right: 0.5em; }
    .code-block-wrapper { margin: 16px 0; border-radius: 2px; overflow: hidden; border: 1px solid var(--hair); }
    .code-block-header { background: var(--paper-2); padding: 8px 16px; display: flex; justify-content: space-between; align-items: center; font-size: 0.85em; color: var(--muted); border-bottom: 1px solid var(--hair); }
    .code-copy-btn { background: none; border: none; cursor: pointer; color: var(--ink); }
    .table-wrapper { overflow-x: auto; margin: 16px 0; }
    .math-block { margin: 16px 0; text-align: center; overflow-x: auto; }
    .mermaid { margin: 16px 0; text-align: center; }
    /* 导出签名：发丝线上方、muted 小字、居中，冷淡单色 */
    .hypora-signature {
      margin-top: 48px; padding-top: 16px;
      border-top: 1px solid var(--hair);
      text-align: center;
    }
    .hypora-signature .sig-main {
      font-size: 12px; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 2px;
    }
    .hypora-signature .sig-sub {
      font-size: 11px; color: var(--muted); opacity: 0.8;
    }
  </style>
</head>
<body>
  <div class="markdown-body">
    ${content}
    ${SIGNATURE_HTML}
  </div>
</body>
</html>`
}

// 导出 PDF/图片 前：给元素临时注入签名块（html2canvas 截图后移除，不污染文档）
function withSignature(el: HTMLElement, fn: () => Promise<boolean>): Promise<boolean> {
  const div = document.createElement('div')
  div.innerHTML = SIGNATURE_HTML
  const node = div.firstElementChild as HTMLElement
  // 签名样式内联（截图时无需全局样式表，随元素计算）
  node.style.marginTop = '48px'
  node.style.paddingTop = '16px'
  node.style.borderTop = '1px solid ' + getComputedStyle(el).getPropertyValue('--border-color') || '#e3e1dd'
  node.style.textAlign = 'center'
  const main = node.querySelector('.sig-main') as HTMLElement
  const sub = node.querySelector('.sig-sub') as HTMLElement
  if (main) { main.style.fontSize = '12px'; main.style.letterSpacing = '0.08em'; main.style.color = 'var(--text-muted)' }
  if (sub) { sub.style.fontSize = '11px'; sub.style.color = 'var(--text-muted)'; sub.style.opacity = '0.8' }
  el.appendChild(node)
  // 滚动到底部，确保签名块进入截图可视区
  node.scrollIntoView({ block: 'end' })
  return fn().finally(() => { node.remove() })
}

// 导出HTML文件
export async function exportHTML(content: string, title: string = 'Document', theme: string = 'light'): Promise<boolean> {
  return await saveFile(`${title}.html`, buildHTML(content, title, theme), 'text/html;charset=utf-8')
}

// 导出PDF（Electron 用原生保存对话框，Web 用浏览器下载）
export async function exportPDF(element: HTMLElement, filename: string = 'document'): Promise<boolean> {
  // Electron：走原生 printToPDF —— Chromium 打印引擎按 A4 排版分页，输出矢量文本（可选中/可搜索），
  // 打印 CSS（print.scss）只显示文档克隆，彻底避免 html2canvas 整档位图 → PNG 的体积爆炸（2MB md → 200MB+ PDF）。
  const electronAPI = (window as any).electronAPI
  if (electronAPI?.printToPDF) {
    return withSignature(element, async () => {
      const clone = preparePrintClone(element)
      document.documentElement.classList.add('hypora-printing')
      try {
        const r = await electronAPI.printToPDF(`${filename}.pdf`)
        if (r?.canceled) return false
        if (!r?.success) throw new Error(r?.error || 'PDF 导出失败')
        return true
      } finally {
        document.documentElement.classList.remove('hypora-printing')
        clone.remove()
      }
    })
  }

  // 网页 / Tauri 回退：html2canvas 渲染后按 A4 切页，每页独立 JPEG（质量 0.9）压缩。
  // 不再用「整档单张 PNG」：PNG 无损重编码图片极占体积，且超长文档会触发浏览器画布上限产生空白页。
  return withSignature(element, async () => {
    const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')])
    const bg = getComputedStyle(document.body).backgroundColor

    const render = (s: number) => html2canvas(element, {
      scale: s,
      useCORS: true,
      logging: false,
      backgroundColor: bg
    })

    // 画布面积超限时逐步降采样重渲（浏览器画布面积上限，超限会得到空白/损坏图）
    let scale = 2
    let canvas = await render(scale)
    const MAX_PIXELS = 2 ** 26 // 67M 像素安全上限
    while (canvas.width * canvas.height > MAX_PIXELS && scale > 0.75) {
      scale = Math.max(0.75, scale - 0.25)
      canvas = await render(scale)
    }

    const pdf = new jsPDF('p', 'mm', 'a4')
    const pageHeightPx = Math.floor((canvas.width * 297) / 210) // 与 A4 等比的像素页高
    const pageCount = Math.ceil(canvas.height / pageHeightPx)
    const pageCanvas = document.createElement('canvas')

    for (let i = 0; i < pageCount; i++) {
      const srcY = i * pageHeightPx
      const h = Math.min(pageHeightPx, canvas.height - srcY)
      pageCanvas.width = canvas.width
      pageCanvas.height = h
      const ctx = pageCanvas.getContext('2d')
      if (!ctx) continue
      ctx.fillStyle = bg || '#ffffff'
      ctx.fillRect(0, 0, pageCanvas.width, h)
      ctx.drawImage(canvas, 0, srcY, canvas.width, h, 0, 0, canvas.width, h)
      const imgData = pageCanvas.toDataURL('image/jpeg', 0.9)
      const imgHeightMM = (h * 210) / canvas.width
      if (i > 0) pdf.addPage()
      pdf.addImage(imgData, 'JPEG', 0, 0, 210, imgHeightMM)
    }

    const electronAPI2 = (window as any).electronAPI
    if (electronAPI2?.showSaveDialog && electronAPI2?.writeBinaryFile) {
      const result = await electronAPI2.showSaveDialog(`${filename}.pdf`)
      if (!result || result.canceled || !result.filePath) return false
      // jsPDF output arraybuffer → base64
      // 注意：不能用 String.fromCharCode(...bytes) 一次性展开 —— 大数组（几十万字节）
      // 会超过 V8 函数参数上限（约 65535），抛 "Maximum call stack size exceeded"。
      // 分批（32KB）转换规避。
      const ab = pdf.output('arraybuffer')
      const bytes = new Uint8Array(ab)
      const CHUNK = 0x8000 // 32KB，远低于参数上限
      let binary = ''
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
      }
      const base64 = btoa(binary)
      const r = await electronAPI2.writeBinaryFile(result.filePath, base64)
      return !!(r && r.success)
    }
    pdf.save(`${filename}.pdf`)
    return true
  })
}

// 导出 PDF 前：克隆编辑区 DOM 为 body 直属的打印容器。
// markdown-body 全部内容样式是全局的（themes/index.scss），克隆挂到 body 下依然完整生效；
// 同时剥离编辑器痕迹（复制按钮、contenteditable），空标题/空段落的占位文案由 print.scss 抑制。
function preparePrintClone(el: HTMLElement): HTMLElement {
  const clone = el.cloneNode(true) as HTMLElement
  clone.querySelectorAll('.code-copy-btn').forEach((n) => n.remove())
  clone.querySelectorAll('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable'))
  // 剥离编辑态：专注模式会把非焦点段落压暗（opacity 0.3），打字机/搜索高亮同理不应进入 PDF
  clone.classList.remove('focus-mode', 'typewriter-mode')
  clone.querySelectorAll('.search-hit').forEach((n) => {
    const parent = n.parentNode
    if (parent) parent.replaceChild(document.createTextNode(n.textContent || ''), n)
  })
  const root = document.createElement('div')
  root.className = 'hypora-print-root'
  root.appendChild(clone)
  document.body.appendChild(root)
  return root
}

// 导出图片（Electron 用原生保存对话框，Web 用浏览器下载）
export async function exportImage(element: HTMLElement, filename: string = 'document'): Promise<boolean> {
  return withSignature(element, async () => {
    const { default: html2canvas } = await import('html2canvas')
    const canvas = await html2canvas(element, {
      scale: 2,
      useCORS: true,
      logging: false,
      backgroundColor: getComputedStyle(document.body).backgroundColor
    })

    const electronAPI = (window as any).electronAPI
    if (electronAPI?.showSaveDialog && electronAPI?.writeBinaryFile) {
      const result = await electronAPI.showSaveDialog(`${filename}.png`)
      if (!result || result.canceled || !result.filePath) return false
      const base64 = canvas.toDataURL('image/png').split(',')[1]
      const r = await electronAPI.writeBinaryFile(result.filePath, base64)
      return !!(r && r.success)
    }
    return new Promise<boolean>((resolve) => {
      canvas.toBlob((blob: Blob | null) => {
        if (blob) { saveAs(blob, `${filename}.png`); resolve(true) }
        else resolve(false)
      })
    })
  })
}

// 读取本地.md文件
export function readMdFile(file: File): Promise<{ title: string, content: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const content = e.target?.result as string
      const title = file.name.replace(/\.md$/, '')
      resolve({ title, content })
    }
    reader.onerror = reject
    reader.readAsText(file, 'utf-8')
  })
}

// 读取本地 PDF 文件为 base64（网页版打开入口；桌面版由主进程读取）
export function readPdfFile(file: File): Promise<{ title: string, base64: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      // data:application/pdf;base64,xxxx → 取后半段
      const base64 = String(e.target?.result || '').split(',')[1] || ''
      const title = file.name.replace(/\.pdf$/i, '')
      resolve({ title, base64 })
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}