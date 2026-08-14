<template>
  <div v-if="visible" class="search-panel">
    <div class="search-box">
      <div class="search-input-group">
        <el-input
          ref="searchInputRef"
          v-model="searchText"
          placeholder="查找"
          size="small"
          @input="onQueryInput"
          @keydown.enter="findNext"
          clearable
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
        <el-input
          v-model="replaceText"
          placeholder="替换"
          size="small"
          @keydown.enter="doReplace"
          clearable
        >
          <template #prefix>
            <el-icon><Switch /></el-icon>
          </template>
        </el-input>
      </div>

      <div class="search-actions">
        <span class="result-count">{{ matchCount ? currentMatch + 1 : 0 }} / {{ matchCount }}</span>
        <el-tooltip content="上一个" placement="bottom">
          <el-button text size="small" @click="findPrev">
            <el-icon><ArrowUp /></el-icon>
          </el-button>
        </el-tooltip>
        <el-tooltip content="下一个" placement="bottom">
          <el-button text size="small" @click="findNext">
            <el-icon><ArrowDown /></el-icon>
          </el-button>
        </el-tooltip>
        <el-button size="small" :disabled="!matchCount" @click="doReplace">替换</el-button>
        <el-button size="small" type="primary" :disabled="!matchCount" @click="replaceAll">全部替换</el-button>
        <el-tooltip content="关闭" placement="bottom">
          <el-button text size="small" @click="close">
            <el-icon><Close /></el-icon>
          </el-button>
        </el-tooltip>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onBeforeUnmount } from 'vue'
import { Search, Switch, ArrowUp, ArrowDown, Close } from '@element-plus/icons-vue'

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'replace'): void
}>()

const searchInputRef = ref()
const searchText = ref('')
const replaceText = ref('')
const matchCount = ref(0)
const currentMatch = ref(0)

// 当前匹配的 DOM 元素（WYSIWYG 模式）
let hits: HTMLElement[] = []
let suppressScroll = false // 输入查询时不高亮滚动，避免抢焦点/跳动

// 获取当前编辑元素：所见即所得为 .markdown-body，源码模式为 .source-editor textarea
function getEditorEl(): HTMLElement | null {
  return document.querySelector('.markdown-body')
}
function getSourceTa(): HTMLTextAreaElement | null {
  return document.querySelector('.source-editor')
}

// 清除全部搜索高亮标记（unwrap，不残留标记污染 markdown 往返）
function clearHits() {
  hits = []
  document.querySelectorAll('.search-hit').forEach(el => {
    el.replaceWith(...el.childNodes)
  })
}

// 文本节点内查找并包裹匹配为 <span class="search-hit">
// 仅处理单个文本节点内的匹配；跨元素边界的匹配（如一半在 <strong> 内）暂不支持（简单查找可接受）
function wrapMatchesInTextNode(node: Text, qLower: string): boolean {
  const text = node.textContent || ''
  if (!text) return false
  const lower = text.toLowerCase()
  const ranges: [number, number][] = []
  let pos = 0
  while (true) {
    const i = lower.indexOf(qLower, pos)
    if (i === -1) break
    ranges.push([i, i + qLower.length])
    pos = i + qLower.length
  }
  if (ranges.length === 0) return false
  const frag = document.createDocumentFragment()
  let cursor = 0
  for (const [s, e] of ranges) {
    if (s > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, s)))
    const mark = document.createElement('span')
    mark.className = 'search-hit'
    mark.textContent = text.slice(s, e)
    frag.appendChild(mark)
    hits.push(mark)
    cursor = e
  }
  if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)))
  node.replaceWith(frag)
  return true
}

// 在渲染 DOM 中查找：遍历文本节点（跳过代码块/公式/图表/目录/脚注等非正文渲染区），包裹匹配
function highlightInDom(q: string) {
  const editor = getEditorEl()
  if (!editor) return
  const qLower = q.toLowerCase()
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Text) {
      const parent = node.parentElement
      if (parent && parent.closest('.code-block-wrapper, .math-block, .mermaid, .toc, .toc-empty, .footnotes')) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    }
  })
  const nodes: Text[] = []
  let n: Node | null
  while ((n = walker.nextNode())) nodes.push(n as Text)
  for (const node of nodes) wrapMatchesInTextNode(node, qLower)
}

// 定位到第 i 个匹配：更新高亮样式 + 滚动到可视区（不抢输入框焦点）
function goToMatch(i: number, scroll: boolean) {
  const count = hits.length
  if (count === 0) return
  currentMatch.value = ((i % count) + count) % count
  hits.forEach((h, idx) => h.classList.toggle('current', idx === currentMatch.value))
  if (scroll && hits[currentMatch.value]) {
    hits[currentMatch.value].scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
}

function doSearch(scroll = false) {
  clearHits()
  const q = searchText.value.trim()
  const ta = getSourceTa()
  if (ta) {
    // 源码模式：计数，光标定位用 textarea 选区（面板打开时定位但不抢输入框焦点）
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = ta.value.match(new RegExp(escaped, 'gi'))
    matchCount.value = m ? m.length : 0
    currentMatch.value = 0
    if (scroll) selectInSource(0, false)
    return
  }
  if (!q) { matchCount.value = 0; currentMatch.value = 0; return }
  highlightInDom(q)
  matchCount.value = hits.length
  if (hits.length > 0) {
    goToMatch(suppressScroll ? currentMatch.value : 0, scroll)
  }
}

function findNext() {
  const ta = getSourceTa()
  if (ta) {
    selectInSource(1, true)
    return
  }
  if (hits.length === 0) return
  goToMatch(currentMatch.value + 1, true)
}

function findPrev() {
  const ta = getSourceTa()
  if (ta) {
    selectInSource(-1, true)
    return
  }
  if (hits.length === 0) return
  goToMatch(currentMatch.value - 1, true)
}

// 源码模式：在 textarea 中定位到下一个/上一个匹配（focus=false 时仅定位不抢输入框焦点；dir 可为 0 定位当前）
function selectInSource(dir: number, focus = true) {
  const ta = getSourceTa()
  const q = searchText.value.trim()
  if (!ta || !q) return
  const val = ta.value
  const qLower = q.toLowerCase()
  const valLower = val.toLowerCase()
  const positions: number[] = []
  let pos = 0
  while (true) {
    const i = valLower.indexOf(qLower, pos)
    if (i === -1) break
    positions.push(i)
    pos = i + q.length
  }
  if (positions.length === 0) { matchCount.value = 0; currentMatch.value = 0; return }
  matchCount.value = positions.length
  currentMatch.value = (currentMatch.value + dir + positions.length) % positions.length
  const at = positions[currentMatch.value]
  if (focus) ta.focus()
  ta.setSelectionRange(at, at + q.length)
  // textarea 内部滚动到选区所在行（浏览器对 setSelectionRange 的自动滚动通常已足够，这里兜底居中）
  const line = val.slice(0, at).split('\n').length - 1
  const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 20
  ta.scrollTop = Math.max(0, line * lineHeight - ta.clientHeight / 2)
}

// 查询输入：高亮但不自动滚动（避免边打字边跳动）
function onQueryInput() {
  suppressScroll = true
  doSearch(false)
}

function doReplace() {
  const ta = getSourceTa()
  if (ta) {
    replaceInSource(false)
    return
  }
  if (!searchText.value.trim() || hits.length === 0) return
  const hit = hits[currentMatch.value]
  if (!hit) return
  hit.textContent = replaceText.value
  clearHits()
  emit('replace')
  nextTick(() => { suppressScroll = false; doSearch(true) })
}

function replaceAll() {
  const ta = getSourceTa()
  if (ta) {
    replaceInSource(true)
    return
  }
  if (!searchText.value.trim() || hits.length === 0) return
  for (const h of hits) h.textContent = replaceText.value
  clearHits()
  emit('replace')
  nextTick(() => { suppressScroll = false; doSearch(true) })
}

// 源码模式替换：直接改 textarea 值并派发 input 让 store 同步
function replaceInSource(all: boolean) {
  const ta = getSourceTa()
  const q = searchText.value.trim()
  if (!ta || !q) return
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let val = ta.value
  if (all) {
    if (!new RegExp(escaped, 'i').test(val)) return
    val = val.replace(new RegExp(escaped, 'gi'), replaceText.value)
  } else {
    const idx = val.toLowerCase().indexOf(q.toLowerCase())
    if (idx === -1) return
    val = val.slice(0, idx) + replaceText.value + val.slice(idx + q.length)
  }
  ta.value = val
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  suppressScroll = false
  doSearch(true)
}

function close() {
  clearHits()
  emit('close')
}

// 用户手动编辑编辑区时清除高亮，避免 <span class="search-hit"> 残留视觉。
// 程序化的替换/重渲染不触发 input 事件，因此不会打断 replace → emit → 重新搜索 的流程。
let editorInputHandler: ((e: Event) => void) | null = null

// 关闭面板时清理
watch(() => props.visible, (visible) => {
  if (visible) {
    suppressScroll = false
    nextTick(() => {
      searchInputRef.value?.focus()
      searchText.value = window.getSelection()?.toString() || ''
      doSearch(true)
    })
    if (!editorInputHandler) {
      editorInputHandler = () => { clearHits(); matchCount.value = 0; currentMatch.value = 0 }
    }
    getEditorEl()?.addEventListener('input', editorInputHandler)
  } else {
    clearHits()
    if (editorInputHandler) {
      getEditorEl()?.removeEventListener('input', editorInputHandler)
      editorInputHandler = null
    }
  }
})

onBeforeUnmount(() => {
  clearHits()
  if (editorInputHandler) {
    getEditorEl()?.removeEventListener('input', editorInputHandler)
    editorInputHandler = null
  }
})
</script>

<style lang="scss" scoped>
.search-panel {
  position: fixed;
  top: 60px;
  right: 20px;
  z-index: 1000;

  .search-box {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 2px;
    box-shadow: var(--shadow);
    padding: 12px;
    min-width: 400px;

    .search-input-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 12px;
    }

    .search-actions {
      display: flex;
      align-items: center;
      gap: 8px;

      .result-count {
        font-size: 12px;
        color: var(--text-muted);
        margin-right: auto;
      }
    }
  }
}
</style>

<!-- 编辑器 DOM 内的高亮样式（scoped 无法作用到组件外元素，需全局） -->
<style lang="scss">
.search-hit {
  background: var(--highlight-bg);
  color: inherit;
  border-radius: 1px;
}
.search-hit.current {
  background: var(--text-primary);
  color: var(--bg-primary);
}
</style>
