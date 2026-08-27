<template>
  <div class="ai-panel" :class="{ 'is-collapsed': !visible }">
    <div class="ai-panel-inner">
      <!-- 顶部 -->
      <div class="ai-header">
        <span class="ai-title">AI 助手</span>
        <div class="ai-header-actions">
          <el-tooltip content="配置" placement="bottom">
            <el-button text class="header-btn" :class="{ active: configVisible }" @click="configVisible = !configVisible">
              <el-icon><Setting /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip content="清空对话" placement="bottom">
            <el-button text class="header-btn" :disabled="aiStore.loading" @click="aiStore.clearMessages()">
              <el-icon><Delete /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip content="收起" placement="bottom">
            <el-button text class="header-btn" @click="aiStore.togglePanel()">
              <el-icon><Close /></el-icon>
            </el-button>
          </el-tooltip>
        </div>
      </div>

      <!-- 配置区 -->
      <div v-show="configVisible" class="ai-config">
        <!-- 引擎切换 -->
        <div class="config-row">
          <label>引擎</label>
          <div class="provider-switch">
            <button class="prov-btn" :class="{ active: aiStore.provider === 'deepseek' }" @click="aiStore.setProvider('deepseek')">DeepSeek</button>
            <button class="prov-btn" :class="{ active: aiStore.provider === 'glm' }" @click="aiStore.setProvider('glm')">GLM 识图</button>
            <button class="prov-btn" :class="{ active: aiStore.provider === 'local' }" @click="aiStore.setProvider('local')">本地 LLM</button>
          </div>
        </div>

        <template v-if="aiStore.provider === 'deepseek'">
          <div class="config-row">
            <label>API Key</label>
            <el-input v-model="aiStore.apiKey" type="password" show-password size="small" placeholder="sk-..." @change="aiStore.saveToLocal()" />
          </div>
          <div class="config-row">
            <label>模型</label>
            <el-select v-model="aiStore.model" size="small" filterable allow-create @change="aiStore.saveToLocal()" style="flex:1">
              <el-option label="deepseek-v4-flash (非思考)" value="deepseek-v4-flash" />
              <el-option label="deepseek-v4-pro" value="deepseek-v4-pro" />
              <el-option label="deepseek-chat (将弃用)" value="deepseek-chat" />
              <el-option label="deepseek-reasoner (将弃用)" value="deepseek-reasoner" />
            </el-select>
          </div>
          <div class="config-row">
            <label>思考模式</label>
            <el-switch v-model="aiStore.thinking" size="small" @change="aiStore.saveToLocal()" />
            <span class="config-hint">开启后回复含推理过程</span>
          </div>
        </template>

        <template v-else-if="aiStore.provider === 'glm'">
          <div class="config-row">
            <label>API Key</label>
            <el-input v-model="aiStore.glmKey" type="password" show-password size="small" placeholder="填入你的智谱 API Key（sk-…）" @change="aiStore.saveToLocal()" />
          </div>
          <div class="config-row">
            <label>模型</label>
            <el-select v-model="aiStore.glmModel" size="small" filterable allow-create @change="aiStore.saveToLocal()" style="flex:1">
              <el-option label="glm-4-flash (免费文本)" value="glm-4-flash" />
              <el-option label="glm-4v-flash (免费识图)" value="glm-4v-flash" />
              <el-option label="glm-4v (更强识图)" value="glm-4v" />
            </el-select>
          </div>
          <div class="config-row">
            <label>连接</label>
            <el-button size="small" class="test-btn" @click="testGlm">测试</el-button>
            <span class="conn-status" :class="{ ok: glmConnOk }">{{ glmConnStatus }}</span>
          </div>
          <p class="config-hint-row">GLM 识图模式：在下方输入区点击「图片」按钮上传图片（最多 5 张）后发送，AI 将详细提取图片内容。文本对话选 glm-4-flash。在本页填写你的智谱 API Key，Key 仅存于本地浏览器，经同源代理转发、不落服务器。</p>
        </template>

        <template v-else>
          <div class="config-row">
            <label>地址</label>
            <el-input v-model="aiStore.baseUrl" size="small" placeholder="http://127.0.0.1:8899" @change="aiStore.saveToLocal()" />
          </div>
          <div class="config-row">
            <label>模型</label>
            <el-input v-model="aiStore.localModel" size="small" placeholder="留空用已加载模型" @change="aiStore.saveToLocal()" style="flex:1" />
          </div>
          <div class="config-row">
            <label>连接</label>
            <el-button size="small" class="test-btn" @click="testLocal">测试</el-button>
            <span class="conn-status" :class="{ ok: connOk }">{{ connStatus }}</span>
          </div>
          <p class="config-hint-row">需先启动 local-ai-engine（双击 启动.bat），使 llama-server 运行于该地址。MiniCPM5 会先输出思考链再回答。</p>
        </template>
      </div>

      <!-- 消息列表 -->
      <div class="ai-messages" ref="messagesRef">
        <!-- 空状态：lottie 常驻展示 -->
        <div v-if="aiStore.messages.length === 0" class="ai-empty">
          <LottieLoading :animation="assistantAnim" size="large" class="empty-anim" />
          <p class="ai-empty-main">选中编辑器文字，让 AI 帮你<br />改写 · 解释 · 翻译 · 扩写 · 总结</p>
          <p class="ai-empty-sub">或在下方直接提问 · GLM 识图模式可上传图片</p>
        </div>

        <div v-for="(msg, i) in aiStore.messages" :key="i" class="ai-msg" :class="msg.role">
          <div class="msg-bubble">
            <div v-if="msg.role === 'user'" class="msg-text user-text">
              <template v-if="Array.isArray(msg.content)">
                <template v-for="(part, pi) in msg.content" :key="pi">
                  <img v-if="part.type === 'image_url'" :src="part.image_url.url" class="user-img" />
                  <span v-else-if="part.type === 'text'">{{ part.text }}</span>
                </template>
              </template>
              <template v-else>{{ msg.content }}</template>
            </div>
            <div v-else class="msg-text markdown-body">
              <!-- 思考链：与正文分离，折叠展示（不随「插入/复制」进编辑器） -->
              <div v-if="aiStore.reasonings[i]" class="reasoning-block">
                <button class="reasoning-toggle" @click.stop="toggleReasoning(i)">
                  <span class="reasoning-arrow" :class="{ open: reasoningOpen[i] }">▸</span>
                  {{ reasoningOpen[i] ? '收起思考过程' : '思考过程' }}
                </button>
                <div v-if="reasoningOpen[i]" class="reasoning-body" v-html="renderMd(aiStore.reasonings[i], i)"></div>
              </div>
              <div v-if="msg.content" class="ai-md-content" v-html="renderMd(msg.content, i)"></div>
              <!-- 思考中：三点 lottie -->
              <LottieLoading v-else-if="i === lastIdx && aiStore.loading" :animation="aiLoadingAnimation" size="small" label="AI 正在思考…" />
            </div>
            <div v-if="msg.role === 'assistant' && msg.content && !(aiStore.loading && i === lastIdx)" class="msg-actions">
              <button class="action-btn" @click="insertToCursor(asText(msg.content))">插入</button>
              <button class="action-btn" @click="replaceSel(asText(msg.content))">替换选区</button>
              <button class="action-btn" @click="copyText(asText(msg.content))">复制</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 当前引用选中文字（跟随编辑区选区实时更新；鼠标点进来也不丢） -->
      <div v-if="referencedText" class="ai-refbar">
        <span class="ref-dot"></span>
        <span class="ref-label">将引用选中文字</span>
        <span class="ref-body">{{ referencedText }}</span>
        <span class="ref-count">{{ referencedLen }} 字</span>
      </div>

      <!-- 选区/文档快捷操作 -->
      <!-- @mousedown.prevent：点击预设按钮不夺走编辑区焦点，避免浏览器清空选区、高亮丢失 -->
      <div class="ai-presets" @mousedown.prevent>
        <button class="preset-btn" :disabled="aiStore.loading" @click="preset('rewrite')">改写</button>
        <button class="preset-btn" :disabled="aiStore.loading" @click="preset('explain')">解释</button>
        <button class="preset-btn" :disabled="aiStore.loading" @click="preset('translate')">翻译</button>
        <button class="preset-btn" :disabled="aiStore.loading" @click="preset('expand')">扩写</button>
        <button class="preset-btn" :disabled="aiStore.loading" @click="preset('summarize')">总结</button>
        <button class="preset-btn preset-doc" :disabled="aiStore.loading" @click="askWithDoc">带入文档</button>
      </div>

      <!-- 输入 -->
      <div class="ai-input">
        <!-- 图片预览条（GLM 识图模式） -->
        <div v-if="aiStore.provider === 'glm' && aiStore.pendingImages.length" class="img-preview-strip">
          <div v-for="(img, i) in aiStore.pendingImages" :key="i" class="img-thumb">
            <img :src="img" />
            <button class="img-remove" @click="aiStore.removeImage(i)">×</button>
          </div>
        </div>
        <div class="ai-input-row">
          <el-tooltip v-if="aiStore.provider === 'glm'" content="上传图片识图" placement="top">
            <el-button text class="img-upload-btn" :disabled="aiStore.loading" @click="imgInputRef?.click()">
              <el-icon><Picture /></el-icon>
            </el-button>
          </el-tooltip>
          <el-input
            v-model="input"
            type="textarea"
            :autosize="{ minRows: 1, maxRows: 5 }"
            :placeholder="aiStore.provider === 'glm' ? '上传图片或输入问题，Enter 发送' : '输入问题，Enter 发送，Shift+Enter 换行'"
            resize="none"
            @keydown.enter.exact.prevent="sendInput"
          />
          <el-button v-if="!aiStore.loading" type="primary" class="send-btn" @click="sendInput">发送</el-button>
          <el-button v-else class="send-btn" @click="aiStore.stop()">停止</el-button>
        </div>
        <input ref="imgInputRef" type="file" accept="image/*" multiple hidden @change="handleImageSelect" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { Setting, Delete, Close, Picture } from '@element-plus/icons-vue'
import { useAIStore, AI_PRESETS } from '@/stores/ai'
import { useDocumentStore } from '@/stores/document'
import { mdToHtml } from '@/utils/markdown'
import { testChatCompletion } from '@/utils/deepseek'
import { ElMessage } from 'element-plus'
import LottieLoading from './LottieLoading.vue'
import assistantAnim from '@/assets/ai-assistant-bubble.json'
import { aiLoadingAnimation } from '@/assets/aiLoading'

const props = defineProps<{ visible: boolean; editor: any }>()
const aiStore = useAIStore()

// 跟随编辑区选区实时刷新的「引用」内容：editor.getSelectedText 已兼容失焦后回退 remember
function readSelected() {
  const s = (props.editor?.getSelectedText?.() || '').trim()
  refText.value = s
  refLen.value = s.length
}
// 引用栏内容：编辑器内选中文字（实时）
const refText = ref('')
const refLen = ref(0)
const referencedText = computed(() => refText.value)
const referencedLen = computed(() => refLen.value)

let rafId: number | null = null
function scheduleReadSelected() {
  // requestAnimationFrame 合帧，避免 selectionchange 高频触发反复刷新
  if (rafId != null) return
  rafId = requestAnimationFrame(() => { rafId = null; readSelected() })
}

// 面板可见期间跟踪编辑区/面板的选区变化，刷新引用栏
let cleanupSelectionWatch: (() => void) | null = null
watch(() => props.visible, (v) => {
  cleanupSelectionWatch?.()
  cleanupSelectionWatch = null
  if (!v) return
  const onSel = () => scheduleReadSelected()
  readSelected()
  document.addEventListener('selectionchange', onSel)
  window.addEventListener('mouseup', onSel)
  const el = props.editor?.getEditorElement?.()
  if (el) el.addEventListener('mouseup', onSel)
  cleanupSelectionWatch = () => {
    document.removeEventListener('selectionchange', onSel)
    window.removeEventListener('mouseup', onSel)
    el?.removeEventListener('mouseup', onSel)
  }
}, { immediate: true })
onBeforeUnmount(() => { cleanupSelectionWatch?.() })
const docStore = useDocumentStore()
const input = ref('')
const configVisible = ref(false)
const messagesRef = ref<HTMLElement>()
const imgInputRef = ref<HTMLInputElement>()
const connStatus = ref('')
const connOk = ref(false)
const glmConnStatus = ref('')
const glmConnOk = ref(false)

const lastIdx = computed(() => aiStore.messages.length - 1)

// 每条助手消息思考链的展开状态（默认折叠，避免冗余思考抢占阅读焦点）
const reasoningOpen = ref<Record<number, boolean>>({})
function toggleReasoning(i: number) {
  reasoningOpen.value = { ...reasoningOpen.value, [i]: !reasoningOpen.value[i] }
}

async function testLocal() {
  connStatus.value = '测试中…'
  connOk.value = false
  const r = await aiStore.testConnection()
  connOk.value = r.ok
  connStatus.value = r.ok ? (r.info ? `已连接：${r.info}` : '已连接') : (r.error || '未连接')
}

async function testGlm() {
  if (!aiStore.glmKey.trim()) {
    glmConnStatus.value = '请先填写 GLM API Key'
    glmConnOk.value = false
    return
  }
  glmConnStatus.value = '测试中…'
  glmConnOk.value = false
  const r = await testChatCompletion(aiStore.baseUrl, aiStore.glmKey.trim(), aiStore.glmModel)
  glmConnOk.value = r.ok
  glmConnStatus.value = r.ok ? (r.info || '已连接') : (r.error || '未连接')
}

function renderMd(md: string | any[], _i: number): string {
  const s = asText(md)
  if (!s) return ''
  try { return mdToHtml(s) } catch { return s }
}

// 取消息纯文本（多模态 content 取 text 片段拼接；助手消息恒为 string）
function asText(content: string | any[]): string {
  if (typeof content === 'string') return content
  return (content as any[])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesRef.value) messagesRef.value.scrollTop = messagesRef.value.scrollHeight
  })
}
watch(() => aiStore.messages.length, scrollToBottom)
watch(() => aiStore.messages[aiStore.messages.length - 1]?.content, scrollToBottom)

async function sendInput() {
  const text = input.value.trim()
  const hasImg = aiStore.pendingImages.length > 0
  if ((!text && !hasImg) || aiStore.loading) return
  input.value = ''
  await aiStore.send(text || '请详细描述这张图片的内容。')
  scrollToBottom()
}

// 图片选择：读为 base64 data URL，加入 pendingImages
function handleImageSelect(e: Event) {
  const target = e.target as HTMLInputElement
  const files = target.files
  if (!files || !files.length) return
  for (const file of Array.from(files)) {
    if (!file.type.startsWith('image/')) {
      ElMessage.warning(`仅支持图片文件：${file.name}`)
      continue
    }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const r = aiStore.addImage(dataUrl)
      if (!r.ok) ElMessage.warning(r.error || '添加失败')
      else ElMessage.success({ message: `已添加图片 ${file.name}`, duration: 1200 })
    }
    reader.onerror = () => ElMessage.error(`读取失败：${file.name}`)
    reader.readAsDataURL(file)
  }
  // 重置 input 以便重复选择同一文件
  target.value = ''
}

async function preset(key: string) {
  const sel = props.editor?.getSelectedText?.() || ''
  if (!sel) { ElMessage.warning('请先在编辑器选中文字'); return }
  await aiStore.send(AI_PRESETS[key], { selection: sel })
  scrollToBottom()
}

async function askWithDoc() {
  props.editor?.flushSync?.()
  const doc = docStore.activeDocument?.content || ''
  const text = input.value.trim() || '请阅读下面的文档并回答我的问题。'
  input.value = ''
  await aiStore.send(text, { doc })
  scrollToBottom()
}

function insertToCursor(text: string) {
  props.editor?.insertTextAtCursor?.(text)
  ElMessage.success('已插入到光标')
}
function replaceSel(text: string) {
  props.editor?.replaceSelection?.(text)
  ElMessage.success('已替换选区')
}
async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); ElMessage.success('已复制') } catch { ElMessage.error('复制失败') }
}
</script>

<style lang="scss" scoped>
/* —— 常驻面板：宽度过渡，收起时宽度 0 —— */
.ai-panel {
  width: 380px;
  min-width: 0;
  flex-shrink: 0;
  overflow: hidden;
  transition: width 0.28s ease, opacity 0.28s ease;

  &.is-collapsed {
    width: 0;
    opacity: 0;
  }
}
.ai-panel-inner {
  width: 380px;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  border-left: 1px solid var(--border-color);
}

/* —— 顶部 —— */
.ai-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);

  .ai-title {
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .ai-header-actions {
    display: flex;
    gap: 2px;
  }
  .header-btn {
    color: var(--text-muted);
    border-radius: 2px;
    transition: all 0.2s;
    &:hover,
    &.active {
      color: var(--accent-color);
      background: var(--bg-tertiary);
    }
  }
}

/* —— 配置区 —— */
.ai-config {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  display: flex;
  flex-direction: column;
  gap: 10px;

  .config-row {
    display: flex;
    align-items: center;
    gap: 8px;
    label {
      width: 62px;
      color: var(--text-secondary);
      font-size: 13px;
      flex-shrink: 0;
    }
    .config-hint {
      font-size: 12px;
      color: var(--text-muted);
    }
  }
  .provider-switch {
    display: flex;
    flex: 1;
    border: 1px solid var(--border-color);
    border-radius: 2px;
    overflow: hidden;
  }
  .prov-btn {
    flex: 1;
    padding: 5px 8px;
    font-size: 12.5px;
    color: var(--text-secondary);
    background: var(--bg-primary);
    border: none;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.2s;
    &.active {
      color: #fff;
      background: var(--accent-color);
    }
    &:not(.active):hover {
      background: var(--bg-tertiary);
    }
  }
  .test-btn {
    border-radius: 2px !important;
  }
  .conn-status {
    font-size: 12px;
    color: var(--text-muted);
    margin-left: 4px;
    &.ok {
      color: var(--accent-color);
    }
  }
  .config-hint-row {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.6;
    margin: 2px 0 0;
  }
}

/* —— 消息列表 —— */
.ai-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* —— 空状态：lottie 常驻 —— */
.ai-empty {
  margin: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  text-align: center;
  color: var(--text-muted);

  .ai-empty-main {
    font-size: 13.5px;
    line-height: 1.85;
    color: var(--text-secondary);
  }
  .ai-empty-sub {
    font-size: 12px;
    color: var(--text-muted);
  }
}

/* —— 平卡 + 发丝线（站点 showcase 同款） —— */
.ai-msg {
  display: flex;
}
.ai-msg.user {
  justify-content: flex-end;
}
.ai-msg.assistant {
  justify-content: flex-start;
}
.msg-bubble {
  max-width: 88%;
  padding: 12px 14px;
  border-radius: 2px;
  border: 1px solid var(--border-color);
  font-size: 13.5px;
  line-height: 1.65;
  word-break: break-word;
}
.ai-msg.user .msg-bubble {
  background: var(--bg-secondary);
  color: var(--text-primary);
}
.ai-msg.assistant .msg-bubble {
  background: var(--bg-primary);
  color: var(--text-secondary);
}
.user-text {
  white-space: pre-wrap;
}

/* AI 回复：标题用衬线（典雅书卷），其余无衬线。
   关键：复用编辑器 .markdown-body 会带入 padding:40px 60px / max-width / margin:auto 等正文级样式，
   在气泡里表现为上下左右大片留白。这里整体覆盖回气泡级，避免边距过大。 */
.msg-text.markdown-body {
  font-size: 13.5px;
  line-height: 1.65;
  padding: 0;
  max-width: none;
  margin: 0;
  min-height: 0;

  .ai-md-content {
    & > :first-child { margin-top: 0; }
    & > :last-child { margin-bottom: 0; }
  }
  :deep(h1),
  :deep(h2),
  :deep(h3),
  :deep(h4) {
    font-family: "Georgia", "Songti SC", "Source Han Serif SC", "Noto Serif SC", serif;
    color: var(--text-primary);
    font-weight: 600;
    margin: 10px 0 5px;
    line-height: 1.3;
  }
  :deep(h1) { font-size: 1.2em; }
  :deep(h2) { font-size: 1.12em; }
  :deep(h3) { font-size: 1.05em; }
  :deep(h4) { font-size: 1em; }
  :deep(p) { margin: 5px 0; }
  :deep(ul),
  :deep(ol) {
    padding-left: 20px;
    margin: 5px 0;
  }
  :deep(li) { margin: 3px 0; }
  :deep(pre) {
    background: var(--code-bg);
    padding: 10px;
    border-radius: 2px;
    overflow-x: auto;
    margin: 8px 0;
    font-size: 12.5px;
  }
  :deep(code) {
    font-family: "JetBrains Mono", Consolas, monospace;
    font-size: 12.5px;
  }
  :deep(blockquote) {
    border-left: 3px solid var(--blockquote-border);
    padding-left: 10px;
    color: var(--text-muted);
    margin: 6px 0;
  }
}

/* —— 思考链（reasoning_content）：与正文分离，折叠展示，克制的次级信息 —— */
.reasoning-block {
  margin: 0 0 8px;
  padding: 6px 10px;
  border-left: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  border-radius: 2px;
  font-size: 12px;
  color: var(--text-muted);
}
.reasoning-toggle {
  font-size: 12px;
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  border: none;
  background: none;
  cursor: pointer;
  font-family: inherit;
  letter-spacing: 0.05em;
  &:hover { color: var(--text-secondary); }
}
.reasoning-arrow {
  display: inline-block;
  font-size: 10px;
  transition: transform 0.2s ease;
  &.open { transform: rotate(90deg); }
}
.reasoning-body {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--border-color);
  line-height: 1.6;
  white-space: pre-wrap;
  color: var(--text-tertiary);
  :deep(p) { margin: 4px 0; }
}

/* —— 气泡内动作 —— */
.msg-actions {
  display: flex;
  gap: 2px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-color);
}
.action-btn {
  font-size: 12px;
  color: var(--text-muted);
  padding: 3px 8px;
  border-radius: 2px;
  cursor: pointer;
  border: none;
  background: none;
  font-family: inherit;
  transition: all 0.2s;

  &:hover {
    color: var(--accent-color);
    background: var(--bg-tertiary);
  }
}

/* —— 预设：胶囊按钮 —— */
/* —— 当前引用选中文字（选段实时提示） —— */
.ai-refbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 16px 0;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 2px;
  background: var(--bg-secondary);
  font-size: 12px;
  line-height: 1.5;
  min-height: 30px;
  box-sizing: border-box;
  max-height: 64px;
  overflow: hidden;
}
.ref-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-primary);
}
.ref-label {
  flex-shrink: 0;
  color: var(--text-secondary);
}
.ref-body {
  flex: 1;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}
.ref-count {
  flex-shrink: 0;
  color: var(--text-tertiary);
}

.ai-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 16px;
  border-top: 1px solid var(--border-color);
}
.preset-btn {
  font-size: 12.5px;
  color: var(--text-secondary);
  padding: 4px 12px;
  border-radius: 2px;
  cursor: pointer;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  font-family: inherit;
  transition: all 0.2s;

  &:hover:not(:disabled) {
    color: var(--accent-color);
    border-color: var(--accent-color);
  }
  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  &.preset-doc {
    color: var(--accent-color);
    border-color: var(--accent-color);
  }
}

/* —— 输入 —— */
.ai-input {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border-color);
  align-items: stretch;

  .ai-input-row {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  :deep(.el-textarea__inner) {
    border-radius: 2px;
    box-shadow: none;
    &:focus {
      border-color: var(--accent-color);
    }
  }
}
.img-upload-btn {
  color: var(--text-muted);
  padding: 6px 8px;
  border-radius: 2px;
  flex-shrink: 0;
  &:hover:not(:disabled) {
    color: var(--accent-color);
    background: var(--bg-tertiary);
  }
  &:disabled {
    opacity: 0.4;
  }
}
/* 图片预览条 */
.img-preview-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  .img-thumb {
    position: relative;
    width: 56px;
    height: 56px;
    border-radius: 2px;
    overflow: hidden;
    border: 1px solid var(--border-color);
    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
  }
  .img-remove {
    position: absolute;
    top: -2px;
    right: -2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: none;
    background: var(--text-primary);
    color: var(--bg-primary);
    font-size: 11px;
    line-height: 14px;
    text-align: center;
    cursor: pointer;
    padding: 0;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  }
}
/* 用户消息内的图片 */
.user-img {
  max-width: 100%;
  border-radius: 2px;
  margin: 4px 0;
  display: block;
}
.send-btn {
  border-radius: 2px !important;
}
</style>
