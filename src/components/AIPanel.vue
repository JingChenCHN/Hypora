<template>
  <aside class="ai-panel" :class="{ hidden: !visible }">
    <div class="ai-head">
      <span class="ai-title">✦ AI 写作助手</span>
      <button class="ai-head-btn" title="折叠面板" @click="visible = false">»</button>
    </div>

    <!-- 提供商配置 -->
    <div class="ai-section config">
      <button class="config-toggle" @click="showConfig = !showConfig">
        {{ showConfig ? '▾' : '▸' }} 引擎配置
        <span class="config-badge" :class="{ ok: ai.configured, bad: !ai.configured }">
          {{ ai.configured ? '就绪' : '未配置' }}
        </span>
      </button>
      <div v-if="showConfig" class="config-body">
        <label class="cfg-label">提供商</label>
        <select v-model="providerId" class="cfg-select" @change="onProviderChange">
          <option v-for="p in PRESETS" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>

        <template v-if="currentPreset?.needsKey">
          <label class="cfg-label">API Key</label>
          <input v-model="apiKeyInput" type="password" class="cfg-input" placeholder="sk-…" @change="onKeyChange" />
        </template>

        <label class="cfg-label">模型</label>
        <select v-if="currentPreset?.models.length" v-model="cloudModel" class="cfg-select" @change="saveCloudModel">
          <option v-for="m in currentPreset.models" :key="m" :value="m">{{ m }}</option>
        </select>
        <input v-else v-model="cloudModel" class="cfg-input" placeholder="模型名，如 gpt-4o-mini" @change="saveCloudModel" />

        <template v-if="currentPreset?.kind === 'cloud'">
          <label class="cfg-check">
            <input v-model="ai.reasoningEnabled" type="checkbox" @change="saveReasoning" />
            启用思考链（reasoning_content）
          </label>
        </template>

        <template v-if="currentPreset?.kind === 'local'">
          <label class="cfg-label">本地模型</label>
          <input v-model="localModelInput" class="cfg-input" placeholder="如 llama-3.2-1b-instruct" @change="saveLocalModel" />
          <div class="local-actions">
            <button class="mini-btn" :disabled="ai.sidecar.running" @click="startLocal">启动引擎</button>
            <button class="mini-btn" :disabled="!ai.sidecar.running" @click="stopLocal">停止</button>
          </div>
          <div class="local-status" :class="{ on: ai.sidecar.running }">
            {{ ai.sidecar.running ? `运行中 · ${ai.sidecar.port ?? ''}` : '未运行' }}
          </div>
        </template>
      </div>
    </div>

    <!-- 快捷指令 -->
    <div class="ai-section">
      <div class="quick-grid">
        <button v-for="q in QUICK_PROMPTS" :key="q.id" class="quick-btn" :disabled="ai.streaming" @click="quickRun(q)">
          {{ q.label }}
        </button>
      </div>
    </div>

    <!-- 上下文 -->
    <div class="ai-section ctx">
      <div class="ctx-row">
        <span class="ctx-label">上下文</span>
        <div class="ctx-seg">
          <button :class="{ on: contextMode === 'selection' }" @click="contextMode = 'selection'">选中</button>
          <button :class="{ on: contextMode === 'document' }" @click="contextMode = 'document'">全文</button>
          <button :class="{ on: contextMode === 'custom' }" @click="contextMode = 'custom'">自定义</button>
        </div>
      </div>
      <textarea v-if="contextMode === 'custom'" v-model="customContext" class="ctx-text" rows="2" placeholder="输入上下文内容…"></textarea>
      <div v-else class="ctx-hint">
        {{ contextMode === 'selection' ? (selectionText ? `已选中 ${selectionText.length} 字` : '未选中文本，将取文档开头') : `使用全文（${doc.markdown.length} 字）` }}
      </div>
    </div>

    <!-- 对话 -->
    <div ref="scrollEl" class="chat-scroll">
      <div v-if="ai.messages.length === 0 && !ai.streaming" class="chat-empty">
        选择上方快捷指令，或输入问题开始对话。<br />
        <span class="hint">回答会以 Markdown 呈现，确认后可一键插入文档。</span>
      </div>
      <div v-for="(m, i) in ai.messages" :key="i" class="msg" :class="m.role">
        <div class="msg-role">{{ m.role === 'user' ? '你' : 'AI' }}</div>
        <div class="msg-bubble">
          <template v-if="m.role === 'assistant'">
            <details v-if="m.reasoning" class="reasoning">
              <summary>思考过程</summary>
              <div class="reasoning-body">{{ m.reasoning }}</div>
            </details>
            <div class="md" v-html="renderMd(m.content)"></div>
          </template>
          <template v-else>{{ m.content }}</template>
          <div v-if="m.role === 'assistant'" class="msg-actions">
            <button class="mini-btn" @click="insert(m.content)">插入文档</button>
            <button v-if="selectionText" class="mini-btn" @click="replaceSel(m.content)">替换选中</button>
            <button class="mini-btn" @click="copy(m.content)">复制</button>
          </div>
        </div>
      </div>

      <!-- 流式气泡 -->
      <div v-if="ai.streaming" class="msg assistant streaming">
        <div class="msg-role">AI</div>
        <div class="msg-bubble">
          <details v-if="ai.currentReasoning" class="reasoning" open>
            <summary>思考过程…</summary>
            <div class="reasoning-body">{{ ai.currentReasoning }}</div>
          </details>
          <div class="stream-markdown" v-html="renderMd(ai.currentText || '…')"></div>
          <div class="stream-indicator">
            <LottieLoading :size="16" />
            <span>{{ thinkingText }}</span>
            <button class="mini-btn stop" @click="ai.cancel()">停止</button>
          </div>
        </div>
      </div>

      <div v-if="ai.error" class="ai-error">⚠ {{ ai.error }}</div>
    </div>

    <!-- 输入 -->
    <div class="ai-input-bar">
      <textarea
        v-model="input"
        class="ai-input"
        rows="2"
        :placeholder="placeholderText"
        @keydown.enter.exact.prevent="send"
        @keydown.enter.shift.exact="() => {}"
      ></textarea>
      <div class="input-row">
        <button class="send-btn" :disabled="ai.streaming || !canSend" @click="send">发送 ⏎</button>
        <button class="mini-btn" title="清空对话" @click="ai.resetConversation()">清空</button>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from 'vue'
import { useAIStore } from '@/stores/ai'
import { useDocumentStore } from '@/stores/document'
import { PROVIDER_PRESETS, AI_ASSISTANT_SYSTEM } from '@/utils/deepseek'
import { editorState, onEditorCommand } from '@/utils/editorBus'
import { markdownToHtml } from '@/utils/markdown'
import { tauriAPI } from '@/utils/tauriAPI'
import LottieLoading from '@/components/LottieLoading.vue'
import { toast } from '@/components/toasts'
import { THINKING_FRAMES } from '@/assets/aiLoading'

const ai = useAIStore()
const doc = useDocumentStore()
const editorApi = inject<{ value: any }>('editorApi', ref(null))

const PRESETS = PROVIDER_PRESETS
const QUICK_PROMPTS = [
  { id: 'continue', label: '续写', tpl: '请接着当前文档的上下文续写，保持风格一致。\n\n{{context}}' },
  { id: 'polish', label: '润色', tpl: '请润色以下文本，使其更流畅、更专业，保持原意。\n\n{{selection}}' },
  { id: 'summary', label: '总结', tpl: '请用要点形式总结以下内容。\n\n{{selection}}' },
  { id: 'translate', label: '翻译', tpl: '请将以下内容翻译为中文（原文为中文则翻译为英文）。\n\n{{selection}}' },
  { id: 'outline', label: '大纲', tpl: '请基于当前文档生成结构清晰的大纲。\n\n{{context}}' },
  { id: 'code', label: '代码', tpl: '请根据需求生成可运行代码并说明用法。\n\n{{selection}}' },
]

const visible = ref(true)
const showConfig = ref(false)
const input = ref('')
const customContext = ref('')
const contextMode = ref<'selection' | 'document' | 'custom'>('selection')
const scrollEl = ref<HTMLElement | null>(null)
const thinkingIdx = ref(0)
let thinkingTimer = 0 as ReturnType<typeof setTimeout>

const providerId = computed({
  get: () => ai.providerId,
  set: (v: string) => ai.setProvider(v),
})
const apiKeyInput = ref(ai.apiKey)
const cloudModel = ref(ai.cloudModel)
const localModelInput = ref(ai.localModel)
const currentPreset = computed(() => ai.preset)

const selectionText = computed(() => editorState.selectionText)
const placeholderText = computed(() => (ai.streaming ? '正在生成…' : '输入问题，或 Ctrl+Enter 换行'))
const canSend = computed(() => input.value.trim().length > 0 || contextMode.value === 'document')

let thinkingText = ref('正在思考…')
function cycleThinking() {
  thinkingIdx.value = (thinkingIdx.value + 1) % THINKING_FRAMES.length
  thinkingText.value = THINKING_FRAMES[thinkingIdx.value].text
}

watch(
  () => ai.streaming,
  (v) => {
    if (v) {
      thinkingTimer = setInterval(cycleThinking, THINKING_FRAMES[thinkingIdx.value].delay)
      void scrollToBottom()
    } else {
      clearInterval(thinkingTimer)
      thinkingText.value = '正在思考…'
    }
  },
)

watch(
  () => [ai.currentText, ai.currentReasoning, ai.messages.length] as const,
  () => void scrollToBottom(),
)

async function scrollToBottom() {
  await nextTick()
  scrollEl.value?.scrollTo({ top: scrollEl.value.scrollHeight, behavior: 'smooth' })
}

function renderMd(md: string) {
  return markdownToHtml(md)
}

function buildContext(): string {
  const sel = editorApi.value?.getSelectionText?.() ?? ''
  switch (contextMode.value) {
    case 'selection':
      return sel || doc.markdown.slice(0, 2000)
    case 'document':
      return doc.markdown.slice(0, 8000)
    case 'custom':
      return customContext.value
  }
}

async function send() {
  const user = input.value.trim()
  if (!user && contextMode.value === 'document') {
    toast('请先输入指令', 'error')
    return
  }
  if (!user) {
    toast('请先输入指令', 'error')
    return
  }
  if (!ai.configured) {
    toast('请先在“引擎配置”中填写 API Key', 'error')
    return
  }
  const context = buildContext()
  const fullPrompt = user + (context ? `\n\n——\n上下文：\n${context}` : '')
  ai.messages.push({ role: 'user', content: user })
  input.value = ''
  try {
    const res = await ai.streamPrompt(AI_ASSISTANT_SYSTEM, fullPrompt)
    ai.messages.push({ role: 'assistant', content: res.full, reasoning: res.reasoning || undefined })
    // 保留最后两条在 ai.messages 以便上下文延续
  } catch (err) {
    toast(`AI 请求失败：${String(err)}`, 'error')
  }
}

async function quickRun(q: { label: string; tpl: string }) {
  const ctx = buildContext()
  const selection = editorApi.value?.getSelectionText?.() ?? ''
  const prompt = q.tpl
    .replaceAll('{{context}}', ctx)
    .replaceAll('{{selection}}', selection || ctx.slice(0, 2000))
  ai.messages.push({ role: 'user', content: `【${q.label}】${prompt.slice(0, 200)}` })
  try {
    const res = await ai.streamPrompt(AI_ASSISTANT_SYSTEM, prompt)
    ai.messages.push({ role: 'assistant', content: res.full, reasoning: res.reasoning || undefined })
  } catch (err) {
    toast(`AI 请求失败：${String(err)}`, 'error')
  }
}

async function insert(md: string) {
  await editorApi.value?.insertAIText?.(md)
  toast('已插入到文档光标处', 'success')
}

async function replaceSel(md: string) {
  const api = editorApi.value
  const range = api?.getCaretRange?.()
  if (range) {
    await api.replaceSelectionText(range.start, range.end, md)
    toast('已替换选中内容', 'success')
  } else {
    await insert(md)
  }
}

async function copy(text: string) {
  await navigator.clipboard.writeText(text)
  toast('已复制', 'success')
}

async function startLocal() {
  try {
    await ai.startLocal()
    toast('本地引擎已启动', 'success')
  } catch (err) {
    toast(`启动失败：${String(err)}`, 'error')
  }
}
async function stopLocal() {
  await ai.stopLocal()
  toast('本地引擎已停止')
}

function onProviderChange() {
  const p = currentPreset.value
  if (p?.id === 'custom') cloudModel.value = ai.customModel
}
function onKeyChange() {
  ai.saveKey(apiKeyInput.value)
  toast('API Key 已保存')
}
function saveCloudModel() {
  ai.cloudModel = cloudModel.value
  tauriAPI.devLog('debug', 'saved cloud model', cloudModel.value).catch(() => {})
}
function saveLocalModel() {
  ai.localModel = localModelInput.value
}
function saveReasoning() {
  // 已直接绑定 ai.reasoningEnabled，仅持久化
}

// 面板开合
onEditorCommand('toggle-ai', (v: unknown) => (visible.value = Boolean(v ?? !visible.value)))
</script>

<style scoped lang="scss">
.ai-panel {
  width: 320px;
  min-width: 280px;
  display: flex;
  flex-direction: column;
  background: var(--hypora-bg-elevated);
  border-left: 1px solid var(--hypora-border);
  transition: width var(--hypora-transition);

  &.hidden {
    width: 0;
    min-width: 0;
    border-left: none;
    overflow: hidden;
  }
}

.ai-head {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--hypora-border);
  flex-shrink: 0;

  .ai-title {
    flex: 1;
    font-size: 13px;
    font-weight: 600;
  }
}
.ai-head-btn {
  width: 26px;
  height: 26px;
  border-radius: var(--hypora-radius-sm);
  color: var(--hypora-fg-muted);
  cursor: pointer;
  &:hover {
    background: var(--hypora-bg-hover);
  }
}

.ai-section {
  padding: 8px 12px;
  border-bottom: 1px solid var(--hypora-border);
  flex-shrink: 0;
}

.config-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--hypora-fg);
  cursor: pointer;
  text-align: left;
}
.config-badge {
  margin-left: auto;
  font-size: 11px;
  padding: 1px 8px;
  border-radius: var(--hypora-radius-full);
  &.ok {
    background: var(--hypora-success);
    color: #fff;
  }
  &.bad {
    background: var(--hypora-warning);
    color: #fff;
  }
}

.config-body {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cfg-label {
  font-size: 11px;
  color: var(--hypora-fg-subtle);
}
.cfg-select,
.cfg-input {
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--hypora-border);
  border-radius: var(--hypora-radius-sm);
  font-size: 12px;
  background: var(--hypora-bg);
  color: var(--hypora-fg);
}
.cfg-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--hypora-fg-muted);
  cursor: pointer;
}
.local-actions {
  display: flex;
  gap: 6px;
}
.local-status {
  font-size: 11px;
  color: var(--hypora-fg-subtle);
  &.on {
    color: var(--hypora-success);
  }
}

.quick-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
}
.quick-btn {
  padding: 5px 4px;
  border-radius: var(--hypora-radius-sm);
  border: 1px solid var(--hypora-border);
  font-size: 11.5px;
  color: var(--hypora-fg);
  cursor: pointer;
  transition: all var(--hypora-transition-fast);
  &:hover:not(:disabled) {
    border-color: var(--hypora-accent);
    color: var(--hypora-accent);
    background: var(--hypora-accent-soft);
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.ctx-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ctx-label {
  font-size: 11px;
  color: var(--hypora-fg-subtle);
}
.ctx-seg {
  display: flex;
  border: 1px solid var(--hypora-border);
  border-radius: var(--hypora-radius-sm);
  overflow: hidden;

  button {
    padding: 3px 8px;
    font-size: 11.5px;
    color: var(--hypora-fg-muted);
    cursor: pointer;
    &.on {
      background: var(--hypora-accent-soft);
      color: var(--hypora-accent);
    }
  }
}
.ctx-text {
  width: 100%;
  margin-top: 6px;
  padding: 6px 8px;
  border: 1px solid var(--hypora-border);
  border-radius: var(--hypora-radius-sm);
  font-size: 12px;
  resize: none;
  background: var(--hypora-bg);
  color: var(--hypora-fg);
}
.ctx-hint {
  margin-top: 6px;
  font-size: 11px;
  color: var(--hypora-fg-subtle);
}

.chat-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  @include subtle-scrollbar;
}

.chat-empty {
  text-align: center;
  color: var(--hypora-fg-subtle);
  font-size: 12px;
  padding: 30px 8px;
  line-height: 2;
  .hint {
    font-size: 11px;
  }
}

.msg {
  display: flex;
  flex-direction: column;
  gap: 4px;
  &.user {
    align-items: flex-end;
  }
  &.assistant {
    align-items: flex-start;
  }
}
.msg-role {
  font-size: 10.5px;
  color: var(--hypora-fg-subtle);
  padding: 0 4px;
}
.msg-bubble {
  max-width: 100%;
  padding: 8px 12px;
  border-radius: var(--hypora-radius);
  font-size: 12.5px;
  line-height: 1.7;
  word-break: break-word;
  white-space: pre-wrap;

  .msg.user & {
    background: var(--hypora-accent);
    color: var(--hypora-accent-contrast);
    border-bottom-right-radius: 2px;
  }
  .msg.assistant & {
    background: var(--hypora-ai-bubble);
    border: 1px solid var(--hypora-border);
    border-bottom-left-radius: 2px;
    width: 100%;
  }
}

.reasoning {
  margin-bottom: 6px;
  summary {
    font-size: 11px;
    color: var(--hypora-fg-subtle);
    cursor: pointer;
  }
  .reasoning-body {
    margin-top: 4px;
    padding: 6px 8px;
    background: var(--hypora-bg-inset);
    border-radius: var(--hypora-radius-sm);
    font-size: 11.5px;
    color: var(--hypora-fg-muted);
    max-height: 140px;
    overflow-y: auto;
    @include subtle-scrollbar;
  }
}

.md {
  :deep(p) {
    margin: 0 0 6px;
  }
  :deep(pre) {
    background: var(--hypora-bg-inset);
    border-radius: var(--hypora-radius-sm);
    padding: 8px;
    overflow-x: auto;
    font-size: 11.5px;
    font-family: var(--hypora-font-mono);
    @include subtle-scrollbar;
  }
  :deep(code) {
    font-family: var(--hypora-font-mono);
    font-size: 0.92em;
  }
  :deep(ul),
  :deep(ol) {
    padding-left: 16px;
  }
}

.msg-actions {
  display: flex;
  gap: 4px;
  margin-top: 6px;
}
.mini-btn {
  padding: 2px 8px;
  border: 1px solid var(--hypora-border);
  border-radius: var(--hypora-radius-sm);
  font-size: 11px;
  color: var(--hypora-fg-muted);
  cursor: pointer;
  &:hover {
    background: var(--hypora-bg-hover);
    color: var(--hypora-fg);
  }
  &.stop:hover {
    color: var(--hypora-danger);
  }
}

.stream-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--hypora-fg-subtle);
}

.ai-error {
  padding: 8px 12px;
  background: var(--hypora-danger);
  color: #fff;
  border-radius: var(--hypora-radius-sm);
  font-size: 12px;
}

.ai-input-bar {
  border-top: 1px solid var(--hypora-border);
  padding: 10px 12px;
  flex-shrink: 0;
}
.ai-input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--hypora-border);
  border-radius: var(--hypora-radius-sm);
  font-size: 12.5px;
  resize: none;
  background: var(--hypora-bg);
  color: var(--hypora-fg);
  line-height: 1.6;
  &:focus {
    border-color: var(--hypora-focus-ring);
  }
}
.input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.send-btn {
  flex: 1;
  @include accent-button;
  justify-content: center;
}
</style>
