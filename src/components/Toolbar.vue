<template>
  <div class="toolbar" :class="{ 'is-fullscreen': docStore.isFullscreen, 'toolbar-hidden': docStore.isFullscreen && !toolbarHover }" @mouseenter="toolbarHover = true" @mouseleave="toolbarHover = false" @mousedown.prevent>
    <div class="toolbar-left">
      <TrafficLights />
      <!-- 文件操作 -->
      <el-dropdown trigger="click" @command="handleFileCommand">
        <el-button text class="toolbar-btn">
          <el-icon><Document /></el-icon>
          <span>文件</span>
          <el-icon class="el-icon--right"><ArrowDown /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="new"><el-icon><DocumentAdd /></el-icon> 新建文档</el-dropdown-item>
            <el-dropdown-item command="open"><el-icon><FolderOpened /></el-icon> 打开本地文件</el-dropdown-item>
            <el-dropdown-item command="save" divided><el-icon><Download /></el-icon> 保存为MD</el-dropdown-item>
            <el-dropdown-item command="exportHtml"><el-icon><DocumentCopy /></el-icon> 导出HTML</el-dropdown-item>
            <el-dropdown-item command="exportPdf"><el-icon><Files /></el-icon> 导出PDF</el-dropdown-item>
            <el-dropdown-item command="exportImage"><el-icon><Picture /></el-icon> 导出图片</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <el-divider direction="vertical" />

      <!-- 标题选择 -->
      <el-dropdown trigger="click" @command="handleHeading">
        <el-button text class="toolbar-btn">
          <el-icon><Postcard /></el-icon>
          <span>标题</span>
          <el-icon class="el-icon--right"><ArrowDown /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="h1"><span class="heading-preview h1">H1 标题1</span></el-dropdown-item>
            <el-dropdown-item command="h2"><span class="heading-preview h2">H2 标题2</span></el-dropdown-item>
            <el-dropdown-item command="h3"><span class="heading-preview h3">H3 标题3</span></el-dropdown-item>
            <el-dropdown-item command="h4"><span class="heading-preview h4">H4 标题4</span></el-dropdown-item>
            <el-dropdown-item command="p">正文</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <!-- 文字样式 -->
      <el-tooltip content="粗体 (Ctrl+B)" placement="bottom">
        <el-button text class="toolbar-btn format-btn" @click="triggerAction('bold')">
          <span class="bold">B</span>
        </el-button>
      </el-tooltip>

      <el-tooltip content="斜体 (Ctrl+I)" placement="bottom">
        <el-button text class="toolbar-btn format-btn" @click="triggerAction('italic')">
          <span class="italic">I</span>
        </el-button>
      </el-tooltip>

      <el-tooltip content="下划线 (Ctrl+U)" placement="bottom">
        <el-button text class="toolbar-btn format-btn" @click="triggerAction('underline')">
          <span class="underline">U</span>
        </el-button>
      </el-tooltip>

      <el-tooltip content="删除线 (Alt+Shift+5)" placement="bottom">
        <el-button text class="toolbar-btn format-btn" @click="triggerAction('strikethrough')">
          <span class="strikethrough">S</span>
        </el-button>
      </el-tooltip>

      <el-tooltip content="高亮 (Ctrl+Shift+H)" placement="bottom">
        <el-button text class="toolbar-btn format-btn" @click="triggerAction('highlight')">
          <span class="highlight">H</span>
        </el-button>
      </el-tooltip>

      <el-divider direction="vertical" />

      <!-- 代码 -->
      <el-tooltip content="行内代码 (Ctrl+`)" placement="bottom">
        <el-button text class="toolbar-btn" @click="triggerAction('code')">
          <el-icon><MagicStick /></el-icon>
        </el-button>
      </el-tooltip>

      <el-tooltip content="代码块 (Ctrl+Shift+K)" placement="bottom">
        <el-button text class="toolbar-btn" @click="triggerAction('codeBlock')">
          <el-icon><DocumentCopy /></el-icon>
        </el-button>
      </el-tooltip>

      <el-tooltip content="表格 (Ctrl+Shift+T)" placement="bottom">
        <el-button text class="toolbar-btn" @click="triggerAction('table')">
          <el-icon><Grid /></el-icon>
        </el-button>
      </el-tooltip>

      <el-tooltip content="引用 (Ctrl+Shift+Q)" placement="bottom">
        <el-button text class="toolbar-btn" @click="triggerAction('quote')">
          <el-icon><ChatDotSquare /></el-icon>
        </el-button>
      </el-tooltip>

      <el-divider direction="vertical" />

      <!-- 列表 -->
      <el-tooltip content="无序列表 (Ctrl+Shift+U)" placement="bottom">
        <el-button text class="toolbar-btn" @click="triggerAction('ul')">
          <el-icon><List /></el-icon>
        </el-button>
      </el-tooltip>

      <el-tooltip content="有序列表 (Ctrl+Shift+O)" placement="bottom">
        <el-button text class="toolbar-btn" @click="triggerAction('ol')">
          <span style="font-weight: bold; font-size: 14px;">1.</span>
        </el-button>
      </el-tooltip>

      <el-tooltip content="任务列表 (Ctrl+Shift+X)" placement="bottom">
        <el-button text class="toolbar-btn" @click="triggerAction('task')">
          <el-icon><Select /></el-icon>
        </el-button>
      </el-tooltip>

      <el-divider direction="vertical" />

      <!-- 插入内容 -->
      <el-tooltip content="链接 (Ctrl+K)" placement="bottom">
        <el-button text class="toolbar-btn" @click="triggerAction('link')">
          <el-icon><Link /></el-icon>
        </el-button>
      </el-tooltip>

      <el-tooltip content="图片 (Ctrl+Shift+I)" placement="bottom">
        <el-button text class="toolbar-btn" @click="triggerAction('image')">
          <el-icon><Picture /></el-icon>
        </el-button>
      </el-tooltip>

      <el-tooltip content="分割线 (Ctrl+Shift+-)" placement="bottom">
        <el-button text class="toolbar-btn" @click="triggerAction('hr')">
          <el-icon><Minus /></el-icon>
        </el-button>
      </el-tooltip>
    </div>

    <div class="toolbar-right">
      <!-- 窗口置顶 -->
      <el-tooltip content="窗口置顶 (Ctrl+Shift+A)" placement="bottom">
        <el-button text class="toolbar-btn" :class="{ 'is-active': isAlwaysOnTop }" @click="toggleAlwaysOnTop">
          <span class="pin-icon">📌</span>
        </el-button>
      </el-tooltip>

      <!-- 搜索 -->
      <el-tooltip content="搜索替换 (Ctrl+F)" placement="bottom">
        <el-button text class="toolbar-btn" @click="emit('toggleSearch')">
          <el-icon><Search /></el-icon>
        </el-button>
      </el-tooltip>

      <!-- AI 助手 -->
      <el-tooltip content="AI 助手 (Ctrl+J)" placement="bottom">
        <el-button text class="toolbar-btn ai-btn" :class="{ 'is-active': aiStore.panelVisible }" @click="aiStore.togglePanel()">
          <LottieLoading :animation="assistantAnim" size="icon" />
        </el-button>
      </el-tooltip>

      <!-- 图片转 Base64 -->
      <el-tooltip content="图片转 Base64" placement="bottom">
        <el-button text class="toolbar-btn" @click="ib64Visible = true">
          <el-icon><PictureFilled /></el-icon>
        </el-button>
      </el-tooltip>

      <!-- 主题切换 -->
      <el-dropdown trigger="click" @command="handleThemeChange">
        <el-button text class="toolbar-btn">
          <el-icon><Sunny v-if="docStore.currentTheme === 'light'" /><Moon v-else-if="docStore.currentTheme === 'dark'" /><Coffee v-else-if="docStore.currentTheme === 'beige'" /><Pouring v-else-if="docStore.currentTheme === 'ice'" /><Brush v-else /></el-icon>
          <span>主题</span>
          <el-icon class="el-icon--right"><ArrowDown /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="light"><el-icon><Sunny /></el-icon> 浅色白</el-dropdown-item>
            <el-dropdown-item command="dark"><el-icon><Moon /></el-icon> 暗色黑</el-dropdown-item>
            <el-dropdown-item command="beige"><el-icon><Coffee /></el-icon> 米色护眼</el-dropdown-item>
            <el-dropdown-item command="gray"><el-icon><Brush /></el-icon> 极简灰</el-dropdown-item>
            <el-dropdown-item command="ice"><el-icon><Pouring /></el-icon> 冰雪</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <el-divider direction="vertical" />

      <!-- 视图切换 -->
      <el-tooltip content="侧边栏" placement="bottom">
        <el-button text class="toolbar-btn" :class="{ 'is-active': docStore.sidebarVisible }" @click="docStore.toggleSidebar()">
          <el-icon><Menu /></el-icon>
        </el-button>
      </el-tooltip>

      <el-tooltip content="源码模式 (Ctrl+/)" placement="bottom">
        <el-button text class="toolbar-btn" :class="{ 'is-active': docStore.isSourceMode }" @click="docStore.toggleSourceMode()">
          <el-icon><EditPen /></el-icon>
        </el-button>
      </el-tooltip>

      <el-tooltip content="全屏 (F11)" placement="bottom">
        <el-button text class="toolbar-btn" :class="{ 'is-active': docStore.isFullscreen }" @click="docStore.toggleFullscreen()">
          <el-icon><FullScreen /></el-icon>
        </el-button>
      </el-tooltip>
    </div>

    <!-- 隐藏的文件输入 -->
    <input ref="fileInputRef" type="file" accept=".md" hidden @change="handleOpenFile">

    <!-- 图片转 Base64 对话框 -->
    <ImageBase64 v-model="ib64Visible" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useAIStore } from '@/stores/ai'
import {
  Document, ArrowDown, DocumentAdd, FolderOpened, Download, DocumentCopy, Files, Picture, PictureFilled,
  Postcard, MagicStick, Grid, ChatDotSquare, List, Select, Link, Minus,
  Search, Sunny, Moon, Coffee, Brush, Pouring, Menu, FullScreen, EditPen
} from '@element-plus/icons-vue'
import { readMdFile } from '@/utils/export'
import TrafficLights from './TrafficLights.vue'
import ImageBase64 from './ImageBase64.vue'
import LottieLoading from './LottieLoading.vue'
import assistantAnim from '@/assets/ai-assistant.json'
import { ElMessage } from 'element-plus'

const emit = defineEmits<{
  (e: 'action', action: string): void
  (e: 'export', type: string): void
  (e: 'toggleSearch'): void
}>()

const docStore = useDocumentStore()
const aiStore = useAIStore()
const fileInputRef = ref<HTMLInputElement>()
const toolbarHover = ref(true)
const isAlwaysOnTop = ref(false)
const ib64Visible = ref(false)

onMounted(async () => {
  isAlwaysOnTop.value = !!(await (window as any).electronAPI?.winIsAlwaysOnTop?.())
  ;(window as any).electronAPI?.onAlwaysOnTopChange?.((v: boolean) => {
    isAlwaysOnTop.value = v
  })
})

async function toggleAlwaysOnTop() {
  const api = (window as any).electronAPI
  if (!api?.winToggleAlwaysOnTop) {
    ElMessage.warning({ message: '窗口置顶仅在桌面客户端可用', duration: 1500 })
    return
  }
  const isOn = await api.winToggleAlwaysOnTop()
  ElMessage.success({ message: isOn ? '窗口已置顶' : '已取消置顶', duration: 1500 })
}

function triggerAction(action: string) {
  emit('action', action)
}

function handleHeading(level: string) {
  emit('action', level)
}

function handleThemeChange(theme: string) {
  docStore.setTheme(theme)
}

function handleFileCommand(command: string) {
  switch (command) {
    case 'new':
      docStore.newDocument()
      break
    case 'open':
      // Electron 环境走原生对话框（可获取完整路径，支持 Ctrl+S 写回原文件）
      if (window.electronAPI?.openFileDialog) {
        window.electronAPI.openFileDialog()
      } else {
        fileInputRef.value?.click()
      }
      break
    case 'save':
      emit('export', 'md')
      break
    case 'exportHtml':
      emit('export', 'html')
      break
    case 'exportPdf':
      emit('export', 'pdf')
      break
    case 'exportImage':
      emit('export', 'image')
      break
  }
}

async function handleOpenFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (file) {
    const { title, content } = await readMdFile(file)
    docStore.importDocument(title, content)
  }
  if (fileInputRef.value) {
    fileInputRef.value.value = ''
  }
}
</script>

<style lang="scss" scoped>
.toolbar {
  height: 48px;
  background: var(--toolbar-bg);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  position: sticky;
  top: 0;
  z-index: 100;
  transition: transform 0.3s ease, opacity 0.3s ease;
  box-shadow: var(--shadow);
  -webkit-app-region: drag;

  &.is-fullscreen {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 100;
  }

  &.toolbar-hidden {
    transform: translateY(-100%);
    opacity: 0;

    &:hover {
      transform: translateY(0);
      opacity: 1;
    }
  }

  .toolbar-left, .toolbar-right {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  /* frameless：交互元素不参与窗口拖动 */
  :deep(.el-button),
  :deep(.el-input__inner),
  :deep(.el-textarea__inner),
  :deep(.el-select__wrapper),
  :deep(.el-select__caret),
  :deep(.el-switch),
  :deep(.el-dropdown) {
    -webkit-app-region: no-drag;
  }

  .toolbar-btn {
    color: var(--text-secondary);
    padding: 6px 10px;
    border-radius: 2px;
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 14px;
    transition: all 0.2s;

    &:hover {
      background: var(--bg-secondary);
      color: var(--text-primary);
    }

    &.is-active {
      color: var(--accent-color);
      background: var(--bg-secondary);
    }
  }
  .pin-icon {
    font-size: 15px;
    line-height: 1;
    display: inline-block;
  }

  .format-btn span {
    font-size: 14px;
    font-weight: 500;

    &.bold { font-weight: 700; }
    &.italic { font-style: italic; }
    &.underline { text-decoration: underline; }
    &.strikethrough { text-decoration: line-through; }
    &.highlight { background: var(--highlight-bg); padding: 0 2px; border-radius: 1px; }
  }

  .heading-preview {
    font-family: var(--font-serif);
    font-weight: 500;
    &.h1 { font-size: 20px; }
    &.h2 { font-size: 18px; }
    &.h3 { font-size: 16px; }
    &.h4 { font-size: 15px; }
  }
}
</style>