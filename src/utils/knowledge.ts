// 知识库（本地 RAG）的能力门与类型化封装。
// 仅 Electron 桌面端具备（preload 注入 kb*）；Web / Tauri 环境无这些 API →
// hasKnowledge() 为 false，界面不渲染任何知识库 UI，对话零感知。
// 注意：模块顶层绝不触碰 window（web 构建安全），全部经 api() 惰性探测。

export type KbPhase = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'
export type KbBackend = 'cpu' | 'vulkan' | null

export interface KbStatus {
  phase: KbPhase
  backend: KbBackend
  port: number | null
  baseUrl: string | null
  model: string | null
  pid: number | null
  startedAt: number | null
  error: string | null
  modelMissing: boolean
  dim: number | null
}

export interface KbProgress {
  runId: number
  phase: 'idle' | 'scanning' | 'embedding' | 'saving' | 'done' | 'cancelled' | 'error'
  dir: string | null
  file: string | null
  done: number
  total: number
  chunks: number
  error: string | null
}

export interface KbSourceConfig {
  dir: string
  addedAt: number
}

export interface KbConfig {
  modelPath: string | null
  enabled: boolean
  topK: number
  chunkChars: number
  minScore: number
  injectCharBudget: number
  sources: KbSourceConfig[]
  dim: number | null
}

// getConfig 快照：config + 模型/服务状态 + 来源统计 + 索引总量
export interface KbConfigPayload {
  config: KbConfig
  modelOk: boolean
  modelMissing: boolean
  modelError: string | null
  modelSize: number | null
  binaries: { vulkan: boolean; cpu: boolean }
  indexDir: string
  indexing: boolean
  indexProgress: KbProgress
  status: KbStatus
  sources: KbSourceEntry[]
  totals: { files: number; chunks: number }
  staleTotal: number
}

// 来源统计（扫描派生，非持久化）
export interface KbSourceEntry extends KbSourceConfig {
  fileCount: number
  chunkCount: number
  indexedFiles: number
  staleCount: number
  missing: boolean
  bytes: number
}

export interface KbHit {
  path: string
  title: string
  dir: string
  heading: string
  text: string
  score: number
}

export interface KbQueryResult {
  hits: KbHit[]
  tookMs: number
}

// preload（electron-preload.js）注入的 API 形状
interface ElectronKbApi {
  kbConfig(): Promise<KbConfigPayload>
  kbSetConfig(patch: Partial<Pick<KbConfig, 'enabled' | 'topK' | 'chunkChars' | 'minScore' | 'injectCharBudget'>>): Promise<KbConfigPayload>
  kbPickModel(): Promise<{ canceled: boolean; path?: string; name?: string; size?: number; error?: string }>
  kbSetModel(modelPath: string): Promise<{ ok: boolean; error?: string; config?: KbConfigPayload }>
  kbAddSource(): Promise<{ canceled: boolean; dir?: string; error?: string; config?: KbConfigPayload }>
  kbRemoveSource(dir: string): Promise<{ ok: boolean; error?: string; config?: KbConfigPayload }>
  kbReindex(opts?: { dir?: string; force?: boolean }): Promise<{ started: boolean }>
  kbCancelIndex(): Promise<{ cancelled: boolean }>
  kbQuery(text: string, topK?: number): Promise<KbQueryResult>
  kbOpenIndexDir(): Promise<{ ok: boolean; error?: string }>
  onKbStatus(cb: (s: KbStatus) => void): () => void
  onKbProgress(cb: (p: KbProgress) => void): () => void
}

// 能力门：electronAPI.kbQuery 为函数才认定知识库可用。
// Tauri 的 setupTauriCompat() 合成的 electronAPI 不含这些 key → 天然为 false。
function api(): ElectronKbApi | null {
  if (typeof window === 'undefined') return null
  const e = (window as any).electronAPI
  if (!e || typeof e.kbQuery !== 'function') return null
  return e as ElectronKbApi
}

export function hasKnowledge(): boolean {
  return api() !== null
}

// 类型化封装：无知识库环境全部短路（config/query 返回 null，事件订阅返回空函数）
export const kbApi = {
  config: (): Promise<KbConfigPayload | null> => api()?.kbConfig() ?? Promise.resolve(null),
  setConfig: (patch: Partial<Pick<KbConfig, 'enabled' | 'topK' | 'chunkChars' | 'minScore' | 'injectCharBudget'>>): Promise<KbConfigPayload | null> => api()?.kbSetConfig(patch) ?? Promise.resolve(null),
  pickModel: (): Promise<{ canceled: boolean; path?: string; name?: string; size?: number; error?: string } | null> => api()?.kbPickModel() ?? Promise.resolve(null),
  setModel: (modelPath: string): Promise<{ ok: boolean; error?: string; config?: KbConfigPayload } | null> => api()?.kbSetModel(modelPath) ?? Promise.resolve(null),
  addSource: (): Promise<{ canceled: boolean; dir?: string; error?: string; config?: KbConfigPayload } | null> => api()?.kbAddSource() ?? Promise.resolve(null),
  removeSource: (dir: string): Promise<{ ok: boolean; error?: string; config?: KbConfigPayload } | null> => api()?.kbRemoveSource(dir) ?? Promise.resolve(null),
  reindex: (opts?: { dir?: string; force?: boolean }): Promise<{ started: boolean } | null> => api()?.kbReindex(opts) ?? Promise.resolve(null),
  cancelIndex: (): Promise<{ cancelled: boolean } | null> => api()?.kbCancelIndex() ?? Promise.resolve(null),
  query: (text: string, topK?: number): Promise<KbQueryResult | null> => api()?.kbQuery(text, topK) ?? Promise.resolve(null),
  openIndexDir: (): Promise<{ ok: boolean; error?: string } | null> => api()?.kbOpenIndexDir() ?? Promise.resolve(null),
  // 订阅推送；无 API 时返回空函数（消费方无脑调用即可）
  onStatus: (cb: (s: KbStatus) => void): (() => void) => api()?.onKbStatus(cb) ?? (() => {}),
  onProgress: (cb: (p: KbProgress) => void): (() => void) => api()?.onKbProgress(cb) ?? (() => {}),
}
