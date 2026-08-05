<template>
  <div class="toolbar">
    <div class="toolbar-group">
      <button class="t-btn" title="打开（Ctrl+O）" @click="open">📂 打开</button>
      <button class="t-btn" title="保存（Ctrl+S）" @click="save">💾 保存</button>
      <button class="t-btn" title="另存为" @click="saveAs">另存为</button>
    </div>

    <div class="toolbar-divider"></div>

    <div class="toolbar-group">
      <button class="t-btn icon" :class="{ on: viewMode === 'edit' }" title="编辑视图" @click="setView('edit')">✏️</button>
      <button class="t-btn icon" :class="{ on: viewMode === 'split' }" title="分栏" @click="setView('split')">🪟</button>
      <button class="t-btn icon" :class="{ on: viewMode === 'preview' }" title="预览" @click="setView('preview')">👁️</button>
    </div>

    <div class="toolbar-divider"></div>

    <div class="toolbar-group fmt">
      <button class="t-btn icon" :class="{ on: selBold }" title="加粗（Ctrl+B）" @mousedown.prevent="fmt('bold')"><b>B</b></button>
      <button class="t-btn icon" :class="{ on: selItalic }" title="斜体（Ctrl+I）" @mousedown.prevent="fmt('italic')"><i>I</i></button>
      <button class="t-btn icon" title="删除线" @mousedown.prevent="fmt('strikeThrough')"><s>S</s></button>
      <button class="t-btn icon" title="行内代码" @mousedown.prevent="fmtCode">⟨⟩</button>
      <button class="t-btn icon" title="链接" @mousedown.prevent="insertLink">🔗</button>
    </div>

    <div class="toolbar-divider"></div>

    <div class="toolbar-group">
      <button class="t-btn" title="标题 1" @click="insertHeading(1)">H1</button>
      <button class="t-btn" title="标题 2" @click="insertHeading(2)">H2</button>
      <button class="t-btn" title="标题 3" @click="insertHeading(3)">H3</button>
      <button class="t-btn" title="引用" @click="convert('quote')">❝</button>
    </div>

    <div class="toolbar-group">
      <button class="t-btn" title="无序列表" @click="convert('ul')">•列表</button>
      <button class="t-btn" title="有序列表" @click="convert('ol')">1.列表</button>
      <button class="t-btn" title="任务列表" @click="convert('task')">☑任务</button>
      <button class="t-btn" title="代码块" @click="convert('code')">&lt;/&gt;</button>
    </div>

    <div class="toolbar-divider"></div>

    <div class="toolbar-group">
      <button class="t-btn" title="插入图片" @click="insertImage">🖼️ 图片</button>
      <button class="t-btn" title="Mermaid 图" @click="insertMermaid">◇ Mermaid</button>
      <button class="t-btn" title="表格" @click="insertTable">▦ 表格</button>
      <button class="t-btn" title="分隔线" @click="insertHr">——</button>
    </div>

    <div class="toolbar-spacer"></div>

    <div class="toolbar-group">
      <button class="t-btn" title="查找（Ctrl+F）" :class="{ on: searchOpen }" @click="toggleSearch">🔍</button>
      <button class="t-btn" :class="{ on: aiOpen }" title="AI 助手（Ctrl+J）" @click="toggleAI">✦ AI</button>
      <button class="t-btn" title="导出" @click="exportMenuOpen = !exportMenuOpen">
        导出 ▾
        <div v-if="exportMenuOpen" class="menu" @click.stop>
          <button @click="doExport('md')">导出 Markdown</button>
          <button @click="doExport('html')">导出 HTML</button>
          <button @click="doExport('pdf')">导出 PDF</button>
          <button @click="doExport('svg')">导出图片（SVG）</button>
        </div>
      </button>
      <button class="t-btn" title="主题" @click="themeMenuOpen = !themeMenuOpen">
        🎨 ▾
        <div v-if="themeMenuOpen" class="menu" @click.stop>
          <button v-for="t in themes" :key="t.id" :class="{ on: theme === t.id }" @click="setTheme(t.id)">{{ t.label }}</button>
        </div>
      </button>
      <button class="t-btn" title="开发者模式" :class="{ on: devMode }" @click="toggleDev">🧪</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useAIStore } from '@/stores/ai'
import { settings, type ThemeName } from '@/utils/tauriAPI'
import { editorState, emitEditorCommand } from '@/utils/editorBus'
import { runExport } from '@/utils/export'
import { isDevMode, toggleDevMode } from '@/utils/devMode'
import { useImageBase64 } from '@/components/imageBase64'
import { toast } from '@/components/toasts'
import { onEditorCommand } from '@/utils/editorBus'
import { genId } from '@/utils/markdown'

const doc = useDocumentStore()
const ai = useAIStore()
const { openImageDialog } = useImageBase64()

const viewMode = ref(editorState.viewMode)
const searchOpen = ref(false)
const aiOpen = ref(true)
const exportMenuOpen = ref(false)
const themeMenuOpen = ref(false)
const theme = ref<ThemeName>(settings.get<ThemeName>('theme', 'system'))
const devMode = ref(isDevMode())

const themes: Array<{ id: ThemeName; label: string }> = [
  { id: 'light', label: '☀ 浅色' },
  { id: 'dark', label: '🌙 深色' },
  { id: 'system', label: '🖥 跟随系统' },
  { id: 'high-contrast-light', label: '☀ 高对比浅色' },
  { id: 'high-contrast-dark', label: '🌙 高对比深色' },
]

/* 选区状态（工具栏高亮） */
const selBold = ref(false)
const selItalic = ref(false)

/* ── 视图 ── */
function setView(mode: 'edit' | 'preview' | 'split') {
  viewMode.value = mode
  editorState.viewMode = mode
}
function toggleSearch() {
  searchOpen.value = !searchOpen.value
  emitEditorCommand('toggle-search', searchOpen.value)
}
function toggleAI() {
  aiOpen.value = !aiOpen.value
  emitEditorCommand('toggle-ai', aiOpen.value)
}

/* ── 文档操作 ── */
async function open() {
  await doc.openViaDialog()
}
async function save() {
  const target = await doc.save()
  toast(target ? `已保存 ${doc.fileName}` : '已取消保存')
}
async function saveAs() {
  const target = await doc.saveAs()
  if (target) toast(`已保存到 ${target}`)
}

/* ── 内联格式（execCommand，作用于当前选区） ── */
function fmt(cmd: string) {
  ensureEditorFocus()
  document.execCommand(cmd)
  updateFmtState()
}
function fmtCode() {
  ensureEditorFocus()
  document.execCommand('formatBlock', false, 'pre')
}
function insertLink() {
  ensureEditorFocus()
  const url = prompt('链接地址：', 'https://')
  if (url) document.execCommand('createLink', false, url)
}

function ensureEditorFocus() {
  const active = document.activeElement as HTMLElement | null
  if (!active?.closest?.('.hypora-block')) {
    emitEditorCommand('focus-last')
  }
}

function updateFmtState() {
  selBold.value = document.queryCommandState('bold')
  selItalic.value = document.queryCommandState('italic')
}
window.addEventListener('selectionchange', updateFmtState)

/* ── 块级操作 ── */
function insertHeading(level: 1 | 2 | 3) {
  emitEditorCommand('convert-block', { type: `h${level}` })
}
function convert(type: string) {
  emitEditorCommand('convert-block', { type })
}
async function insertImage() {
  const dataUrl = await openImageDialog()
  if (dataUrl) emitEditorCommand('insert-image', dataUrl)
}
function insertMermaid() {
  emitEditorCommand('insert-block', { type: 'mermaid', code: 'graph TD\n  A[开始] --> B{判断}\n  B -- 是 --> C[继续]\n  B -- 否 --> D[结束]' })
}
function insertTable() {
  emitEditorCommand('insert-block', { type: 'table', tableMd: '| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n| 示例 | 示例 | 示例 |' })
}
function insertHr() {
  emitEditorCommand('insert-block', { type: 'hr' })
}

/* ── 导出 / 主题 / 开发 ── */
async function doExport(kind: 'md' | 'html' | 'pdf' | 'svg') {
  exportMenuOpen.value = false
  try {
    const target = await runExport(kind, doc.markdown)
    if (target) toast(`已导出：${target}`)
  } catch (err) {
    toast(`导出失败：${String(err)}`, 'error')
  }
}
function setTheme(t: ThemeName) {
  theme.value = t
  settings.set('theme', t)
  document.documentElement.dataset.theme = t
  themeMenuOpen.value = false
}
function toggleDev() {
  devMode.value = toggleDevMode()
  emitEditorCommand('toggle-dev', devMode.value)
}

// 兜底：保持工具栏命令与 editorBus 一致性
onEditorCommand('refresh-fmt', () => updateFmtState())
</script>

<style scoped lang="scss">
.toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  height: var(--hypora-toolbar-h);
  padding: 0 12px;
  background: var(--hypora-bg-elevated);
  border-bottom: 1px solid var(--hypora-border);
  flex-shrink: 0;
  user-select: none;
}

.toolbar-group {
  display: flex;
  align-items: center;
  gap: 2px;
  position: relative;
}

.toolbar-divider {
  width: 1px;
  height: 20px;
  background: var(--hypora-border);
  margin: 0 6px;
}

.toolbar-spacer {
  flex: 1;
}

.t-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 9px;
  border-radius: var(--hypora-radius-sm);
  font-size: 12.5px;
  color: var(--hypora-fg);
  cursor: pointer;
  transition: all var(--hypora-transition-fast);
  white-space: nowrap;

  &:hover {
    background: var(--hypora-bg-hover);
  }
  &.on {
    background: var(--hypora-accent-soft);
    color: var(--hypora-accent);
  }
  &.icon {
    min-width: 28px;
    justify-content: center;
  }
}

.menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 170px;
  background: var(--hypora-bg-elevated);
  border: 1px solid var(--hypora-border);
  border-radius: var(--hypora-radius);
  box-shadow: var(--hypora-shadow);
  padding: 4px;
  z-index: var(--hypora-z-popover);

  button {
    display: block;
    width: 100%;
    text-align: left;
    padding: 7px 12px;
    border-radius: var(--hypora-radius-sm);
    font-size: 12.5px;
    cursor: pointer;

    &:hover {
      background: var(--hypora-bg-hover);
    }
    &.on {
      color: var(--hypora-accent);
    }
  }
}
</style>
