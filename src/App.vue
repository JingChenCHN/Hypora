<template>
  <!-- 整站登录门禁(仅网页版;桌面版 authNeeded() 为 false,永远走 else 分支) -->
  <LoginGate v-if="needAuth && !authStore.me" />
  <div v-else class="app-container">
    <Toolbar
      @action="handleEditorAction"
      @export="handleExport"
      @toggle-search="searchVisible = !searchVisible"
    />

    <div class="main-content">
      <Sidebar
        :outline="outline"
        :active-heading="activeHeading"
      />

      <!-- 编辑列：文本区 + 底部功能区（功能区只随文本区，不横贯侧边栏，Typora 式） -->
      <div class="editor-pane">
        <div class="editor-wrapper" ref="editorWrapperRef">
          <Editor
            ref="editorRef"
            @outline-update="handleOutlineUpdate"
            @stats-update="handleStatsUpdate"
            @context-action="handleContextAction"
          />

          <SearchPanel
            :visible="searchVisible"
            @close="searchVisible = false"
            @replace="handleReplace"
          />
        </div>

        <Statusbar
          :stats="stats"
          @toggle-dev="devVisible = true"
          @toggle-admin="adminVisible = true"
          @toggle-password="pwVisible = true"
        />
      </div>
      <AIPanel v-if="aiPanelAlive" :visible="aiStore.panelVisible" :editor="editorRef" />
    </div>

    <DevPanel v-model:visible="devVisible" />
    <CloudFiles :visible="cloudVisible" @close="cloudVisible = false" />
    <BackupFiles :visible="backupVisible" @close="backupVisible = false" />
    <AdminUsers :visible="adminVisible" @close="adminVisible = false" />
    <PasswordDialog :visible="pwVisible" @close="pwVisible = false" />

    <!-- 偏好设置（文件菜单 / 原生菜单共同入口；插图压缩偏好持久化 localStorage） -->
    <el-dialog v-model="prefVisible" title="偏好设置" width="380px" class="hypora-pref-dialog">
      <div class="pref-row">
        <span class="pref-label">插图质量</span>
        <el-slider v-model="imgPrefs.quality" :min="0.5" :max="1" :step="0.05" class="pref-slider" @change="persistImgPrefs" />
        <span class="pref-value">{{ imgPrefs.quality.toFixed(2) }}</span>
      </div>
      <div class="pref-row">
        <span class="pref-label">长边上限</span>
        <el-select v-model="imgPrefs.maxEdge" size="small" class="pref-select" @change="persistImgPrefs">
          <el-option v-for="e in edgeOptions" :key="e" :label="`${e} px`" :value="e" />
        </el-select>
      </div>
      <div class="pref-hint">作用于粘贴 / 拖入插图的压缩；≤150KB 小图与 GIF 原样保留；PNG 保持 PNG 格式，质量仅对 JPEG 生效</div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onErrorCaptured, defineAsyncComponent } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { copyCode, loadImgPrefs, saveImgPrefs } from '@/utils/markdown'
import { exportMarkdown, exportHTML, exportPDF, exportImage, cloudSave } from '@/utils/export'
import { useShortcuts } from '@/composables/useShortcuts'
import { setupGlobalErrorHandler, devLog, isElectron } from '@/utils/devMode'
import { setupTauriCompat, tauriAPI } from '@/utils/tauriAPI'
import Toolbar from './components/Toolbar.vue'
import Sidebar from './components/Sidebar.vue'
import Editor from './components/Editor.vue'
import Statusbar from './components/Statusbar.vue'
import SearchPanel from './components/SearchPanel.vue'
import DevPanel from './components/DevPanel.vue'
import CloudFiles from './components/CloudFiles.vue'
import BackupFiles from './components/BackupFiles.vue'
import LoginGate from './components/LoginGate.vue'
import AdminUsers from './components/AdminUsers.vue'
import PasswordDialog from './components/PasswordDialog.vue'
// AI 面板默认隐藏：异步组件 + 首次打开才挂载，把 lottie-web / 动画 JSON 移出首屏启动路径
const AIPanel = defineAsyncComponent(() => import('./components/AIPanel.vue'))
import type { OutlineItem } from '@/utils/markdown'
import { ElMessage } from 'element-plus'
import { useAIStore } from '@/stores/ai'
import { useAuthStore, authNeeded } from '@/stores/auth'

const docStore = useDocumentStore()
const aiStore = useAIStore()
const authStore = useAuthStore()

const editorRef = ref<InstanceType<typeof Editor>>()
const editorWrapperRef = ref<HTMLElement>()
const outline = ref<OutlineItem[]>([])
const activeHeading = ref('')
const stats = ref({ characters: 0, words: 0, lines: 0 })
const searchVisible = ref(false)
const devVisible = ref(false)
const cloudVisible = ref(false)
const backupVisible = ref(false)
const adminVisible = ref(false)
const pwVisible = ref(false)

// 偏好设置（插图压缩偏好；与 markdown.ts 压缩逻辑共享 localStorage 偏好）
const prefVisible = ref(false)
const imgPrefs = ref(loadImgPrefs())
const edgeOptions = [1024, 1440, 1920, 2560]
function persistImgPrefs() {
  saveImgPrefs({ quality: imgPrefs.value.quality, maxEdge: imgPrefs.value.maxEdge })
}

// 登录门禁只作用于网页版；桌面版恒 false
const needAuth = authNeeded()

// AI 面板首次可见后才挂载（之后保持存活以保留收起/展开动画）；
// 面板状态持久化在 aiStore，若上次启动时面板是打开的，启动时即加载
const aiPanelAlive = ref(false)
watch(() => aiStore.panelVisible, (v) => {
  if (v) aiPanelAlive.value = true
}, { immediate: true })

// 全局挂载复制代码方法
;(window as any).copyCode = copyCode

// 捕获 Vue 组件运行时错误
onErrorCaptured((err, instance, info) => {
  devLog.error(`Vue组件错误: ${err.message} (位置: ${info})`)
  return false
})

// 全局快捷键（编辑类快捷键由 Editor 组件 handleKeydown 处理，此处仅全局）
const zoomLevel = ref(100)
useShortcuts({
  'ctrl+s': () => saveDocument(),
  'ctrl+/': () => docStore.toggleSourceMode(),
  'f11': () => docStore.toggleFullscreen(),
  'f9': () => docStore.toggleSidebar(),
  'f12': () => { devVisible.value = !devVisible.value },
  'ctrl+f': () => {
    if (docStore.isPdfActive) { ElMessage.info('PDF 阅读模式不支持查找'); return }
    searchVisible.value = !searchVisible.value
  },
  'ctrl+h': () => { searchVisible.value = true },
  'ctrl+shift+=': () => setZoom(zoomLevel.value + 10),
  'ctrl+shift+-': () => setZoom(zoomLevel.value - 10),
  'ctrl+shift+0': () => setZoom(100),
  'ctrl+shift+t': () => docStore.toggleTypewriter(),
  'ctrl+shift+g': () => docStore.toggleFocus(),
  'ctrl+j': () => {
    if (docStore.isPdfActive) { ElMessage.info('PDF 阅读模式不支持 AI 助手'); return }
    aiStore.togglePanel()
  },
  'ctrl+shift+a': () => toggleAlwaysOnTop()
})

// 保存文档：有源文件路径则写回原文件；否则更新离线缓存并默认下载本地 .md 文件
async function saveDocument() {
  const doc = docStore.activeDocument
  if (!doc) return
  // PDF 为只读预览：绝不能走写回/导出链路（content 为空，写回会清空源文件）
  if (doc.kind === 'pdf') {
    ElMessage.info('PDF 为只读预览，无需保存')
    return
  }
  // 先立即同步所见即所得编辑内容（不等防抖），确保保存的是最新内容
  editorRef.value?.flushSync?.()
  const current = docStore.activeDocument
  if (!current) return

  // Electron 环境 + 有源文件路径：写回原文件
  if (current.filePath && (window as any).electronAPI?.writeFile) {
    const result = await (window as any).electronAPI.writeFile(current.filePath, current.content)
    if (result.success) {
      current.isSaved = true
      docStore.saveToLocal()
      ElMessage.success({ message: `已保存到文件: ${current.filePath}`, duration: 2000 })
      devLog.info(`保存到文件: ${current.filePath}`)
    } else {
      ElMessage.error(`保存失败: ${result.error}`)
      devLog.error(`保存失败: ${result.error}`)
    }
    return
  }

  // 无源文件路径（新建文档）或 Web 端：更新离线缓存 + 默认下载 .md 到本机
  docStore.saveToLocal()
  const ok = await exportMarkdown(current.content, current.title || 'document')
  if (ok) {
    // 离线缓存可能因配额超限未写入（含大图），提示语如实反映
    const uncached = docStore.unpersistedIds.has(current.id)
    if (uncached) {
      ElMessage.warning({ message: '浏览器缓存空间不足，.md 已下载（离线缓存未更新）', duration: 3000 })
      devLog.warn('Ctrl+S 保存：离线缓存写入失败（配额），.md 已下载')
    } else {
      ElMessage.success({ message: '已保存并下载 .md 文件', duration: 2000 })
      devLog.info('Ctrl+S 保存：缓存已更新 + .md 已下载')
    }
  } else {
    ElMessage.info('已保存到缓存，下载已取消')
    devLog.info('Ctrl+S 保存：缓存已更新，下载被用户取消')
  }
}

// 窗口置顶切换（always-on-top，Ctrl+Shift+A）
async function toggleAlwaysOnTop() {
  const api = (window as any).electronAPI
  if (!api?.winToggleAlwaysOnTop) {
    ElMessage.warning({ message: '窗口置顶仅在桌面客户端可用', duration: 1500 })
    return
  }
  const isOn = await api.winToggleAlwaysOnTop()
  ElMessage.success({ message: isOn ? '窗口已置顶' : '已取消置顶', duration: 1500 })
}

// 视图缩放（Typora Ctrl+Shift+=/-）；PDF 文档激活时直接驱动 PDF 缩放
function setZoom(level: number) {
  if (docStore.isPdfActive) {
    const next = Math.max(25, Math.min(400, level))
    docStore.pdfZoom = next
    docStore.pdfFitWidth = false
    ElMessage.success({ message: `缩放: ${next}%`, duration: 800 })
    return
  }
  zoomLevel.value = Math.max(50, Math.min(200, level))
  document.documentElement.style.setProperty('--editor-zoom', String(zoomLevel.value / 100))
  const editor = editorRef.value?.getEditorElement?.()
  if (editor) {
    (editor as HTMLElement).style.zoom = String(zoomLevel.value / 100)
  }
  ElMessage.success({ message: `缩放: ${zoomLevel.value}%`, duration: 800 })
}

onMounted(() => {
  // 初始化全局错误捕获和日志系统
  setupGlobalErrorHandler()
  // Tauri 环境适配（模拟 electronAPI，让现有前端代码复用）
  setupTauriCompat()
  devLog.info(`Hypora 启动, 运行环境: ${isElectron() ? (tauriAPI.isTauri() ? 'Tauri桌面版' : 'Electron桌面版') : 'Web浏览器'}`)

  // 登录门禁：网页版先确认会话再挂编辑器（共享浏览器的 localStorage 草稿
  // 不能在确认身份前渲染给任何人）；桌面版无门禁，直接引导
  if (needAuth) {
    authStore.init()
    authStore.readyPromise.then((me) => { if (me) bootstrapEditor() })
  } else {
    bootstrapEditor()
  }
})

// 编辑器引导（幂等）：确认登录后（或桌面版）才执行。
// 顺序敏感：必须先有身份，再 docStore.init()/aiStore.init()
let booted = false
function bootstrapEditor() {
  if (booted) return
  booted = true

  docStore.init()
  aiStore.init()

  // Tauri 关闭前保存（仅 Tauri 环境；Electron 走下面的 window.__saveBeforeClose）
  // 此前无条件注册，在 Electron 环境调 @tauri-apps/api 的 listen 会抛
  // "Cannot read properties of undefined (reading 'transformCallback')"，每次启动污染日志
  if (tauriAPI.isTauri()) {
    tauriAPI.onBeforeClose(async () => {
      try {
        editorRef.value?.flushSync?.()
        const doc = docStore.activeDocument
        // PDF 只读，不写回（content 为空，写回会清空源文件）
        if (doc?.filePath && doc?.kind !== 'pdf') {
          await tauriAPI.saveBeforeClose(doc.filePath, doc.content)
        }
        docStore.saveToLocal()
      } catch {}
    })
  }

  // 暴露关闭前保存方法（Electron 兼容）
  ;(window as any).__saveBeforeClose = async () => {
    try {
      editorRef.value?.flushSync?.()
      const doc = docStore.activeDocument
      // PDF 只读，不写回（content 为空，写回会清空源文件）
      if (doc?.kind === 'pdf') { docStore.saveToLocal(); return }
      if (doc?.filePath && (window as any).electronAPI?.writeFile) {
        await (window as any).electronAPI.writeFile(doc.filePath, doc.content)
      }
      docStore.saveToLocal()
      devLog.info('关闭前已保存')
    } catch (e: any) {
      devLog.error(`关闭前保存失败: ${e?.message || e}`)
    }
  }

  // 监听 Electron 菜单事件
  if (isElectron()) {
    window.electronAPI!.onMenuAction?.((action) => {
      devLog.info(`菜单动作: ${action}`)
      switch (action) {
        case 'new-document':
          docStore.newDocument()
          break
        case 'save':
          saveDocument()
          break
        case 'export-md':
          handleExport('md')
          break
        case 'export-html':
          handleExport('html')
          break
        case 'export-pdf':
          handleExport('pdf')
          break
        case 'export-image':
          handleExport('image')
          break
        case 'preference-settings':
          prefVisible.value = true
          break
        case 'dev-mode':
          devVisible.value = true
          break
        case 'toggle-source':
          docStore.toggleSourceMode()
          break
        case 'toggle-sidebar':
          docStore.toggleSidebar()
          break
        case 'search':
          searchVisible.value = !searchVisible.value
          break
        case 'show-shortcuts':
          devVisible.value = true
          break
      }
    })

    window.electronAPI!.onOpenFile?.((payload: { title: string; content: string; filePath?: string; kind?: string; base64?: string; error?: string }) => {
      // 打开失败的文件（过大等）：提示并放弃
      if (payload.error) {
        ElMessage.error(payload.error)
        return
      }
      // PDF 文档：字节走会话内存，进入只读预览
      if (payload.kind === 'pdf' && payload.base64) {
        docStore.importPdfDocument(payload.title, payload.base64, payload.filePath)
        ElMessage.success(`已打开: ${payload.title}`)
        devLog.info(`打开 PDF 文件: ${payload.filePath || payload.title}`)
        return
      }
      docStore.importDocument(payload.title, payload.content, payload.filePath)
      ElMessage.success(`已打开: ${payload.title}`)
      devLog.info(`打开文件: ${payload.filePath || payload.title}`)
    })
  }

  // 监听滚动，更新当前激活的大纲标题
  editorWrapperRef.value?.addEventListener('scroll', () => {
    if (!editorWrapperRef.value || outline.value.length === 0) return

    const headings = outline.value.map(item => document.getElementById(item.id)).filter(Boolean) as HTMLElement[]
    const scrollTop = editorWrapperRef.value.scrollTop
    let activeId = outline.value[0].id

    for (const heading of headings) {
      if (heading.offsetTop - 80 <= scrollTop) {
        activeId = heading.id
      }
    }

    activeHeading.value = activeId
  })
}

// 处理编辑器动作
function handleEditorAction(action: string) {
  editorRef.value?.insertFormat(action)
}

// 右键菜单的全局动作（查找替换 / 源码模式）
function handleContextAction(action: string) {
  if (action === 'search') {
    searchVisible.value = true
  } else if (action === 'sourceMode') {
    docStore.toggleSourceMode()
  }
}

// 大纲更新
function handleOutlineUpdate(newOutline: OutlineItem[]) {
  outline.value = newOutline
}

// 统计更新
function handleStatsUpdate(newStats: { characters: number; words: number; lines: number }) {
  stats.value = newStats
}

// 导出处理
async function handleExport(type: string) {
  // 文件菜单的非导出命令（偏好设置 / 开发者模式）不依赖当前文档，先于文档守卫处理
  if (type === 'preference-settings') {
    prefVisible.value = true
    return
  }
  if (type === 'dev-mode') {
    devVisible.value = true
    return
  }
  const doc = docStore.activeDocument
  if (!doc) return
  // PDF 只读预览不支持导出
  if (doc.kind === 'pdf') {
    ElMessage.info('PDF 阅读模式不支持导出')
    return
  }
  // 先同步最新编辑内容，确保导出的是最新
  editorRef.value?.flushSync?.()
  // 退出代码块编辑态并恢复语法高亮，避免导出裸文本/编辑态边框
  editorRef.value?.normalizeCodeBlocks?.()
  const current = docStore.activeDocument
  if (!current) return
  const filename = current.title || 'document'
  const editorElement = editorRef.value?.getEditorElement()

  let ok = false
  try {
    switch (type) {
      case 'md':
        ok = await exportMarkdown(current.content, filename)
        break
      case 'cloud': {
        const r = await cloudSave(current.content, filename)
        if (r.ok) {
          ElMessage.success({ message: `已保存到服务器：${r.path}`, duration: 2500 })
          devLog.info(`云端保存成功: ${r.path}`)
        } else {
          ElMessage.error(`云端保存失败: ${r.error || '未知错误'}`)
          devLog.error(`云端保存失败: ${r.error}`)
        }
        return
      }
      case 'cloudFiles':
        cloudVisible.value = true
        return
      case 'backupFiles':
        backupVisible.value = true
        return
      case 'html':
        ok = await exportHTML(editorElement?.innerHTML || '', filename, docStore.currentTheme)
        break
      case 'pdf':
        if (editorElement) ok = await exportPDF(editorElement, filename)
        break
      case 'image':
        if (editorElement) ok = await exportImage(editorElement, filename)
        break
    }
  } catch (e: any) {
    ElMessage.error(`导出失败: ${e?.message || e}`)
    devLog.error(`导出 ${type} 失败: ${e?.message || e}`)
    return
  }
  if (ok) {
    ElMessage.success('导出成功')
    devLog.info(`导出 ${type} 成功`)
  } else {
    ElMessage.info('已取消导出')
  }
}

// 替换处理：SearchPanel 已直接修改编辑区 DOM/textarea 并 unwrap 搜索高亮，
// 这里只需把当前内容同步回 store 并重新渲染（forceRender 从 store 重建干净 DOM，避免高亮标记残留）
function handleReplace() {
  // 先同步最新编辑内容，确保基于最新内容
  editorRef.value?.flushSync?.()
  // 退出代码块编辑态并恢复语法高亮，避免替换后裸文本/编辑态边框
  editorRef.value?.normalizeCodeBlocks?.()
  editorRef.value?.forceRender?.()
}
</script>

<style lang="scss" scoped>
.app-container {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
}

.main-content {
  flex: 1;
  display: flex;
  overflow: hidden;
}

// 编辑列：文本区 + 底部功能区（Typora 式，功能区不横贯侧边栏）
.editor-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.editor-wrapper {
  flex: 1;
  position: relative;
  overflow-y: auto;
  overflow-x: hidden;
}

/* 偏好设置对话框：冷淡单色、发丝线、方角（与整体设计语言一致） */
.hypora-pref-dialog {
  --el-dialog-border-radius: 2px;
}
.pref-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}
.pref-label {
  flex: 0 0 60px;
  font-size: 12px;
  color: var(--text-secondary);
}
.pref-slider {
  flex: 1;
}
.pref-value {
  flex: 0 0 36px;
  text-align: right;
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.pref-select {
  flex: 1;
}
.pref-hint {
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-muted);
  border-top: 1px solid var(--border-color);
  padding-top: 10px;
}
</style>