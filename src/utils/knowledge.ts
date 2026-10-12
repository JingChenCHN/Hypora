// 知识库（本地 RAG v2）的能力门与类型化封装。
// 仅 Electron 桌面端具备（preload 注入 kb*）；Web / Tauri 环境无这些 API →
// hasKnowledge() 为 false，界面不渲染任何知识库 UI，对话零感知。
// 注意：模块顶层绝不触碰 window（web 构建安全），全部经 api() 惰性探测。
//
// v2 数据模型：嵌入模型全局共用（kb.json 顶层 model* 字段）；多个知识库
// （kbs[]）各自 sources / 索引目录 / enabled 开关 / topK 等参数；对话时
// 全部启用的库一起检索（主进程按库截取后合并全局排序）。

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
  kbId: string | null
  kbName: string | null
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

// 嵌入模型（全局共用）：指纹 + 健康状态
export interface KbModel {
  ok: boolean
  missing: boolean
  error: string | null
  path: string | null
  size: number | null
  dim: number | null
}

// 单个知识库：配置 + 来源统计（getConfig 快照派生，非持久化字段为 sources/stats）
export interface KbItem {
  id: string
  name: string
  enabled: boolean
  topK: number
  chunkChars: number
  minScore: number
  createdAt: number
  sources: KbSourceEntry[]
  stats: { files: number; chunks: number; stale: number }
}

// getConfig 快照 v2：全局模型 + 总开关 + 库列表 + 聚合统计
export interface KbConfigPayload {
  model: KbModel
  binaries: { vulkan: boolean; cpu: boolean }
  autoInject: boolean
  injectCharBudget: number
  indexDir: string
  indexing: boolean
  indexProgress: KbProgress
  status: KbStatus
  kbs: KbItem[]
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
  kbId?: string
  kbName?: string
}

export interface KbQueryResult {
  hits: KbHit[]
  tookMs: number
}

// 单库可改字段（kb:set-kb 的 patch）
export type KbItemPatch = Partial<Pick<KbItem, 'enabled' | 'topK' | 'chunkChars' | 'minScore'>>

// 全局可改字段（kb:set-config 的 patch）
export type KbGlobalPatch = Partial<Pick<KbConfigPayload, 'autoInject' | 'injectCharBudget'>>

// 配置变更类 IPC 的统一返回（携带刷新后的快照）
export interface KbConfigResult {
  ok: boolean
  error?: string
  config?: KbConfigPayload
}

// preload（electron-preload.js）注入的 API 形状
interface ElectronKbApi {
  kbConfig(): Promise<KbConfigPayload>
  kbSetConfig(patch: KbGlobalPatch): Promise<KbConfigPayload>
  kbCreate(name?: string): Promise<KbConfigResult>
  kbRename(kbId: string, name: string): Promise<KbConfigResult>
  kbDelete(kbId: string): Promise<KbConfigResult>
  kbSetKb(kbId: string, patch: KbItemPatch): Promise<KbConfigResult>
  kbPickModel(): Promise<{ canceled: boolean; path?: string; name?: string; size?: number; error?: string }>
  kbSetModel(modelPath: string): Promise<KbConfigResult>
  kbAddSource(kbId: string): Promise<{ canceled: boolean; dir?: string; error?: string; config?: KbConfigPayload }>
  kbRemoveSource(kbId: string, dir: string): Promise<KbConfigResult>
  kbReindex(opts?: { kbId?: string; force?: boolean }): Promise<{ started: boolean; error?: string; cancelled?: boolean }>
  kbCancelIndex(): Promise<{ cancelled: boolean }>
  kbQuery(text: string, topK?: number): Promise<KbQueryResult>
  kbOpenIndexDir(kbId?: string): Promise<{ ok: boolean; error?: string }>
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
  setConfig: (patch: KbGlobalPatch): Promise<KbConfigPayload | null> => api()?.kbSetConfig(patch) ?? Promise.resolve(null),
  create: (name?: string): Promise<KbConfigResult | null> => api()?.kbCreate(name) ?? Promise.resolve(null),
  rename: (kbId: string, name: string): Promise<KbConfigResult | null> => api()?.kbRename(kbId, name) ?? Promise.resolve(null),
  remove: (kbId: string): Promise<KbConfigResult | null> => api()?.kbDelete(kbId) ?? Promise.resolve(null),
  setKb: (kbId: string, patch: KbItemPatch): Promise<KbConfigResult | null> => api()?.kbSetKb(kbId, patch) ?? Promise.resolve(null),
  pickModel: (): Promise<{ canceled: boolean; path?: string; name?: string; size?: number; error?: string } | null> => api()?.kbPickModel() ?? Promise.resolve(null),
  setModel: (modelPath: string): Promise<KbConfigResult | null> => api()?.kbSetModel(modelPath) ?? Promise.resolve(null),
  addSource: (kbId: string): Promise<{ canceled: boolean; dir?: string; error?: string; config?: KbConfigPayload } | null> => api()?.kbAddSource(kbId) ?? Promise.resolve(null),
  removeSource: (kbId: string, dir: string): Promise<KbConfigResult | null> => api()?.kbRemoveSource(kbId, dir) ?? Promise.resolve(null),
  reindex: (opts?: { kbId?: string; force?: boolean }): Promise<{ started: boolean; error?: string; cancelled?: boolean } | null> => api()?.kbReindex(opts) ?? Promise.resolve(null),
  cancelIndex: (): Promise<{ cancelled: boolean } | null> => api()?.kbCancelIndex() ?? Promise.resolve(null),
  query: (text: string, topK?: number): Promise<KbQueryResult | null> => api()?.kbQuery(text, topK) ?? Promise.resolve(null),
  openIndexDir: (kbId?: string): Promise<{ ok: boolean; error?: string } | null> => api()?.kbOpenIndexDir(kbId) ?? Promise.resolve(null),
  // 订阅推送；无 API 时返回空函数（消费方无脑调用即可）
  onStatus: (cb: (s: KbStatus) => void): (() => void) => api()?.onKbStatus(cb) ?? (() => {}),
  onProgress: (cb: (p: KbProgress) => void): (() => void) => api()?.onKbProgress(cb) ?? (() => {}),
}
