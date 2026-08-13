// 开发者模式工具 - 兼容 Web 和 Electron 两种运行环境

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'

interface DevStatus {
  devMode: boolean
  isDev: boolean
  versions: { app: string; electron: string; chrome: string; node: string }
  platform: { type: string; release: string; arch: string }
  logFile: string
}

interface ElectronAPI {
  isElectron: boolean
  dev?: {
    toggleDevTools: () => Promise<void>
    openDevTools: () => Promise<void>
    reload: (ignoreCache?: boolean) => Promise<void>
    getStatus: () => Promise<DevStatus>
    setDevMode: (enabled: boolean) => Promise<boolean>
    log: (level: LogLevel, message: string) => Promise<boolean>
    exportDiagnostics: () => Promise<string | null>
    showLogFile: () => Promise<string>
    openExternal: (url: string) => Promise<void>
  }
  onMenuAction?: (cb: (action: string) => void) => void
  onOpenFile?: (cb: (data: { title: string; content: string }) => void) => void
  showSaveDialog?: (name: string) => Promise<any>
  writeFile?: (path: string, content: string) => Promise<{ success: boolean; error?: string }>
  // ===== 窗口置顶（always-on-top）=====
  winToggleAlwaysOnTop?: () => Promise<boolean>
  winIsAlwaysOnTop?: () => Promise<boolean>
  onAlwaysOnTopChange?: (cb: (isOnTop: boolean) => void) => void
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}

// 是否在 Electron 环境
export const isElectron = (): boolean => !!window.electronAPI?.isElectron

// 前端日志缓冲区（Web 端兜底显示用）
interface LogEntry {
  time: string
  level: LogLevel
  source: string
  message: string
}
const logBuffer: LogEntry[] = []
const MAX_BUFFER = 500

const listeners: Array<(logs: LogEntry[]) => void> = []
export function onLogUpdate(cb: (logs: LogEntry[]) => void) {
  listeners.push(cb)
  cb([...logBuffer])
  return () => {
    const idx = listeners.indexOf(cb)
    if (idx > -1) listeners.splice(idx, 1)
  }
}

function notifyListeners() {
  const snapshot = [...logBuffer]
  listeners.forEach(cb => cb(snapshot))
}

// 核心：写日志（同时输出到控制台、缓冲区、Electron日志文件）
export function log(level: LogLevel, message: string, source: string = 'renderer') {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  const entry: LogEntry = { time, level, source, message }
  logBuffer.push(entry)
  if (logBuffer.length > MAX_BUFFER) logBuffer.shift()
  notifyListeners()

  // 控制台输出
  const consoleMsg = `[${level}] ${message}`
  if (level === 'ERROR') console.error(consoleMsg)
  else if (level === 'WARN') console.warn(consoleMsg)
  else console.log(consoleMsg)

  // 转发到 Electron 主进程日志文件
  if (isElectron()) {
    window.electronAPI!.dev?.log(level, message).catch(() => {})
  }
}

export const devLog = {
  info: (msg: string) => log('INFO', msg),
  warn: (msg: string) => log('WARN', msg),
  error: (msg: string) => log('ERROR', msg),
  debug: (msg: string) => log('DEBUG', msg)
}

// 全局错误捕获 - 任何未捕获的错误都会被记录
export function setupGlobalErrorHandler() {
  window.addEventListener('error', (event) => {
    const msg = `${event.message} @ ${event.filename}:${event.lineno}:${event.colno}`
    log('ERROR', `JS错误: ${msg}`)
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason instanceof Error
      ? `${event.reason.message}\n${event.reason.stack}`
      : String(event.reason)
    log('ERROR', `未处理的Promise拒绝: ${reason}`)
  })
  // Vue 运行时错误由 App.vue 的 errorHandler 转发到这里
  log('INFO', '全局错误捕获已就绪')
}

// 获取开发环境状态
export async function getDevStatus(): Promise<DevStatus | null> {
  if (!isElectron()) return null
  return await window.electronAPI!.dev!.getStatus()
}

// 切换 DevTools
export async function toggleDevTools() {
  if (!isElectron()) {
    devLog.warn('Web 端不支持 DevTools 控制，请按 F12 手动打开浏览器开发者工具')
    return
  }
  await window.electronAPI!.dev!.toggleDevTools()
  devLog.info('切换 DevTools')
}

// 打开反馈链接
export async function openFeedback() {
  const url = 'https://github.com/hypora/hypora/issues/new'
  if (isElectron()) {
    await window.electronAPI!.dev!.openExternal(url)
  } else {
    window.open(url, '_blank')
  }
}

// 导出诊断报告
export async function exportDiagnostics(extraInfo?: string): Promise<boolean> {
  if (!isElectron()) {
    // Web 端：导出一份简化诊断信息
    const report = buildWebDiagnostics(extraInfo)
    const blob = new Blob([report], { type: 'text/markdown;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `Hypora-诊断报告-${new Date().toISOString().slice(0, 10)}.md`
    a.click()
    URL.revokeObjectURL(a.href)
    devLog.info('Web 端诊断报告已下载')
    return true
  }
  const result = await window.electronAPI!.dev!.exportDiagnostics()
  return !!result
}

function buildWebDiagnostics(extraInfo?: string): string {
  const nav = navigator
  const logs = logBuffer.map(l => `[${l.time}] [${l.level}] [${l.source}] ${l.message}`).join('\n')
  return `# Hypora 诊断报告（Web 端）

> 生成时间: ${new Date().toLocaleString('zh-CN')}

## 一、环境信息
- 运行环境: Web 浏览器
- UserAgent: ${nav.userAgent}
- 平台: ${nav.platform}
- 语言: ${nav.language}
- 屏幕分辨率: ${screen.width}x${screen.height}
- 视口: ${window.innerWidth}x${window.innerHeight}
- 在线状态: ${nav.onLine}

## 二、补充信息
${extraInfo || '（无）'}

## 三、控制台日志（最近 ${logBuffer.length} 条）
\`\`\`
${logs || '（无）'}
\`\`\`

## 四、问题反馈
请描述遇到的问题：你做了什么操作？期望结果？实际结果？是否能稳定复现？
`
}

// 获取日志缓冲（供面板展示）
export function getLogs(): LogEntry[] {
  return [...logBuffer]
}

// 清空日志缓冲
export function clearLogs() {
  logBuffer.length = 0
  notifyListeners()
  devLog.info('日志已清空')
}