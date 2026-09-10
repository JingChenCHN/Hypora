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
          <el-tooltip content="删除当前对话" placement="bottom">
            <el-button text class="header-btn" :disabled="aiStore.loading" @click="clearCurrentChat">
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

      <!-- 会话栏：当前对话命名 + 新建 + 历史列表 -->
      <div class="chat-bar">
        <button class="chat-bar-btn" @click="showChatList = !showChatList">
          <span class="chat-bar-title">{{ activeChatTitle }}</span>
          <el-icon class="chat-caret" :class="{ open: showChatList }"><ArrowDown /></el-icon>
        </button>
        <el-tooltip content="新建对话" placement="bottom">
          <button class="chat-bar-new" @click="handleNewChat">
            <el-icon><Plus /></el-icon>
          </button>
        </el-tooltip>
      </div>

      <!-- 历史对话浮层 -->
      <template v-if="showChatList">
        <div class="chat-list-backdrop" @click="closeChatList"></div>
        <div class="chat-list">
          <div class="chat-list-head">
            <span>历史对话</span>
            <span class="chat-list-count">{{ aiStore.chats.length }}</span>
          </div>
          <div v-if="aiStore.chats.length === 0" class="chat-list-empty">暂无历史对话</div>
          <div v-else class="chat-list-scroll">
            <div
              v-for="c in sortedChats"
              :key="c.id"
              class="chat-item"
              :class="{ active: c.id === aiStore.activeChatId }"
              @click="pickChat(c.id)"
            >
              <template v-if="editingId === c.id">
                <input
                  v-focus
                  v-model="editingTitle"
                  class="chat-rename-input"
                  @keydown.enter.prevent="commitRename(c.id)"
                  @keydown.esc.prevent="cancelRename"
                  @blur="commitRename(c.id)"
                  @click.stop
                />
              </template>
              <template v-else>
                <div class="chat-item-main" @dblclick="startRename(c)">
                  <div class="chat-item-title">{{ c.title || '新对话' }}</div>
                  <div class="chat-item-meta">{{ formatChatTime(c.updatedAt) }} · {{ c.messages.length }} 条</div>
                </div>
                <div class="chat-item-actions" @click.stop>
                  <button class="chat-act" title="重命名" @click="startRename(c)"><el-icon><Edit /></el-icon></button>
                  <button class="chat-act" title="删除" @click="removeChat(c)"><el-icon><Delete /></el-icon></button>
                </div>
              </template>
            </div>
          </div>
        </div>
      </template>

      <!-- 配置区 -->
      <div v-show="configVisible" class="ai-config">
        <!-- 引擎切换 -->
        <div class="config-row">
          <label>引擎</label>
          <div class="provider-switch">
            <button class="prov-btn" :class="{ active: aiStore.provider === 'deepseek' }" @click="aiStore.setProvider('deepseek')">DeepSeek</button>
            <button class="prov-btn" :class="{ active: aiStore.provider === 'glm' }" @click="aiStore.setProvider('glm')">GLM</button>
            <button class="prov-btn" :class="{ active: aiStore.provider === 'local' }" @click="aiStore.setProvider('local')">
              <span v-if="hasEngine" class="prov-dot" :class="aiStore.engineDot"></span>
              <span>{{ hasEngine ? '内置助手' : '外部 LLM' }}</span>
            </button>
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
              <el-option label="glm-5.3-flash (免费对话)" value="glm-5.3-flash" />
              <el-option label="glm-5.3" value="glm-5.3" />
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
          <p class="config-hint-row">GLM 既是对话助手也可识图：对话默认用 <code>glm-5.3-flash</code>；如需提取图片内容，把模型切到 <code>glm-4v-flash</code> 并在输入区点「图片」上传（最多 5 张）。在本页填写你的智谱 API Key，Key 仅存于本地浏览器、经同源代理转发，不落服务器。</p>
        </template>

        <template v-else>
          <!-- 形态 A：托管内置助手（桌面端有引擎且 localMode=managed）——状态行 + 模型卡 + 高级折叠 -->
          <template v-if="hasEngine && aiStore.localMode === 'managed'">
            <div class="engine-row">
              <span class="prov-dot dot-lg" :class="aiStore.engineDot"></span>
              <span class="engine-status">{{ aiStore.engineStatusText }}</span>
              <span class="flex-spacer"></span>
              <el-button v-if="aiStore.engineRunning" size="small" class="engine-btn" @click="aiStore.stopEngine()">停止</el-button>
              <el-button v-else size="small" class="engine-btn" :disabled="aiStore.engineStarting" @click="onStartEngine">
                {{ aiStore.engineStarting ? '启动中' : '启动' }}
              </el-button>
            </div>

            <div class="model-card">
              <div class="model-card-head">
                <span class="model-card-label">内置模型</span>
                <button class="link-btn" @click="onOpenModelsDir">打开目录</button>
              </div>
              <div v-for="m in modelList" :key="m.name" class="model-item">
                <div class="model-item-main">
                  <span class="model-card-name">{{ m.name }}</span>
                  <span v-if="m.isDefault" class="model-tag">默认</span>
                  <span class="flex-spacer"></span>
                  <el-button v-if="rowState(m) === 'can-download'" size="small" class="engine-btn" @click="onDownload(m.name)">
                    {{ dlPhase === 'error' && dlModelName === m.name ? '重试下载' : '下载' }}
                  </el-button>
                  <el-button v-else-if="rowState(m) === 'downloading'" size="small" class="engine-btn" @click="onDownloadCancel">暂停</el-button>
                  <span v-else-if="rowState(m) === 'paused-other'" class="model-quiet">另一模型下载中</span>
                  <span v-else class="model-quiet model-ok">已就绪</span>
                </div>
                <div class="model-card-size">{{ m.exists ? `已下载 · ${formatBytes(m.size)}` : `未下载 · 约 ${formatBytes(m.bytes)}` }}</div>
              </div>
              <template v-if="dlPhase === 'downloading'">
                <div class="dl-track"><div class="dl-fill" :style="{ width: dlPercent + '%' }"></div></div>
                <div class="dl-readout">
                  {{ dlModelName }} · {{ formatBytes(aiStore.engineDownload?.receivedBytes) }} / {{ formatBytes(aiStore.engineDownload?.totalBytes) }}
                  · {{ formatSpeed(aiStore.engineDownload?.bytesPerSecond) }} · {{ dlPercent }}%
                </div>
              </template>
              <div v-else-if="dlPhase === 'error'" class="dl-readout">下载失败：{{ aiStore.engineDownload?.error }}</div>
            </div>

            <button class="adv-toggle" @click="advOpen = !advOpen">
              <span class="adv-arrow" :class="{ open: advOpen }">▸</span>
              高级：外部 llama-server
            </button>
            <div v-show="advOpen" class="adv-body">
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
                <el-button size="small" class="test-btn" @click="testLocalExternal">测试</el-button>
                <span class="conn-status" :class="{ ok: connOk }">{{ connStatus }}</span>
              </div>
              <p class="config-hint-row">内置助手不使用这里的地址；此处仅用于连接你自建的外部 llama-server。MiniCPM5 会先输出思考链再回答。</p>
            </div>
          </template>

          <!-- 形态 B：外部 llama-server（无引擎的 Web/Tauri，或有引擎但用户选外部） -->
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
            <p class="config-hint-row">需运行外部 llama-server 并使其可访问下方地址。MiniCPM5 会先输出思考链再回答。</p>
            <button v-if="hasEngine" class="adv-toggle" @click="useManagedMode">改用内置助手</button>
          </template>
        </template>
      </div>

      <!-- 消息列表 -->
      <div class="ai-messages" ref="messagesRef">
        <!-- 空状态：lottie 常驻展示 -->
        <div v-if="aiStore.messages.length === 0" class="ai-empty">
          <LottieLoading :animation="assistantAnim" size="large" class="empty-anim" />
          <p class="ai-empty-main">选中编辑器文字，让 AI 帮你<br />改写 · 解释 · 翻译 · 扩写 · 总结</p>
          <p class="ai-empty-sub">或在下方直接提问 · GLM 可对话 / 切识图模型上传图片</p>
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
import { Setting, Delete, Close, Picture, Plus, ArrowDown, Edit } from '@element-plus/icons-vue'
import { useAIStore, AI_PRESETS } from '@/stores/ai'
import { useDocumentStore } from '@/stores/document'
import { mdToHtml } from '@/utils/markdown'
import { testChatCompletion, testConnection as testExternalConn } from '@/utils/deepseek'
import { hasAiEngine, engineApi } from '@/utils/aiEngine'
import { ElMessage, ElMessageBox } from 'element-plus'
import LottieLoading from './LottieLoading.vue'
import assistantAnim from '@/assets/ai-assistant-bubble.json'
import { aiLoadingAnimation } from '@/assets/aiLoading'

const props = defineProps<{ visible: boolean; editor: any }>()
const aiStore = useAIStore()

// 重命名输入自动聚焦（script setup 局部指令）
const vFocus = { mounted: (el: HTMLInputElement) => { el.focus(); el.select() } }

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
  // 面板打开且选了内置助手但模型文件缺失：自动展开配置区，让用户第一眼看到模型卡与下载入口
  if (aiStore.provider === 'local' && hasEngine && aiStore.localMode === 'managed' && aiStore.engineModel && !aiStore.engineModel.modelExists) {
    configVisible.value = true
  }
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

// ===== 内置本地助手（托管引擎）=====
// 引擎能力门：仅 Windows Electron 桌面端为 true；Web/Tauri 恒为 false（不渲染任何引擎 UI）
const hasEngine = hasAiEngine()
// 高级折叠区（外部 llama-server 地址/模型/测试）默认收起
const advOpen = ref(false)

const dlPhase = computed(() => aiStore.engineDownload?.phase ?? 'idle')
// 进度条宽度收敛到 0-100，避免异常推送把轨道撑爆
const dlPercent = computed(() => {
  const p = aiStore.engineDownload?.percent ?? 0
  return Math.min(100, Math.max(0, Math.round(p)))
})
// 双模型：config.models 驱动模型卡；正在下载的模型名来自下载推送
const modelList = computed(() => aiStore.engineModel?.models ?? [])
const dlModelName = computed(() => aiStore.engineDownload?.model ?? null)
// 行状态：就绪 / 本模型下载中（暂停）/ 他模型下载中（排队提示）/ 可下载（含失败重试）
function rowState(m: { name: string; exists: boolean }): 'ready' | 'downloading' | 'paused-other' | 'can-download' {
  if (m.exists) return 'ready'
  if (dlPhase.value === 'downloading') return dlModelName.value === m.name ? 'downloading' : 'paused-other'
  return 'can-download'
}

async function onStartEngine() {
  const ok = await aiStore.startEngine()
  if (!ok && !aiStore.engineRunning) {
    ElMessage.error(aiStore.engineError ? `内置助手启动失败：${aiStore.engineError}` : '内置助手启动失败')
  }
}
function onDownload(name?: string) {
  // 下载进度由主进程推送写入 aiStore.engineDownload，这里只负责发起（name 缺省用引擎默认模型）
  void engineApi.download(name)
}
function onDownloadCancel() {
  void engineApi.downloadCancel()
}
async function onOpenModelsDir() {
  const r = await engineApi.openModelsDir()
  if (r && !r.ok) ElMessage.error(r.error || '打开模型目录失败')
}
// 高级区的测试必须强制走外部 baseUrl：store.testConnection 在托管模式会路由到引擎端点
async function testLocalExternal() {
  connStatus.value = '测试中…'
  connOk.value = false
  const r = await testExternalConn(aiStore.baseUrl, undefined)
  connOk.value = r.ok
  connStatus.value = r.ok ? (r.info ? `已连接：${r.info}` : '已连接') : (r.error || '未连接')
}
// 有引擎但用户选了外部模式：一键切回托管内置助手
function useManagedMode() {
  aiStore.localMode = 'managed'
  aiStore.saveToLocal()
}

// 字节/速率读数：GB 一位小数、MB 取整；0/undefined 显示占位 —
function formatBytes(n?: number): string {
  if (!n) return '—'
  const gb = n / (1024 * 1024 * 1024)
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  const mb = n / (1024 * 1024)
  if (mb >= 1) return `${Math.round(mb)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}
function formatSpeed(n?: number): string {
  if (!n) return '—'
  return `${(n / (1024 * 1024)).toFixed(1)} MB/s`
}

const lastIdx = computed(() => aiStore.messages.length - 1)

// ===== 会话列表（历史对话）=====
const showChatList = ref(false)
const editingId = ref('')
const editingTitle = ref('')

const activeChatTitle = computed(() => {
  const c = aiStore.activeChat
  if (c?.title) return c.title
  return c && c.messages.length ? '未命名对话' : '新对话'
})

// 最近更新的会话排前面
const sortedChats = computed(() => [...aiStore.chats].sort((a, b) => b.updatedAt - a.updatedAt))

function closeChatList() {
  showChatList.value = false
  cancelRename()
}

function pickChat(id: string) {
  if (editingId.value === id) return // 重命名中不触发切换
  aiStore.switchChat(id)
  closeChatList()
  scrollToBottom()
}

function handleNewChat() {
  aiStore.newChat()
  closeChatList()
  scrollToBottom()
}

function startRename(c: { id: string; title: string }) {
  editingId.value = c.id
  editingTitle.value = c.title
}

function cancelRename() {
  editingId.value = ''
  editingTitle.value = ''
}

function commitRename(id: string) {
  if (editingId.value !== id) return
  aiStore.renameChat(id, editingTitle.value)
  cancelRename()
}

// 删除会话：空会话直接删，非空需确认
async function removeChat(c: { id: string; title: string; messages: unknown[] }) {
  if (c.messages.length) {
    try {
      await ElMessageBox.confirm(
        `删除对话「${c.title || '未命名对话'}」？删除后无法恢复。`,
        '删除对话',
        { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
      )
    } catch { return }
  }
  if (aiStore.loading && c.id === aiStore.activeChatId) {
    ElMessage.warning('AI 正在回复，请先停止')
    return
  }
  aiStore.deleteChat(c.id)
  scrollToBottom()
}

// 顶栏垃圾桶 = 删除当前对话
async function clearCurrentChat() {
  const c = aiStore.activeChat
  if (c && c.messages.length) {
    try {
      await ElMessageBox.confirm(
        `删除当前对话「${c.title || '未命名对话'}」？删除后无法恢复。`,
        '删除对话',
        { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
      )
    } catch { return }
  }
  aiStore.clearMessages()
  scrollToBottom()
}

function formatChatTime(ts: number) {
  if (!ts) return '—'
  const date = new Date(ts)
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  if (date.toDateString() === now.toDateString()) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
  const days = Math.floor((now.getTime() - ts) / 86400000)
  if (days < 7 && days >= 1) return `${days} 天前`
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

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
watch(() => aiStore.activeChatId, scrollToBottom)

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
// 复制文本：优先 navigator.clipboard（需 HTTPS/localhost 安全上下文）；
// 本机生产站点走 HTTP，navigator.clipboard 不存在，回退到临时 textarea + execCommand 方案（HTTP 下可用）
function copyText(text: string) {
  const fallbackCopy = () => {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    ta.style.pointerEvents = 'none'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    try {
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      if (ok) ElMessage.success('已复制')
      else ElMessage.error('复制失败')
    } catch {
      document.body.removeChild(ta)
      ElMessage.error('复制失败')
    }
  }
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => ElMessage.success('已复制')).catch(fallbackCopy)
  } else {
    fallbackCopy()
  }
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
  position: relative;
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

/* —— 会话栏：当前对话命名 + 新建 —— */
.chat-bar {
  display: flex;
  align-items: stretch;
  gap: 1px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
}
.chat-bar-btn {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: none;
  background: none;
  cursor: pointer;
  font-family: inherit;
  border-radius: 2px;
  transition: background 0.2s;

  &:hover { background: var(--bg-tertiary); }
}
.chat-bar-title {
  flex: 1;
  min-width: 0;
  text-align: left;
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chat-caret {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-muted);
  transition: transform 0.2s ease;
  &.open { transform: rotate(180deg); }
}
.chat-bar-new {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 4px 10px;
  border: none;
  background: none;
  cursor: pointer;
  color: var(--text-muted);
  border-radius: 2px;
  transition: all 0.2s;

  &:hover { color: var(--accent-color); background: var(--bg-tertiary); }
}

/* —— 历史对话浮层 —— */
.chat-list-backdrop {
  position: absolute;
  inset: 0;
  z-index: 5;
}
.chat-list {
  position: absolute;
  z-index: 6;
  top: 86px; /* 顶栏 + 会话栏下缘（两者高度固定） */
  left: 10px;
  right: 10px;
  max-height: 55%;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 2px;
  box-shadow: var(--shadow-overlay);
}
.chat-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.chat-list-count {
  font-size: 11px;
  letter-spacing: 0.05em;
}
.chat-list-empty {
  padding: 24px 12px;
  text-align: center;
  font-size: 12.5px;
  color: var(--text-muted);
}
.chat-list-scroll {
  overflow-y: auto;
}
.chat-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--border-color);
  transition: background 0.2s;

  &:last-child { border-bottom: none; }
  &:hover {
    background: var(--bg-tertiary);
    .chat-item-actions { opacity: 1; }
  }
  &.active {
    background: var(--bg-tertiary);
    box-shadow: inset 2px 0 0 var(--accent-color);

    .chat-item-title { color: var(--accent-color); }
  }
}
.chat-item-main {
  flex: 1;
  min-width: 0;
}
.chat-item-title {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chat-item-meta {
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--text-muted);
}
.chat-item-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.2s;
}
.chat-act {
  display: flex;
  align-items: center;
  padding: 3px;
  border: none;
  background: none;
  cursor: pointer;
  color: var(--text-muted);
  font-size: 13px;
  border-radius: 2px;
  transition: all 0.2s;

  &:hover { color: var(--accent-color); background: var(--bg-secondary); }
}
.chat-rename-input {
  flex: 1;
  min-width: 0;
  font-family: inherit;
  font-size: 13px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 2px;
  padding: 3px 8px;
  outline: none;

  &:focus { border-color: var(--accent-color); }
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
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 5px 8px;
    font-size: 12.5px;
    color: var(--text-secondary);
    background: var(--bg-primary);
    border: none;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.2s;
    &.active {
      color: var(--bg-primary);
      background: var(--accent-color);
    }
    &:not(.active):hover {
      background: var(--bg-tertiary);
    }
  }
  /* —— 内置助手：状态点（面板与工具栏共用规格：6px，状态行 8px）—— */
  .prov-dot {
    flex-shrink: 0;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--border-color);

    &.ok { background: var(--el-color-success); }
    &.err { background: var(--el-color-danger); }
    &.off { background: var(--border-color); }
    &.dot-lg { width: 8px; height: 8px; }
  }
  /* —— 引擎状态行：点 + 文案 + 启停按钮 —— */
  .engine-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .engine-status {
    font-size: 12.5px;
    color: var(--text-primary);
  }
  .flex-spacer {
    flex: 1;
  }
  .engine-btn {
    border-radius: 2px !important;
  }
  .link-btn {
    border: none;
    background: none;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    color: var(--text-muted);
    padding: 2px 4px;
    border-radius: 2px;
    transition: all 0.2s;

    &:hover { color: var(--text-primary); background: var(--bg-tertiary); }
  }
  /* —— 内置模型卡：平卡（hair 描边、方角、无阴影）—— */
  .model-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 2px;
  }
  .model-card-label {
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .model-card-name {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-primary);
    word-break: break-all;
  }
  .model-card-size {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }
  .model-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .model-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: 6px;
    border-top: 1px solid var(--border-color);
  }
  .model-item-main {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .model-tag {
    font-size: 10px;
    letter-spacing: 0.16em;
    color: var(--text-secondary);
    border: 1px solid var(--border-color);
    padding: 0 4px;
    border-radius: 2px;
  }
  .model-quiet {
    font-size: 11px;
    color: var(--text-muted);
  }
  .model-ok {
    color: var(--el-color-success);
  }
  /* —— 下载进度：2px 方角轨道，墨色填充 —— */
  .dl-track {
    height: 2px;
    margin-top: 4px;
    background: var(--border-color);
    overflow: hidden;
  }
  .dl-fill {
    height: 100%;
    background: var(--text-primary);
    transition: width 0.2s linear;
  }
  .dl-readout {
    font-family: var(--font-mono);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }
  /* —— 高级折叠区：外部 llama-server（默认收起）—— */
  .adv-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    align-self: flex-start;
    padding: 2px 0;
    border: none;
    background: none;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    transition: color 0.2s;

    &:hover { color: var(--text-secondary); }
  }
  .adv-arrow {
    font-size: 10px;
    transition: transform 0.2s ease;
    &.open { transform: rotate(90deg); }
  }
  .adv-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
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
    font-family: var(--font-serif);
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
    font-family: var(--font-mono);
    font-size: 12.5px;
  }
  :deep(blockquote) {
    border-left: 2px solid var(--blockquote-border);
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
    box-shadow: var(--shadow-overlay);
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
