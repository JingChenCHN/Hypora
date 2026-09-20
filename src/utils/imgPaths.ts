/**
 * 图片文件模式路径工具（桌面版：图片落盘文档同目录 assets/，Markdown 存相对引用）
 *
 * 双向转换边界：
 *  - store 的 Markdown 永远只含相对引用（assets/img-x.png）或 data:/外链
 *  - 所见即所得 DOM 里相对引用被改写为 hypora-asset://local/<encodeURIComponent(相对路径)>，
 *    主进程按当前文档目录（set-doc-base-dir 同步）解析并读取磁盘文件 —— dev 是 http 页
 *    （不能加载 file://），prod loadFile 下相对 src 会指进安装目录，故统一走协议
 *  - 渲染前 resolveAssetSrcs（相对→协议），序列化/导出前 relativizeAssetSrcs（协议→相对）
 *
 * Web/Tauri（无 writeDocAsset API）：一切改写被守卫为 no-op，行为与 base64 时代一致。
 */

export const ASSET_SCHEME = 'hypora-asset'
export const DISPLAY_PREFIX = `${ASSET_SCHEME}://local/`

// 是否桌面文件模式。特性检测而非 isElectron：Tauri 兼容层会伪装 isElectron=true 但没有 writeDocAsset
export function fileModeEnabled(): boolean {
  return typeof window !== 'undefined' && !!(window as any).electronAPI?.writeDocAsset
}

// data:/http(s)/file:/协议地址/锚点/协议相对 //，以及盘符绝对路径，都不是可落盘的相对引用
const NON_REL_RE = /^(?:data|https?|file|blob|ftp|mailto|javascript|hypora-asset):/i

function isRewritableRelative(src: string): boolean {
  const s = (src || '').trim()
  if (!s) return false
  if (s.startsWith('#') || s.startsWith('//') || s.startsWith('/')) return false
  if (NON_REL_RE.test(s)) return false
  if (/^[A-Za-z]:[\\/]/.test(s)) return false
  // ../ 逃逸出文档目录的引用主进程会拒绝（安全边界），不如不改写
  if (s.split(/[\\/]/).includes('..')) return false
  return true
}

/** 相对引用 → 协议显示地址（不满足改写条件时原样返回） */
export function toDisplaySrc(src: string): string {
  if (!fileModeEnabled() || !isRewritableRelative(src)) return src
  return DISPLAY_PREFIX + encodeURIComponent(src.trim())
}

/** 协议显示地址 → 相对引用（非协议地址/解码失败一律原样返回，绝不吞图） */
export function fromDisplaySrc(src: string): string {
  if (typeof src !== 'string' || !src.startsWith(DISPLAY_PREFIX)) return src
  try {
    return decodeURIComponent(src.slice(DISPLAY_PREFIX.length)) || src
  } catch {
    return src
  }
}

// 改写 img/video/audio/source 的 src 属性。必须锚定标签名：否则代码块里高亮出的
// `src="…"` 示例文本会被误改，经 htmlToMd 写回 store 造成内容污染。
const SRC_ATTR_RE = /((?:<img|<video|<audio|<source)\b[^>]*?\ssrc=)(["'])([^"']*)\2/gi

export function rewriteSrcs(html: string, fn: (src: string) => string): string {
  return html.replace(SRC_ATTR_RE, (_m, head: string, quote: string, src: string) => `${head}${quote}${fn(src)}${quote}`)
}

/** 渲染前：相对引用 → 协议地址（覆盖 marked 输出的 img 标签与文中原始 HTML 媒体） */
export function resolveAssetSrcs(html: string): string {
  if (!fileModeEnabled()) return html
  return rewriteSrcs(html, toDisplaySrc)
}

/** 序列化/导出前：协议地址 → 相对引用（无协议地址时快路径直返） */
export function relativizeAssetSrcs(html: string): string {
  if (!html.includes(DISPLAY_PREFIX)) return html
  return rewriteSrcs(html, fromDisplaySrc)
}

/** 从文档绝对路径取所在目录（兼容 \ 与 / 分隔符；Windows 盘根补全分隔符） */
export function dirOfDocPath(filePath: string): string {
  const i = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
  if (i <= 0) return filePath
  let dir = filePath.slice(0, i)
  if (/^[A-Za-z]:$/.test(dir)) dir += filePath[i] // "C:" → "C:\"（盘根）
  return dir
}
