<template>
  <div class="app-container">
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

        <Statusbar :stats="stats" @toggle-dev="devVisible = true" />
      </div>
      <AIPanel v-if="aiPanelAlive" :visible="aiStore.panelVisible" :editor="editorRef" />
    </div>

    <DevPanel v-model:visible="devVisible" />
    <CloudFiles :visible="cloudVisible" @close="cloudVisible = false" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onErrorCaptured, defineAsyncComponent } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { copyCode } from '@/utils/markdown'
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
// AI 面板默认隐藏：异步组件 + 首次打开才挂载，把 lottie-web / 动画 JSON 移出首屏启动路径
const AIPanel = defineAsyncComponent(() => import('./components/AIPanel.vue'))
import type { OutlineItem } from '@/utils/markdown'
import { ElMessage } from 'element-plus'
import { useAIStore } from '@/stores/ai'

const docStore = useDocumentStore()
const aiStore = useAIStore()

const editorRef = ref<InstanceType<typeof Editor>>()
const editorWrapperRef = ref<HTMLElement>()
const outline = ref<OutlineItem[]>([])
const activeHeading = ref('')
const stats = ref({ characters: 0, words: 0, lines: 0 })
const searchVisible = ref(false)
const devVisible = ref(false)
const cloudVisible = ref(false)

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
  'ctrl+f': () => { searchVisible.value = !searchVisible.value },
  'ctrl+h': () => { searchVisible.value = true },
  'ctrl+shift+=': () => setZoom(zoomLevel.value + 10),
  'ctrl+shift+-': () => setZoom(zoomLevel.value - 10),
  'ctrl+shift+0': () => setZoom(100),
  'ctrl+shift+t': () => docStore.toggleTypewriter(),
  'ctrl+shift+g': () => docStore.toggleFocus(),
  'ctrl+j': () => aiStore.togglePanel(),
  'ctrl+shift+a': () => toggleAlwaysOnTop()
})

// 保存文档：有源文件路径则写回原文件，否则存本地缓存
async function saveDocument() {
  const doc = docStore.activeDocument
  if (!doc) return
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

  // 无源文件路径（新建文档）或 Web 端：保存到本地缓存
  docStore.saveToLocal()
  ElMessage.success('已保存到本地缓存')
  devLog.info('保存到本地缓存')
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

// 视图缩放（Typora Ctrl+Shift+=/-）
function setZoom(level: number) {
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
        if (doc?.filePath) {
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

    window.electronAPI!.onOpenFile?.(({ title, content, filePath }: { title: string; content: string; filePath?: string }) => {
      docStore.importDocument(title, content, filePath)
      ElMessage.success(`已打开: ${title}`)
      devLog.info(`打开文件: ${filePath || title}`)
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
})

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
  const doc = docStore.activeDocument
  if (!doc) return
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
</style>