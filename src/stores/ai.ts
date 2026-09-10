import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { streamChat, testConnection as testConn, type ChatMessage, type ContentPart } from '@/utils/deepseek'
import { hasAiEngine, engineApi, type EnginePhase, type EngineStatus, type EngineConfig, type EngineDownloadState } from '@/utils/aiEngine'
import { useAuthStore, authNeeded } from '@/stores/auth'
import { chatGet, chatPut, type ChatPayload } from '@/utils/authApi'

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

// 一段对话（会话）。登录用户整表持久化到服务器 /api/chats；桌面版/未登录落到 localStorage。
export interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  reasonings: string[]
  // 用户手动改过名后不再自动按首条消息重命名
  manualTitle?: boolean
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
  const loading = ref(false)
  // 待发送的图片（base64 data URL），仅 GLM 识图模式使用，发送后清空
  const pendingImages = ref<string[]>([])
  let controller: AbortController | null = null

  // ===== 内置本地助手（llama.cpp 引擎，仅 Windows Electron 桌面端）=====
  // 引擎状态仅由主进程 IPC push 驱动；Web/Tauri 无引擎（hasAiEngine() false）时保持初值并走外部模式。
  const enginePhase = ref<EnginePhase>('unknown')
  const engineBackend = ref<'vulkan' | 'cpu' | null>(null)
  const enginePort = ref<number | null>(null)
  const engineError = ref<string | null>(null)
  const engineModel = ref<EngineConfig | null>(null)
  const engineDownload = ref<EngineDownloadState | null>(null)
  // 本地引擎使用方式：managed=内置助手（主进程托管）；external=外部 llama-server（高级选项）
  const localMode = ref<'managed' | 'external'>(hasAiEngine() ? 'managed' : 'external')
  const engineRunning = computed(() => enginePhase.value === 'running')
  const engineStarting = computed(() => enginePhase.value === 'starting')
  // 托管端点：运行中用引擎协商出的实际端口（8899 被占时自动漂移），否则回落默认地址
  const engineBaseUrl = computed(() => (engineRunning.value && enginePort.value ? `http://127.0.0.1:${enginePort.value}` : DEFAULT_BASE_LOCAL))
  // 🔴🟢 状态点：运行中绿 / 失败红 / 其余灰（面板状态行与工具栏徽标共用）
  const engineDot = computed(() => (engineRunning.value ? 'ok' : enginePhase.value === 'failed' ? 'err' : 'off'))
  const engineStatusText = computed(() => {
    switch (enginePhase.value) {
      case 'running': return `运行中 · ${engineBackend.value === 'vulkan' ? 'GPU' : 'CPU'} :${enginePort.value ?? ''}`
      case 'starting': return '启动中…'
      case 'failed': return '启动失败'
      case 'unknown': return '检测中…'
      default: return engineModel.value && !engineModel.value.modelExists ? '未下载模型' : '已停止'
    }
  })

  // ===== 多会话（对话记录）=====
  // 每个会话独立的消息/思考链；登录用户整表持久化到服务器，桌面版持久化到 localStorage。
  const chats = ref<ChatSession[]>([])
  const activeChatId = ref('')
  const activeChat = computed<ChatSession | null>(() =>
    chats.value.find((c) => c.id === activeChatId.value) || null
  )

  function newSession(): ChatSession {
    return {
      id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36),
      title: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      reasonings: [],
    }
  }

  // 无活动会话时补一个（删除全部/首次使用时兜底）
  function ensureActiveChat(): ChatSession {
    let c = activeChat.value
    if (!c) {
      c = newSession()
      chats.value.push(c)
      activeChatId.value = c.id
    }
    return c
  }

  // 当前会话的消息与思考链（面板直接消费；无会话时空表）
  const messages = computed<ChatMessage[]>(() => activeChat.value?.messages ?? [])
  const reasonings = computed<string[]>(() => activeChat.value?.reasonings ?? [])

  // 会话标题：优先取选中文本首行，否则取输入首行，截 24 字
  function deriveTitle(prompt: string, ctx: { selection?: string; doc?: string }): string {
    const src = (ctx.selection || '').split('\n').map((s) => s.trim()).find(Boolean)
      || prompt.split('\n').map((s) => s.trim()).find(Boolean) || ''
    if (!src) return ''
    return src.slice(0, 24) + (src.length > 24 ? '…' : '')
  }

  // 消息内容取纯文本（多模态取 text 片段；用于恢复自动命名）
  function asPlainText(content: ChatMessage['content'] | undefined): string {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content.filter((p) => p.type === 'text').map((p) => p.text || '').join(' ')
  }

  function newChat(): ChatSession {
    // 当前会话还是空的：直接沿用，避免堆出一排「未命名」空会话
    const cur = activeChat.value
    if (cur && cur.messages.length === 0) return cur
    const c = newSession()
    chats.value.push(c)
    activeChatId.value = c.id
    scheduleChatSave()
    return c
  }

  function switchChat(id: string) {
    if (!chats.value.some((c) => c.id === id)) return
    activeChatId.value = id
    scheduleChatSave() // 记住活动会话
  }

  function deleteChat(id: string) {
    if (loading.value && activeChatId.value === id) return // 生成中不可删当前会话
    const idx = chats.value.findIndex((c) => c.id === id)
    if (idx === -1) return
    chats.value.splice(idx, 1)
    if (activeChatId.value === id) {
      const next = chats.value[Math.min(idx, chats.value.length - 1)]
      if (next) activeChatId.value = next.id
      else { const c = newSession(); chats.value.push(c); activeChatId.value = c.id }
    }
    scheduleChatSave()
  }

  function renameChat(id: string, title: string) {
    const c = chats.value.find((x) => x.id === id)
    if (!c) return
    const t = title.trim()
    if (t) {
      c.title = t.slice(0, 60)
      c.manualTitle = true
    } else {
      // 清空名称 → 恢复自动命名
      c.title = c.messages.length ? deriveTitle(asPlainText(c.messages.find((m) => m.role === 'user')?.content), {}) : ''
      c.manualTitle = false
    }
    scheduleChatSave()
  }

  // ===== 聊天记录持久化（网页登录用户整表上云；桌面版/未登录落 localStorage） =====
  const authStore = useAuthStore()
  let chatSaveTimer: number | null = null
  let chatSaving = false
  let restoreDone = false

  // 套用恢复的整表会话（仅当前无会话时生效，避免覆盖用户正在进行的对话）
  function applyRestored(r: ChatPayload) {
    if (chats.value.length > 0 || !Array.isArray(r.chats) || r.chats.length === 0) return
    chats.value = r.chats.map((c) => ({
      id: c.id, title: c.title || '',
      createdAt: c.createdAt || Date.now(), updatedAt: c.updatedAt || Date.now(),
      messages: c.messages as ChatMessage[], reasonings: (c.reasonings as string[]) || [],
    }))
    activeChatId.value = r.activeId && chats.value.some((c) => c.id === r.activeId)
      ? r.activeId
      : chats.value[chats.value.length - 1].id // 默认落在最近的会话
  }

  async function restoreChats() {
    if (restoreDone) return
    restoreDone = true
    try {
      applyRestored(await chatGet())
    } catch (e: any) {
      if (e?.status === 401) authStore.onUnauthorized()
      // 其他错误静默：恢复失败不影响使用
    }
  }

  // 桌面版/未登录：localStorage 恢复（重启后不丢会话）
  function restoreChatsLocal() {
    if (restoreDone) return
    restoreDone = true
    try {
      const raw = localStorage.getItem(CHAT_LOCAL_KEY)
      if (!raw) return
      applyRestored(JSON.parse(raw) as ChatPayload)
    } catch { /* 解析失败静默 */ }
  }

  // 存档上限的逐级降级（服务端 8MB；localStorage 共享 ~5MB 配额且需给文档留余量，取 2MB）：
  // 1) 多模态消息里的图片 data URL 换占位符（图已发给模型，存档不需要原图，单张可达 10MB）
  // 2) 仍超限则每个会话只保留最近 40 条
  // 3) 仍超限则从最旧开始丢弃整个会话（活动会话除外）
  // 4) 单会话仍超限则从最旧消息开始裁
  const CHAT_SAVE_LIMIT = 8 * 1024 * 1024 - 64 * 1024
  const CHAT_LOCAL_LIMIT = 2 * 1024 * 1024
  // 桌面版/未登录的会话存档键
  const CHAT_LOCAL_KEY = 'hypora_ai_chats'
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
  function makePayload(list: ChatSession[]): ChatPayload {
    return { activeId: activeChatId.value, chats: list as ChatPayload['chats'] }
  }
  function trimForSave(limitBytes: number = CHAT_SAVE_LIMIT): ChatPayload {
    let list = chats.value.slice()
    let payload = makePayload(list)
    if (payloadBytes(payload) <= limitBytes) return payload

    list = list.map((c) => ({ ...c, messages: stripImages(c.messages) }))
    payload = makePayload(list)
    if (payloadBytes(payload) <= limitBytes) return payload

    list = list.map((c) => ({
      ...c,
      messages: c.messages.slice(-40),
      reasonings: (c.reasonings || []).slice(-40),
    }))
    payload = makePayload(list)
    if (payloadBytes(payload) <= limitBytes) return payload

    // 从最旧开始丢整个会话，活动会话永远保留
    const sorted = [...list].sort((a, b) => a.updatedAt - b.updatedAt)
    const keepId = activeChatId.value
    while (sorted.length > 1 && payloadBytes(makePayload(sorted)) > limitBytes) {
      const victim = sorted.findIndex((c) => c.id !== keepId)
      if (victim === -1) break
      sorted.splice(victim, 1)
    }
    // 最后兜底：单会话内从最旧消息开始裁（至少保留 1 条）
    let tail = sorted
    while (tail.length && payloadBytes(makePayload(tail)) > limitBytes && tail[0].messages.length > 1) {
      tail = tail.map((c, i) => i === 0
        ? { ...c, messages: c.messages.slice(1), reasonings: (c.reasonings || []).slice(1) }
        : c)
    }
    return makePayload(tail)
  }

  function scheduleChatSave() {
    // 登录网页版：防抖后整表上云；桌面版/未登录：落 localStorage（重启不丢会话）
    if (chatSaveTimer) clearTimeout(chatSaveTimer)
    chatSaveTimer = window.setTimeout(
      authNeeded() && authStore.me ? () => { void saveChatsNow() } : saveChatsLocal,
      800
    )
  }

  // 桌面版/未登录：整表落到 localStorage（配额溢出静默，不影响使用）
  function saveChatsLocal() {
    try {
      localStorage.setItem(CHAT_LOCAL_KEY, JSON.stringify(trimForSave(CHAT_LOCAL_LIMIT)))
    } catch { /* 配额溢出：静默 */ }
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
    // 内置助手模式：默认 managed（有引擎时）；旧数据若改过 local baseUrl → 视为外部 llama-server 用户
    const lmode = localStorage.getItem('hypora_ai_local_mode') as 'managed' | 'external' | null
    localMode.value = lmode || (hasAiEngine() ? 'managed' : 'external')
    if (provider.value === 'local' && b && b !== DEFAULT_BASE_LOCAL) localMode.value = 'external'
    // GLM key/model 独立持久化（与 DeepSeek key 分开），重启后恢复用户配置
    const gk = localStorage.getItem('hypora_ai_glmkey')
    if (gk) glmKey.value = gk
    const gm = localStorage.getItem('hypora_ai_glmmodel')
    if (gm) glmModel.value = gm
    const pv = localStorage.getItem('hypora_ai_panel')
    panelVisible.value = pv === 'true'
    bindEngine()
    // 登录用户从服务器恢复多会话记录（App 侧保证 init 在会话确认后才调用）；
    // 桌面版/未登录从 localStorage 恢复（重启不丢会话），无存档时先备好一个空会话
    if (authNeeded() && authStore.me) void restoreChats()
    else {
      restoreChatsLocal()
      ensureActiveChat()
    }
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
    localStorage.setItem('hypora_ai_local_mode', localMode.value)
  }

  // 切换引擎并重置 baseUrl 默认值
  function setProvider(p: AIProvider) {
    provider.value = p
    baseUrl.value = p === 'local' ? DEFAULT_BASE_LOCAL : p === 'glm' ? DEFAULT_BASE_GLM : DEFAULT_BASE_DEEPSEEK
    saveToLocal()
  }

  // ===== 内置助手引擎控制 =====
  function applyEngineStatus(s: EngineStatus | null) {
    if (!s) return
    enginePhase.value = s.phase
    engineBackend.value = s.backend
    enginePort.value = s.port
    engineError.value = s.error
  }

  async function refreshEngineStatus() {
    applyEngineStatus(await engineApi.status())
  }

  async function refreshEngineConfig() {
    engineModel.value = await engineApi.config()
  }

  // 绑定主进程状态/下载推送并首次对账（Ctrl+R 重载渲染层后由 init 重新绑定）
  function bindEngine() {
    if (!hasAiEngine()) return
    engineApi.onStatus(applyEngineStatus)
    engineApi.onDownload((d) => {
      engineDownload.value = d
      // 下载结束（无论成败）刷新模型存在性：模型卡「已下载/未下载」即时翻转
      if (d.phase === 'done' || d.phase === 'error') void refreshEngineConfig()
    })
    void refreshEngineStatus()
    void refreshEngineConfig()
  }

  // 按需拉起引擎：幂等，等待进入 running（Vulkan→CPU 回落最长约 150s，超时判失败）
  async function startEngine(): Promise<boolean> {
    if (!hasAiEngine()) return false
    if (enginePhase.value === 'running') return true
    engineApi.start().catch(() => {}) // MODEL_MISSING / 启动失败经状态推送反映
    const deadline = Date.now() + 150_000
    while (Date.now() < deadline) {
      if (enginePhase.value === 'running') return true
      if (enginePhase.value === 'failed') return false
      await new Promise((r) => setTimeout(r, 250))
    }
    return false
  }

  async function stopEngine() {
    await engineApi.stop()
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
    // 托管模式：端点健康已由状态点表达；未运行时给明确提示而非盲目探测
    if (isLocal && hasAiEngine() && localMode.value === 'managed') {
      if (!engineRunning.value) return { ok: false, error: '内置助手未运行（点击「启动」或发送消息自动拉起）' }
      return await testConn(engineBaseUrl.value, undefined)
    }
    return await testConn(baseUrl.value, isLocal ? undefined : apiKey.value)
  }

  function togglePanel() {
    panelVisible.value = !panelVisible.value
    saveToLocal()
  }

  // 清空当前对话 = 删除当前会话，落到新会话（多会话语义；历史会话在列表里各自删除）
  function clearMessages() {
    if (loading.value) return
    clearImages()
    deleteChat(activeChatId.value)
  }

  function stop() {
    controller?.abort()
    controller = null
    loading.value = false
  }

  /**
   * 发送一条消息（写入当前会话）。
   * @param prompt 用户输入或预设 prompt
   * @param ctx.selection 当前编辑器选中文本（选区操作时传入）
   * @param ctx.doc 当前整篇文档（”带入当前文档”时传入）
   */
  async function send(prompt: string, ctx: { selection?: string; doc?: string } = {}) {
    if (loading.value) return
    const chat = ensureActiveChat()
    // 流式期间捕获会话引用：用户中途切走，增量仍写回原会话
    const isLocal = provider.value === 'local'
    const isGlm = provider.value === 'glm'
    const hasImages = pendingImages.value.length > 0

    // 托管模式判定：内置助手接管 local 提供方（external 或无引擎走旧外部路径）
    const useManaged = isLocal && hasAiEngine() && localMode.value === 'managed'
    if (useManaged && engineModel.value && !engineModel.value.modelExists) {
      chat.messages.push({ role: 'assistant', content: '⚠️ 内置助手还没有模型文件，请在本面板「内置模型」卡片点击下载（默认 Q4_K_M 约 1.5 GB，或选 Q8_0 约 2.5 GB，下载完成后自动就绪）。' })
      chat.reasonings.push('')
      return
    }

    if (isGlm) {
      if (!glmKey.value.trim()) {
        chat.messages.push({ role: 'assistant', content: '⚠️ 请先在配置区填写 GLM API Key。' })
        chat.reasonings.push('')
        return
      }
    } else if (!isLocal && !apiKey.value.trim()) {
      chat.messages.push({ role: 'assistant', content: '⚠️ 请先在配置区填写 API Key。' })
      chat.reasonings.push('')
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

    chat.messages.push({ role: 'user', content: userContent })
    chat.reasonings.push('')
    chat.messages.push({ role: 'assistant', content: '' })
    chat.reasonings.push('')
    const aiIdx = chat.messages.length - 1

    // 自动命名：未手动命名过时按选中文本/输入首行取标题
    if (!chat.title && !chat.manualTitle) {
      const t = deriveTitle(prompt, ctx)
      if (t) chat.title = t
    }

    // 托管模式：先落占位再按需拉起引擎——面板显示「AI 正在思考…」的同时模型在后台加载
    if (useManaged && !engineRunning.value) {
      const ok = await startEngine()
      if (!ok) {
        chat.messages[aiIdx].content = `⚠️ 内置助手启动失败${engineError.value ? `：${engineError.value}` : ''}。可在面板「高级」区改用外部 llama-server。`
        chat.reasonings[aiIdx] = ''
        scheduleChatSave()
        return
      }
    }

    loading.value = true
    controller = new AbortController()
    try {
      // 历史含本次 user，不含末尾空 assistant 占位
      const sysContent = isGlm
        ? '你是 Hypora 内置的 AI 助手，具备图像理解能力。用户上传图片时，请详细提取并描述图片内容（包括文字、表格、图表、图形、场景、人物等所有可见信息），输出结构化 Markdown。'
        : '你是 Hypora 内置的 AI 写作助手。用户在 Markdown 编辑器中写作，你的回复使用 Markdown 格式，简洁实用。'
      const history: ChatMessage[] = [
        { role: 'system', content: sysContent },
        ...chat.messages.slice(0, aiIdx)
      ]
      await streamChat({
        // 托管模式用引擎协商出的实际端口；model 传 undefined → llama-server 使用 GGUF 内置模板
        baseUrl: useManaged ? engineBaseUrl.value : baseUrl.value,
        apiKey: isLocal ? undefined : (isGlm ? glmKey.value : apiKey.value),
        model: useManaged ? undefined : (isLocal ? (localModel.value.trim() || undefined) : (isGlm ? glmModel.value : model.value)),
        messages: history,
        path: isGlm ? '/chat/completions' : undefined,
        thinking: !isLocal && !isGlm && thinking.value,
        onChunk: (delta) => { chat.messages[aiIdx].content += delta },
        // 思考链单独收集，不混入正文（避免嵌入编辑器时带一堆冗余思考）
        onReasoning: (delta) => { chat.reasonings[aiIdx] += delta },
        signal: controller.signal
      })
      if (!chat.messages[aiIdx].content) {
        chat.messages[aiIdx].content = '（空回复）'
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        // 用户主动停止，保留已生成内容
      } else {
        // 子进程意外退出 → 立即刷新状态，状态点转红；提示文案区分托管/外部
        if (useManaged) void refreshEngineStatus()
        const hint = useManaged ? '\n\n（内置助手可能已停止，请在面板中点击「启动」重新拉起）'
          : isLocal ? '\n\n（请确认外部 llama-server 正在运行于配置的地址）'
          : isGlm ? '\n\n（请确认 GLM API Key 有效，且网络可访问 open.bigmodel.cn）' : ''
        chat.messages[aiIdx].content += `\n\n⚠️ ${e?.message || e}${hint}`
      }
    } finally {
      loading.value = false
      controller = null
      if (hasImages) clearImages()
      chat.updatedAt = Date.now()
      // 本轮对话已定格（含空回复/中止/出错分支），防抖保存到服务器
      scheduleChatSave()
    }
  }

  return {
    apiKey, model, thinking, provider, baseUrl, localModel, glmKey, glmModel, panelVisible, messages, reasonings, loading, pendingImages,
    chats, activeChatId, activeChat,
    init, saveToLocal, setProvider, testConnection, togglePanel, clearMessages, stop, send, addImage, removeImage, clearImages,
    // 内置助手：引擎状态与控制
    enginePhase, engineBackend, enginePort, engineError, engineModel, engineDownload, localMode,
    engineRunning, engineStarting, engineBaseUrl, engineDot, engineStatusText,
    bindEngine, startEngine, stopEngine, refreshEngineStatus, refreshEngineConfig,
    newChat, switchChat, deleteChat, renameChat
  }
})
