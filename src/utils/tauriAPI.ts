// 统一 API 适配层：Tauri 环境用 invoke，Web 环境用浏览器 fallback
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export interface OpenFileResult {
  title: string
  content: string
  file_path: string
}

export const tauriAPI = {
  isTauri: (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,

  async openFileDialog(): Promise<OpenFileResult | null> {
    return await invoke<OpenFileResult | null>('open_file_dialog')
  },

  async saveDialog(filename: string): Promise<string | null> {
    return await invoke<string | null>('save_dialog', { filename })
  },

  async writeFile(filePath: string, content: string): Promise<{ success: boolean; error?: string }> {
    return await invoke('write_file', { filePath, content })
  },

  async writeBinaryFile(filePath: string, base64: string): Promise<{ success: boolean; error?: string }> {
    return await invoke('write_binary_file', { filePath, base64 })
  },

  async openExternal(url: string): Promise<void> {
    await invoke('open_external', { url })
  },

  async getDevStatus(): Promise<{ app_version: string; is_dev: boolean; log_file: string } | null> {
    return await invoke('get_status')
  },

  async devLog(level: string, message: string): Promise<void> {
    await invoke('dev_log', { level, message })
  },

  async exportDiagnostics(): Promise<string | null> {
    return await invoke<string | null>('export_diagnostics')
  },

  async showLogFile(): Promise<void> {
    await invoke('show_log_file')
  },

  async saveBeforeClose(filePath: string, content: string): Promise<{ success: boolean }> {
    return await invoke('save_before_close', { filePath, content })
  },

  // ===== 窗口置顶（always-on-top）=====
  async winToggleAlwaysOnTop(): Promise<boolean> {
    return await invoke<boolean>('toggle_always_on_top')
  },

  async winIsAlwaysOnTop(): Promise<boolean> {
    return await invoke<boolean>('is_always_on_top')
  },

  onAlwaysOnTopChange(cb: (isOnTop: boolean) => void) {
    listen('always-on-top-changed', (event: any) => cb(event.payload as boolean))
  },

  // 监听双击文件打开（Rust setup emit 'open-file'）
  onOpenFile(cb: (data: { title: string; content: string; filePath: string }) => void) {
    listen('open-file', (event: any) => cb(event.payload as any))
  },

  // 监听关闭前保存
  onBeforeClose(cb: () => void) {
    listen('before-close', () => cb())
  },
}

// 兼容旧代码：模拟 window.electronAPI（让现有前端代码不用改）
export function setupTauriCompat() {
  if (tauriAPI.isTauri() && !(window as any).electronAPI) {
    ;(window as any).electronAPI = {
      isElectron: true,
      dev: {
        openExternal: (url: string) => tauriAPI.openExternal(url),
        getStatus: () => tauriAPI.getDevStatus(),
        log: (level: string, msg: string) => tauriAPI.devLog(level, msg),
        exportDiagnostics: () => tauriAPI.exportDiagnostics(),
        showLogFile: () => tauriAPI.showLogFile(),
        toggleDevTools: async () => {},
        openDevTools: async () => {},
        reload: async () => location.reload(),
        setDevMode: async () => true,
      },
      showSaveDialog: (name: string) => tauriAPI.saveDialog(name),
      writeFile: (path: string, content: string) => tauriAPI.writeFile(path, content),
      writeBinaryFile: (path: string, base64: string) => tauriAPI.writeBinaryFile(path, base64),
      openFileDialog: () => tauriAPI.openFileDialog(),
      onMenuAction: () => {},
      onOpenFile: (cb: (data: any) => void) => tauriAPI.onOpenFile(cb),
      // ===== 窗口置顶（always-on-top）=====
      winToggleAlwaysOnTop: () => tauriAPI.winToggleAlwaysOnTop(),
      winIsAlwaysOnTop: () => tauriAPI.winIsAlwaysOnTop(),
      onAlwaysOnTopChange: (cb: (isOnTop: boolean) => void) => tauriAPI.onAlwaysOnTopChange(cb),
    }
  }
}