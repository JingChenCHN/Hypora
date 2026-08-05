/**
 * AI Store（§6.2 AI 管线 / §5.1 ai_stream）
 * 选区/全文上下文组装 → provider 选择 → ai_stream（SSE）→ 增量渲染 → 确认回编辑器。
 */
import { defineStore } from 'pinia'
import {
  tauriAPI,
  settings,
  requestId,
  type AIStreamRequest,
  type ChatMessage,
  type CancelToken,
  type SidecarStatus,
} from '@/utils/tauriAPI'
import { AI_ASSISTANT_SYSTEM, providerById } from '@/utils/deepseek'

/** 对话消息：在 ChatMessage 基础上附带思考链（reasoning_content，§4 D3） */
export interface AiMessage extends ChatMessage {
  reasoning?: string
}

export const useAIStore = defineStore('ai', {
  state: () => ({
    providerId: settings.get<string>('ai_provider', 'deepseek'),
    customBaseUrl: settings.get<string>('ai_baseUrl', ''),
    customModel: settings.get<string>('ai_model', ''),
    apiKey: settings.get<string>('ai_apiKey', ''),
    cloudModel: settings.get<string>('ai_cloudModel', ''),
    localModel: settings.get<string>('ai_localModel', 'llama-3.2-1b-instruct'),
    reasoningEnabled: settings.get<boolean>('ai_reasoning', true),
    streaming: false,
    messages: [] as AiMessage[],
    currentText: '',
    currentReasoning: '',
    error: null as string | null,
    sidecar: { running: false } as SidecarStatus,
    active: null as CancelToken | null,
    activeId: '',
    /** 最近对话（快速复用） */
    recent: settings.get<Array<{ q: string; a: string; ts: string }>>('ai_recent', []),
  }),

  getters: {
    preset: (s) => providerById(s.providerId),
    providerLabel(): string {
      return providerById(this.providerId)?.label ?? '未选择'
    },
    effectiveBaseUrl(): string {
      if (this.providerId === 'local') return this.preset?.baseUrl ?? ''
      if (this.providerId === 'custom') return this.customBaseUrl
      return this.preset?.baseUrl ?? ''
    },
    effectiveModel(): string {
      if (this.providerId === 'local') return this.localModel
      if (this.providerId === 'custom') return this.customModel
      return this.cloudModel || this.preset?.defaultModel || ''
    },
    configured(): boolean {
      const p = this.preset
      if (!p) return false
      if (p.kind === 'local') return true
      if (p.needsKey && !this.apiKey) return false
      return !!this.effectiveBaseUrl
    },
  },

  actions: {
    init() {
      // 启动时刷新 sidecar 状态（P3 本地引擎）
      this.refreshSidecar()
    },

    setProvider(id: string) {
      this.providerId = id
      settings.set('ai_provider', id)
    },
    saveKey(key: string) {
      this.apiKey = key
      settings.set('ai_apiKey', key)
    },

    /** 流式对话：返回确认文本；失败抛错 */
    async streamPrompt(system: string, user: string): Promise<{ full: string; reasoning: string }> {
      if (this.streaming) this.cancel()

      const id = requestId()
      this.activeId = id
      this.streaming = true
      this.error = null
      this.currentText = ''
      this.currentReasoning = ''

      const messages: ChatMessage[] = [{ role: 'system', content: system || AI_ASSISTANT_SYSTEM }]
      // 带入最近对话上下文（最多 6 条）
      for (const m of this.messages.slice(-6)) messages.push(m)
      messages.push({ role: 'user', content: user })

      const req: AIStreamRequest = {
        provider: this.providerId,
        baseUrl: this.effectiveBaseUrl,
        apiKey: this.apiKey,
        model: this.effectiveModel,
        messages,
        reasoning: this.reasoningEnabled,
      }

      return new Promise<{ full: string; reasoning: string }>((resolve, reject) => {
        this.active = tauriAPI.aiStream(req, id, {
          onChunk: ({ delta, reasoning }) => {
            if (reasoning) this.currentReasoning += reasoning
            else this.currentText += delta
          },
          onDone: ({ full, reasoning }) => {
            this.streaming = false
            this.active = null
            this.pushRecent(user, full || this.currentText)
            resolve({ full: full || this.currentText, reasoning: reasoning || this.currentReasoning })
          },
          onError: ({ message }) => {
            this.streaming = false
            this.active = null
            this.error = message
            reject(new Error(message))
          },
        })
      })
    },

    cancel() {
      this.active?.cancel()
      this.active = null
      this.streaming = false
    },

    resetConversation() {
      this.cancel()
      this.messages = []
      this.currentText = ''
      this.currentReasoning = ''
      this.error = null
    },

    pushRecent(q: string, a: string) {
      this.recent.unshift({ q: q.slice(0, 200), a: a.slice(0, 500), ts: new Date().toISOString() })
      this.recent = this.recent.slice(0, 20)
      settings.set('ai_recent', this.recent)
    },

    useRecent(item: { q: string; a: string }) {
      this.messages = [
        { role: 'user', content: item.q },
        { role: 'assistant', content: item.a },
      ]
    },

    /* ── 本地引擎 sidecar（§4 D4 / §5.1） ── */
    async startLocal(model?: string) {
      this.sidecar = await tauriAPI.sidecarStart(model || this.localModel)
      return this.sidecar
    },
    async stopLocal() {
      await tauriAPI.sidecarStop()
      this.sidecar = { running: false }
    },
    async refreshSidecar() {
      try {
        this.sidecar = await tauriAPI.sidecarStatus()
      } catch {
        this.sidecar = { running: false }
      }
    },
  },
})
