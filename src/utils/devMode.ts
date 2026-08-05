/**
 * 开发者模式工具（§14.1 utils/devMode.ts）
 * 面板化诊断：控制台转发内核日志、一键导出诊断报告（§10 可观测）。
 */
import { tauriAPI, settings, IS_TAURI } from '@/utils/tauriAPI'

let enabled = settings.get<boolean>('devMode', false)

export function isDevMode(): boolean {
  return enabled || new URLSearchParams(location.search).has('dev')
}

export function toggleDevMode(): boolean {
  enabled = !enabled
  settings.set('devMode', enabled)
  if (enabled) installLogBridge()
  return enabled
}

/** 渲染层 console → 内核 dev_log（§5.1 dev_log） */
let installed = false
export function installLogBridge() {
  if (installed) return
  installed = true
  const forward = (level: 'debug' | 'info' | 'warn' | 'error') =>
    (console as unknown as Record<string, (...a: unknown[]) => void>)[level] = (...args: unknown[]) => {
      const msg = args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ')
      void tauriAPI.devLog(level, msg)
    }
  if (!IS_TAURI) return
  try {
    forward('info')
    forward('warn')
    forward('error')
    forward('debug')
  } catch {
    /* 只读环境忽略 */
  }
}

export interface DiagnosticsReport {
  app: { version: string; platform: string; arch: string; tauri: boolean; devMode: boolean }
  system: { userAgent: string; language: string; platform: string }
  doc: { fileName: string; blocks: number; chars: number; dirty: boolean }
  logs: Array<{ level: string; message: string }>
}

const capturedLogs: Array<{ level: string; message: string }> = []
export function captureLog(level: string, message: string) {
  capturedLogs.push({ level, message })
  if (capturedLogs.length > 500) capturedLogs.shift()
}

export async function collectDiagnostics(docStats?: { fileName: string; blocks: number; chars: number; dirty: boolean }): Promise<DiagnosticsReport> {
  const status = await tauriAPI.getStatus()
  return {
    app: {
      version: status.version,
      platform: status.platform,
      arch: status.arch,
      tauri: status.tauri,
      devMode: isDevMode(),
    },
    system: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      platform: navigator.platform,
    },
    doc: docStats ?? { fileName: '—', blocks: 0, chars: 0, dirty: false },
    logs: capturedLogs.slice(-200),
  }
}

export function reportToMarkdown(r: DiagnosticsReport): string {
  const lines: string[] = []
  lines.push('# Hypora 诊断报告', '', '## 应用', ...Object.entries(r.app).map(([k, v]) => `- **${k}**: ${v}`))
  lines.push('', '## 系统', ...Object.entries(r.system).map(([k, v]) => `- **${k}**: ${v}`))
  lines.push('', '## 文档', ...Object.entries(r.doc).map(([k, v]) => `- **${k}**: ${v}`))
  lines.push('', '## 最近日志')
  if (r.logs.length === 0) lines.push('_（无）_')
  for (const l of r.logs.slice(-60)) lines.push(`- \`[${l.level}]\` ${l.message}`)
  return lines.join('\n')
}
