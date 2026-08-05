/**
 * ───────────────────────────────────────────────────────────────
 * Hypora 统一适配层（§4 D2 / §5 进程契约 / §14.2）
 * ── 渲染层唯一跨边界入口：所有 invoke/listen 都从这里走。
 * ── 壳无关：桌面（Tauri）与 Web 降级两套实现，接口一致。
 * ── 契约：命令 snake_case · 事件 kebab/lower · payload 全 JSON。
 * ── 禁止：组件/Store 直接调用 @tauri-apps/api。
 * ───────────────────────────────────────────────────────────────
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/* ───────────── 类型契约（§5.3）───────────── */

export type ThemeName = 'light' | 'dark' | 'system' | 'high-contrast-light' | 'high-contrast-dark'

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface AppStatus {
  version: string
  platform: string
  arch: string
  tauri: boolean
  devMode: boolean
  ai: { providers: string[]; cloudConfigured: boolean; localRunning: boolean; localModel?: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AIStreamRequest {
  /** provider 名：'cloud' | 'local'，或自定义 */
  provider?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  /** 是否请求思考链（reasoning_content，DeepSeek-R1 等） */
  reasoning?: boolean
}

export interface OpenFilePayload {
  path: string
  content: string
}

export interface AIChatChunk {
  id: string
  delta: string
  reasoning?: string
}

export interface AIChatDone {
  id: string
  full: string
  reasoning?: string
  usage?: { promptTokens?: number; completionTokens?: number }
}

export interface AIChatError {
  id: string
  message: string
}

export interface AIStreamCallbacks {
  onChunk?: (chunk: AIChatChunk) => void
  onDone?: (done: AIChatDone) => void
  onError?: (err: AIChatError) => void
}

export interface CancelToken {
  cancel: () => void
}

export interface SidecarStatus {
  running: boolean
  model?: string
  port?: number
  pid?: number
}

/* ───────────── 内部：实现选择 ───────────── */

interface Impl {
  getStatus(): Promise<AppStatus>
  openFileDialog(filter?: FileFilter[]): Promise<{ path: string; content: string } | null>
  saveFileDialog(defaultName: string, content: string): Promise<string | null>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  writeBinaryFile(path: string, base64: string): Promise<void>
  openExternal(url: string): Promise<void>
  devLog(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): Promise<void>
  exportDiagnostics(): Promise<string | null>
  showLogFile(): Promise<void>
  getArgvMd(): Promise<string | null>
  saveBeforeClose(): Promise<void>
  winMinimize(): Promise<void>
  winToggleMaximize(): Promise<void>
  winClose(): Promise<void>
  winIsMaximized(): Promise<boolean>
  winToggleAlwaysOnTop(): Promise<boolean>
  winIsAlwaysOnTop(): Promise<boolean>
  aiStream(req: AIStreamRequest, id: string, cb: AIStreamCallbacks): CancelToken
  sidecarStart(model?: string): Promise<SidecarStatus>
  sidecarStop(): Promise<void>
  sidecarStatus(): Promise<SidecarStatus>
  onOpenFile(cb: (p: OpenFilePayload) => void): () => void
  onBeforeClose(cb: () => void): () => void
  onWinMaximized(cb: (v: boolean) => void): () => void
  onWinAlwaysOnTop(cb: (v: boolean) => void): () => void
}

/* ───────────── 桌面实现：Tauri（§5.1 命令表）───────────── */

const desktop: Impl = {
  async getStatus() {
    return invoke<AppStatus>('get_status')
  },
  async openFileDialog(filter = [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }]) {
    return invoke<{ path: string; content: string } | null>('open_file_dialog', { filter })
  },
  async saveFileDialog(defaultName, content) {
    return invoke<string | null>('save_dialog', { defaultName, content })
  },
  async readFile(path) {
    return invoke<string>('read_file', { path })
  },
  async writeFile(path, content) {
    await invoke('write_file', { path, content })
  },
  async writeBinaryFile(path, base64) {
    await invoke('write_binary_file', { path, base64 })
  },
  async openExternal(url) {
    await invoke('open_external', { url })
  },
  async devLog(level, message, data) {
    await invoke('dev_log', { level, message, data: data == null ? null : JSON.stringify(data) }).catch(() => {})
  },
  async exportDiagnostics() {
    return invoke<string | null>('export_diagnostics')
  },
  async showLogFile() {
    await invoke('show_log_file')
  },
  async getArgvMd() {
    return invoke<string | null>('get_argv_md')
  },
  async saveBeforeClose() {
    await invoke('save_before_close')
  },
  async winMinimize() {
    await invoke('win_minimize')
  },
  async winToggleMaximize() {
    await invoke('win_toggle_maximize')
  },
  async winClose() {
    await invoke('win_close')
  },
  async winIsMaximized() {
    return invoke<boolean>('win_is_maximized')
  },
  async winToggleAlwaysOnTop() {
    return invoke<boolean>('win_toggle_always_on_top')
  },
  async winIsAlwaysOnTop() {
    return invoke<boolean>('win_is_always_on_top')
  },
  aiStream(req, id, cb) {
    // AI 流式下沉 Rust 代理（§4 D5 / §5.1 ai_stream）：事件回推增量
    let done = false
    const unlisteners: Array<() => void> = []
    const onChunk = listen<AIChatChunk>('ai-chunk', (e) => {
      if (e.payload.id !== id) return
      cb.onChunk?.(e.payload)
    })
    const onDone = listen<AIChatDone>('ai-done', (e) => {
      if (e.payload.id !== id) return
      done = true
      cb.onDone?.(e.payload)
    })
    const onError = listen<AIChatError>('ai-error', (e) => {
      if (e.payload.id !== id) return
      done = true
      cb.onError?.(e.payload)
    })
    Promise.all([onChunk, onDone, onError]).then((u) => {
      unlisteners.push(...u)
    })
    invoke('ai_stream', { req, id }).catch((err) => {
      if (!done) cb.onError?.({ id, message: String(err) })
    })
    return {
      cancel() {
        if (done) return
        invoke('ai_cancel', { id }).catch(() => {})
      },
    }
  },
  async sidecarStart(model) {
    return invoke<SidecarStatus>('sidecar_start', { model })
  },
  async sidecarStop() {
    await invoke('sidecar_stop')
  },
  async sidecarStatus() {
    return invoke<SidecarStatus>('sidecar_status')
  },
  onOpenFile(cb) {
    let un = () => {}
    listen<OpenFilePayload>('open-file', (e) => cb(e.payload)).then((f) => (un = f))
    return () => un()
  },
  onBeforeClose(cb) {
    let un = () => {}
    listen('before-close', () => cb()).then((f) => (un = f))
    return () => un()
  },
  onWinMaximized(cb) {
    let un = () => {}
    listen<boolean>('win-maximized', (e) => cb(e.payload)).then((f) => (un = f))
    return () => un()
  },
  onWinAlwaysOnTop(cb) {
    let un = () => {}
    listen<boolean>('win-always-on-top', (e) => cb(e.payload)).then((f) => (un = f))
    return () => un()
  },
}

/* ───────────── Web 降级实现（§4 D2：Web 为自然降级）───────────── */

async function webReadFileViaInput(): Promise<{ path: string; content: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,.markdown,.txt'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      const content = await file.text()
      resolve({ path: file.name, content })
    }
    input.click()
  })
}

function webWriteFile(path: string, content: string): Promise<void> {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = path.split(/[\\/]/).pop() || 'document.md'
  a.click()
  URL.revokeObjectURL(url)
  return Promise.resolve()
}

async function webSSE(req: AIStreamRequest, id: string, cb: AIStreamCallbacks): Promise<void> {
  const baseUrl = (req.baseUrl || 'https://api.openai.com').replace(/\/$/, '')
  const apiKey = req.apiKey || ''
  const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: req.model || 'gpt-4o-mini',
      messages: req.messages,
      stream: true,
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxTokens,
    }),
  })
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status} ${text.slice(0, 300)}`)
  }
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let full = ''
  let reasoning = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') continue
      try {
        const json = JSON.parse(payload)
        const delta = json.choices?.[0]?.delta ?? {}
        const piece = delta.content ?? ''
        const rPiece = delta.reasoning_content ?? ''
        if (piece) {
          full += piece
          cb.onChunk?.({ id, delta: piece })
        }
        if (rPiece) {
          reasoning += rPiece
          cb.onChunk?.({ id, delta: '', reasoning: rPiece })
        }
      } catch {
        /* 跳过不完整行 */
      }
    }
  }
  cb.onDone?.({ id, full, reasoning, usage: undefined })
}

const web: Impl = {
  async getStatus() {
    return {
      version: '0.1.0-web',
      platform: navigator.platform || 'web',
      arch: 'web',
      tauri: false,
      devMode: false,
      ai: { providers: ['cloud'], cloudConfigured: !!localStorage.getItem('hypora_apiKey'), localRunning: false },
    }
  },
  async openFileDialog() {
    return webReadFileViaInput()
  },
  async saveFileDialog(_defaultName, content) {
    const name = prompt('保存为文件名（.md）', _defaultName) || _defaultName
    await webWriteFile(name, content)
    return name
  },
  async readFile(path) {
    // Web 降级：无任意路径读取，返回占位
    throw new Error('Web 降级模式不支持任意路径读取')
  },
  async writeFile(path, content) {
    await webWriteFile(path, content)
  },
  async writeBinaryFile(_path, base64) {
    const parts = base64.split(',')
    const b64 = parts.length > 1 ? parts[1] : base64
    const byteString = atob(b64)
    const bytes = new Uint8Array(byteString.length)
    for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i)
    const blob = new Blob([bytes])
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = _path.split(/[\\/]/).pop() || 'image.png'
    a.click()
    URL.revokeObjectURL(url)
  },
  async openExternal(url) {
    window.open(url, '_blank')
  },
  async devLog(level, message, data) {
    // 走浏览器 console，供 devtools 查看
    const fn = console[level] || console.log
    fn(`[hypora] ${message}`, data ?? '')
  },
  async exportDiagnostics() {
    const report = `# Hypora Diagnostics\n\n- mode: web\n- userAgent: ${navigator.userAgent}\n`
    await webWriteFile('hypora-diagnostics.md', report)
    return 'hypora-diagnostics.md'
  },
  async showLogFile() {
    console.log('[hypora] web 模式无日志文件')
  },
  async getArgvMd() {
    return null
  },
  async saveBeforeClose() {
    /* 浏览器关闭前由页面自身处理 */
  },
  async winMinimize() {},
  async winToggleMaximize() {
    document.documentElement.requestFullscreen?.().catch(() => {})
  },
  async winClose() {
    window.close()
  },
  async winIsMaximized() {
    return !!document.fullscreenElement
  },
  async winToggleAlwaysOnTop() {
    return false
  },
  async winIsAlwaysOnTop() {
    return false
  },
  aiStream(req, id, cb) {
    let aborted = false
    const controller = new AbortController()
    webSSE({ ...req }, id, {
      onChunk: (c) => !aborted && cb.onChunk?.(c),
      onDone: (d) => !aborted && cb.onDone?.(d),
      onError: (e) => !aborted && cb.onError?.(e),
    }).catch((err: unknown) => {
      if (!aborted) cb.onError?.({ id, message: err instanceof Error ? err.message : String(err) })
    })
    return {
      cancel() {
        aborted = true
        controller.abort()
      },
    }
  },
  async sidecarStart() {
    throw new Error('本地引擎仅桌面模式支持')
  },
  async sidecarStop() {},
  async sidecarStatus() {
    return { running: false }
  },
  onOpenFile() {
    return () => {}
  },
  onBeforeClose() {
    return () => {}
  },
  onWinMaximized() {
    return () => {}
  },
  onWinAlwaysOnTop() {
    return () => {}
  },
}

export const tauriAPI: Impl = IS_TAURI ? desktop : web

/* ───────────── 设置存储（§7：localStorage hypora_*）───────────── */

export const settings = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(`hypora_${key}`)
      if (raw == null) return fallback
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(`hypora_${key}`, JSON.stringify(value))
    } catch {
      /* localStorage 溢出容错（§8）：静默降级为内存态 */
    }
  },
  remove(key: string): void {
    localStorage.removeItem(`hypora_${key}`)
  },
}

export function requestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}
