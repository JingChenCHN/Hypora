// 内置本地助手（llama.cpp 引擎）的能力门与类型化封装。
// 仅 Windows Electron 桌面端具备引擎 API（preload 注入 aiEngine*）；
// Web / Tauri 环境无这些 API → hasAiEngine() 为 false，界面降级为「外部 LLM」模式，
// 不渲染任何引擎 UI（模型卡 / 状态行 / 圆点），行为与旧版「本地 LLM」一致。
// 注意：模块顶层绝不触碰 window（web 构建安全），全部经 api() 惰性探测。

export type EnginePhase = 'unknown' | 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'
export type EngineBackend = 'vulkan' | 'cpu' | null

export interface EngineStatus {
  phase: EnginePhase
  backend: EngineBackend
  port: number | null
  baseUrl: string | null
  pid: number | null
  startedAt: number | null
  error: string | null
  model?: string | null    // 当前/最近一次实际加载的模型
}

// 模型目录扫描出的本地模型（GGUF 魔数校验通过，均可选用运行）
export interface EngineLocalModel {
  name: string
  size: number
  isDefault: boolean        // 与内置默认模型同名
}

// 内置下载目录（注册表）：url/bytes 用于按需下载与完整性校验
export interface EngineCatalogModel {
  name: string
  url: string
  bytes: number        // 预期字节数（完整性校验基准，也是下载量预估）
  isDefault: boolean
  present: boolean     // 本地已存在且字节数严格匹配
  size: number         // 实际字节数（未下载为 0）
}

export interface EngineConfig {
  // 目录扫描：models/ 下所有 GGUF（用户自放的模型同样可选）
  models: EngineLocalModel[]
  // 内置下载目录：Q4_K_M（默认）+ Q8_0；本地已有者由渲染层过滤不重复展示
  catalog: EngineCatalogModel[]
  defaultModel: string
  modelExists: boolean             // 兼容字段：目录内有可运行模型即 true
  selectedModel: string | null     // 用户显式选择的模型（engine.json 持久化）
  activeModel: string | null       // 下次 start 实际加载的模型（显式选择优先）
  binRoot: string
  binaries: { vulkan: boolean; cpu: boolean }
}

export interface EngineDownloadState {
  phase: 'idle' | 'downloading' | 'done' | 'error' | 'cancelled'
  model?: string | null    // 正在/最近下载的模型名
  receivedBytes: number
  totalBytes: number
  percent: number
  bytesPerSecond: number
  error: string | null
}

// preload（electron-preload.js）注入的 API 形状
interface ElectronAiEngineApi {
  aiEngineStatus(): Promise<EngineStatus>
  aiEngineStart(): Promise<EngineStatus>
  aiEngineStop(): Promise<EngineStatus>
  aiEngineConfig(): Promise<EngineConfig>
  aiEngineDownload(modelName?: string): Promise<EngineDownloadState>
  aiEngineDownloadCancel(): Promise<EngineDownloadState>
  aiEngineSetModel(modelName: string): Promise<EngineStatus>
  aiEngineOpenModelsDir(): Promise<{ ok: boolean; error?: string }>
  onAiEngineStatus(cb: (s: EngineStatus) => void): () => void
  onAiEngineDownloadProgress(cb: (d: EngineDownloadState) => void): () => void
}

// 能力门：electronAPI.aiEngineStart 为函数才认定引擎可用。
// Tauri 的 setupTauriCompat() 合成的 electronAPI 不含这些 key → 天然为 null，tauriAPI.ts 不用改。
function api(): ElectronAiEngineApi | null {
  if (typeof window === 'undefined') return null
  const e = (window as any).electronAPI
  if (!e || typeof e.aiEngineStart !== 'function') return null
  return e as ElectronAiEngineApi
}

// 是否具备内置助手能力（决定 AIPanel 的「内置助手 vs 外部 LLM」标签与引擎 UI 渲染）
export function hasAiEngine(): boolean {
  return api() !== null
}

// 类型化封装：无引擎环境全部短路（status/config 返回 null，事件订阅返回空函数）
export const engineApi = {
  status: (): Promise<EngineStatus | null> => api()?.aiEngineStatus() ?? Promise.resolve(null),
  config: (): Promise<EngineConfig | null> => api()?.aiEngineConfig() ?? Promise.resolve(null),
  start: (): Promise<EngineStatus | null> => api()?.aiEngineStart() ?? Promise.resolve(null),
  stop: (): Promise<EngineStatus | null> => api()?.aiEngineStop() ?? Promise.resolve(null),
  download: (modelName?: string): Promise<EngineDownloadState | null> => api()?.aiEngineDownload(modelName) ?? Promise.resolve(null),
  downloadCancel: (): Promise<EngineDownloadState | null> => api()?.aiEngineDownloadCancel() ?? Promise.resolve(null),
  setModel: (modelName: string): Promise<EngineStatus | null> => api()?.aiEngineSetModel(modelName) ?? Promise.resolve(null),
  openModelsDir: (): Promise<{ ok: boolean; error?: string } | null> => api()?.aiEngineOpenModelsDir() ?? Promise.resolve(null),
  // 订阅推送；无 API 时返回空函数（消费方无脑调用即可）
  onStatus: (cb: (s: EngineStatus) => void): (() => void) => api()?.onAiEngineStatus(cb) ?? (() => {}),
  onDownload: (cb: (d: EngineDownloadState) => void): (() => void) => api()?.onAiEngineDownloadProgress(cb) ?? (() => {}),
}
