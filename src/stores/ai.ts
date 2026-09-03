import { defineStore } from 'pinia'
import { ref } from 'vue'
import { streamChat, testConnection as testConn, type ChatMessage, type ContentPart } from '@/utils/deepseek'
import { useAuthStore, authNeeded } from '@/stores/auth'
import { chatGet, chatPut, chatDelete, type ChatPayload } from '@/utils/authApi'

// 预填的默认 key（用户可在面板配置区修改，持久化到 localStorage）
// 注意：真实 key 已从仓库移除（公开仓库不应含密钥）。首次使用请在配置区填写自己的 key。
const DEFAULT_KEY = ''
const DEFAULT_MODEL = 'deepseek-v4-flash'
const DEFAULT_BASE_DEEPSEEK = 'https://api.deepseek.com'
const DEFAULT_BASE_LOCAL = 'http://127.0.0.1:8899'

// GLM(智谱)识图：GLM-4V-Flash，多模态，支持图文
const DEFAULT_BASE_GLM = 'https://open.bigmodel.cn/api/paas/v4'
const DEFAULT_GLM_KEY = ''
const DEFAULT_GLM_MODEL = 'glm-5.3-flash'

export type AIProvider = 'deepseek' | 'local' | 'glm'

// 选区快捷操作的预设 prompt 前缀
export const AI_PRESETS: Record<string, string> = {
  rewrite: '请改写下面这段文字，保持原意，表达更清晰流畅，输出 Markdown：',
  explain: '请解释下面这段文字的含义，输出 Markdown：',
  translate: '请把下面这段文字翻译（若为中文则译成英文，若为英文则译成中文），输出 Markdown：',
  expand: '请基于下面这段文字扩写，补充合理细节，保持风格一致，输出 Markdown：',
  summarize: '请用简洁的要点总结下面这段文字，输出 Markdown 无序列表：'
}

export const useAIStore = defineStore('ai', () => {
  const apiKey = ref(DEFAULT_KEY)
  const model = ref(DEFAULT_MODEL)
  const thinking = ref(false)
  const provider = ref<AIProvider>('deepseek')
  const baseUrl = ref(DEFAULT_BASE_DEEPSEEK)
  const localModel = ref('')
  // GLM 识图模式独立的 key/model（与 DeepSeek key 分开持久化）
  const glmKey = ref(DEFAULT_GLM_KEY)
  const glmModel = ref(DEFAULT_GLM_MODEL)
  const panelVisible = ref(false)
  const messages = ref<ChatMessage[]>([])
  // 每条消息的思考链（reasoning_content）单独存放，与 .content 分离，避免污染正文。
  // 长度与 messages 对齐；助手消息的思考链只在面板折叠展示，不随「插入/复制」进编辑器。
  const reasonings = ref<string[]>([])
  const loading = ref(false)
  // 待发送的图片（base64 data URL），仅 GLM 识图模式使用，发送后清空
  const pendingImages = ref<string[]>([])
  let controller: AbortController | null = null

  // ===== 聊天记录按用户持久化（仅网页登录用户；桌面版/未登录不持久化） =====
  const authStore = useAuthStore()
  const chatRev = ref(0)
  let chatSaveTimer: number | null = null
  let chatSaving = false
  let restoreDone = false

  async function restoreChats() {
    if (restoreDone) return
    restoreDone = true
    try {
      const r = await chatGet()
      // 仅本地为空时恢复，避免覆盖用户正在进行的对话
      if (messages.value.length === 0 && Array.isArray(r.messages) && r.messages.length > 0) {
        messages.value = r.messages as ChatMessage[]
        reasonings.value = r.reasonings as string[]
        chatRev.value = r.rev || 0
      }
    } catch (e: any) {
      if (e?.status === 401) authStore.onUnauthorized()
      // 其他错误静默：恢复失败不影响使用
    }
  }

  // 服务端存档 2MB 上限的两级降级：
  // 1) 多模态消息里的图片 data URL 换占位符（图已发给模型，存档不需要原图，单张可达 10MB）
  // 2) 仍超限则只保留最近 40 条
  const CHAT_SAVE_LIMIT = 2 * 1024 * 1024 - 16 * 1024
  function payloadBytes(payload: ChatPayload) {
    return new TextEncoder().encode(JSON.stringify(payload)).length
  }
  function stripImages(list: ChatMessage[]): ChatMessage[] {
    return list.map((m) => {
      if (!Array.isArray(m.content)) return m
      return {
        ...m,
        content: m.content.map((p) =>
          p.type === 'image_url' ? ({ type: 'image_url', image_url: { url: '[图片已省略]' } } as ContentPart) : p
        ),
      }
    })
  }
  function trimForSave(): ChatPayload {
    let list = messages.value.slice()
    let reasons = reasonings.value.slice()
    let payload: ChatPayload = { messages: list, reasonings: reasons }
    if (payloadBytes(payload) <= CHAT_SAVE_LIMIT) return payload
    list = stripImages(list)
    payload = { messages: list, reasonings: reasons }
    if (payloadBytes(payload) <= CHAT_SAVE_LIMIT) return payload
    const cut = Math.max(0, list.length - 40)
    return { messages: list.slice(cut), reasonings: reasons.slice(cut) }
  }

  function scheduleChatSave() {
    if (!authNeeded() || !authStore.me) return
    if (chatSaveTimer) clearTimeout(chatSaveTimer)
    chatSaveTimer = window.setTimeout(() => { void saveChatsNow() }, 800)
  }

  async function saveChatsNow(): Promise<boolean> {
    if (!authNeeded() || !authStore.me || chatSaving) return false
    chatSaving = true
    try {
      try {
        const r = await chatPut(trimForSave())
        chatRev.value = r.rev
        return true
      } catch (e: any) {
        if (e?.status === 401) {
          // 会话过期：门禁浮现；内存对话保留，重新登录后下次发送会续传
          authStore.onUnauthorized()
        }
        // 413/网络错误：静默，下次发送再试（trimForSave 已两级降级，413 理论少见）
        return false
      }
    } finally {
      chatSaving = false
    }
  }

  function init() {
    const k = localStorage.getItem('hypora_ai_apikey')
    apiKey.value = k || DEFAULT_KEY
    const m = localStorage.getItem('hypora_ai_model')
    model.value = m || DEFAULT_MODEL
    const t = localStorage.getItem('hypora_ai_thinking')
    thinking.value = t === 'true'
    const p = localStorage.getItem('hypora_ai_provider') as AIProvider | null
    provider.value = p || 'deepseek'
    const b = localStorage.getItem('hypora_ai_baseurl')
    baseUrl.value = b || (provider.value === 'local' ? DEFAULT_BASE_LOCAL : provider.value === 'glm' ? DEFAULT_BASE_GLM : DEFAULT_BASE_DEEPSEEK)
    const lm = localStorage.getItem('hypora_ai_localmodel')
    localModel.value = lm || ''
    // GLM key/model 独立持久化（与 DeepSeek key 分开），重启后恢复用户配置
    const gk = localStorage.getItem('hypora_ai_glmkey')
    if (gk) glmKey.value = gk
    const gm = localStorage.getItem('hypora_ai_glmmodel')
    if (gm) glmModel.value = gm
    const pv = localStorage.getItem('hypora_ai_panel')
    panelVisible.value = pv === 'true'
    // 登录用户从服务器恢复聊天记录（App 侧保证 init 在会话确认后才调用）
    if (authNeeded() && authStore.me) void restoreChats()
  }

  function saveToLocal() {
    localStorage.setItem('hypora_ai_apikey', apiKey.value)
    localStorage.setItem('hypora_ai_model', model.value)
    localStorage.setItem('hypora_ai_thinking', String(thinking.value))
    localStorage.setItem('hypora_ai_provider', provider.value)
    localStorage.setItem('hypora_ai_baseurl', baseUrl.value)
    localStorage.setItem('hypora_ai_localmodel', localModel.value)
    localStorage.setItem('hypora_ai_glmkey', glmKey.value)
    localStorage.setItem('hypora_ai_glmmodel', glmModel.value)
    localStorage.setItem('hypora_ai_panel', String(panelVisible.value))
  }

  // 切换引擎并重置 baseUrl 默认值
  function setProvider(p: AIProvider) {
    provider.value = p
    baseUrl.value = p === 'local' ? DEFAULT_BASE_LOCAL : p === 'glm' ? DEFAULT_BASE_GLM : DEFAULT_BASE_DEEPSEEK
    saveToLocal()
  }

  // ===== 图片管理（GLM 识图模式）=====
  const MAX_IMAGES = 5
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 10MB / 张

  function addImage(dataUrl: string): { ok: boolean; error?: string } {
    if (provider.value !== 'glm') return { ok: false, error: '请先切换到 GLM 引擎（并选识图模型）' }
    if (pendingImages.value.length >= MAX_IMAGES) return { ok: false, error: `最多 ${MAX_IMAGES} 张图片` }
    // data URL base64 部分大小估算（非精确，仅拦截超大文件）
    const b64 = dataUrl.split(',')[1] || ''
    if (b64.length > MAX_IMAGE_BYTES * 1.37) return { ok: false, error: `图片过大（上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB）` }
    pendingImages.value = [...pendingImages.value, dataUrl]
    return { ok: true }
  }

  function removeImage(i: number) {
    pendingImages.value = pendingImages.value.filter((_, idx) => idx !== i)
  }

  function clearImages() {
    pendingImages.value = []
  }

  async function testConnection(): Promise<{ ok: boolean; info?: string; error?: string }> {
    const isLocal = provider.value === 'local'
    return await testConn(baseUrl.value, isLocal ? undefined : apiKey.value)
  }

  function togglePanel() {
    panelVisible.value = !panelVisible.value
    saveToLocal()
  }

  function clearMessages() {
    if (loading.value) return
    messages.value = []
    reasonings.value = []
    clearImages()
    chatRev.value = 0
    // 登录用户同步清空服务器存档
    if (authNeeded() && authStore.me) void chatDelete().catch(() => {})
  }

  function stop() {
    controller?.abort()
    controller = null
    loading.value = false
  }

  /**
   * 发送一条消息。
   * @param prompt 用户输入或预设 prompt
   * @param ctx.selection 当前编辑器选中文本（选区操作时传入）
   * @param ctx.doc 当前整篇文档（”带入当前文档”时传入）
   */
  async function send(prompt: string, ctx: { selection?: string; doc?: string } = {}) {
    if (loading.value) return
    const isLocal = provider.value === 'local'
    const isGlm = provider.value === 'glm'
    const hasImages = pendingImages.value.length > 0

    if (isGlm) {
      if (!glmKey.value.trim()) {
        messages.value.push({ role: 'assistant', content: '⚠️ 请先在配置区填写 GLM API Key。' })
        reasonings.value.push('')
        return
      }
    } else if (!isLocal && !apiKey.value.trim()) {
      messages.value.push({ role: 'assistant', content: '⚠️ 请先在配置区填写 API Key。' })
      reasonings.value.push('')
      return
    }

    // 构造用户消息：GLM 识图模式且有图片时用多模态 content 数组，否则纯文本
    let userContent: string | ContentPart[]
    const textParts: string[] = [prompt]
    if (ctx.selection && ctx.selection.trim()) textParts.push('--- 选中文本 ---\n' + ctx.selection)
    if (ctx.doc && ctx.doc.trim()) textParts.push('--- 当前文档 ---\n' + ctx.doc)
    const fullText = textParts.join('\n\n')

    if (isGlm && hasImages) {
      const parts: ContentPart[] = []
      if (fullText.trim()) parts.push({ type: 'text', text: fullText })
      for (const img of pendingImages.value) parts.push({ type: 'image_url', image_url: { url: img } })
      userContent = parts
    } else {
      userContent = fullText
    }

    messages.value.push({ role: 'user', content: userContent })
    reasonings.value.push('')
    messages.value.push({ role: 'assistant', content: '' })
    reasonings.value.push('')
    const aiIdx = messages.value.length - 1

    loading.value = true
    controller = new AbortController()
    try {
      // 历史含本次 user，不含末尾空 assistant 占位
      const sysContent = isGlm
        ? '你是 Hypora 内置的 AI 助手，具备图像理解能力。用户上传图片时，请详细提取并描述图片内容（包括文字、表格、图表、图形、场景、人物等所有可见信息），输出结构化 Markdown。'
        : '你是 Hypora 内置的 AI 写作助手。用户在 Markdown 编辑器中写作，你的回复使用 Markdown 格式，简洁实用。'
      const history: ChatMessage[] = [
        { role: 'system', content: sysContent },
        ...messages.value.slice(0, aiIdx)
      ]
      await streamChat({
        baseUrl: baseUrl.value,
        apiKey: isLocal ? undefined : (isGlm ? glmKey.value : apiKey.value),
        model: isLocal ? (localModel.value.trim() || undefined) : (isGlm ? glmModel.value : model.value),
        messages: history,
        path: isGlm ? '/chat/completions' : undefined,
        thinking: !isLocal && !isGlm && thinking.value,
        onChunk: (delta) => { messages.value[aiIdx].content += delta },
        // 思考链单独收集，不混入正文（避免嵌入编辑器时带一堆冗余思考）
        onReasoning: (delta) => { reasonings.value[aiIdx] += delta },
        signal: controller.signal
      })
      if (!messages.value[aiIdx].content) {
        messages.value[aiIdx].content = '（空回复）'
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        // 用户主动停止，保留已生成内容
      } else {
        const hint = isLocal ? '\n\n（请确认 local-ai-engine 已启动：运行 启动.bat，使 llama-server 运行于该地址）'
          : isGlm ? '\n\n（请确认 GLM API Key 有效，且网络可访问 open.bigmodel.cn）' : ''
        messages.value[aiIdx].content += `\n\n⚠️ ${e?.message || e}${hint}`
      }
    } finally {
      loading.value = false
      controller = null
      if (hasImages) clearImages()
      // 本轮对话已定格（含空回复/中止/出错分支），防抖保存到服务器
      scheduleChatSave()
    }
  }

  return {
    apiKey, model, thinking, provider, baseUrl, localModel, glmKey, glmModel, panelVisible, messages, reasonings, loading, pendingImages,
    init, saveToLocal, setProvider, testConnection, togglePanel, clearMessages, stop, send, addImage, removeImage, clearImages
  }
})
