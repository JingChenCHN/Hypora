<template>
  <div v-if="visible" class="search-panel">
    <div class="search-row">
      <input
        ref="inputEl"
        v-model="query"
        class="search-input"
        type="text"
        placeholder="查找（Enter 下一个）"
        @keydown.enter.prevent="next()"
        @keydown.shift.enter.prevent="prev()"
        @input="onInput"
      />
      <span class="match-info">{{ total ? `${current + 1}/${total}` : '0' }}</span>
      <button class="sp-btn" title="上一个" @click="prev()">▲</button>
      <button class="sp-btn" title="下一个" @click="next()">▼</button>
      <button class="sp-btn close" title="关闭（Esc）" @click="close()">✕</button>
    </div>
    <div v-if="query" class="replace-row">
      <input
        v-model="replaceText"
        class="search-input"
        type="text"
        placeholder="替换为"
        @keydown.enter.prevent="replaceCurrent()"
      />
      <button class="sp-btn" @click="replaceCurrent()">替换</button>
      <button class="sp-btn" @click="replaceAll()">全部替换</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { onEditorCommand, emitEditorCommand } from '@/utils/editorBus'
import { parseMarkdown, blockToMarkdown } from '@/utils/markdown'

const doc = useDocumentStore()
const visible = ref(false)
const query = ref('')
const replaceText = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

const matches: Array<{ start: number; end: number }> = []
let current = -1
let total = 0

function searchAll(q: string) {
  matches.length = 0
  total = 0
  current = -1
  const md = doc.markdown.toLowerCase()
  const lower = q.toLowerCase()
  let idx = 0
  while (lower) {
    const pos = md.indexOf(lower, idx)
    if (pos < 0) break
    matches.push({ start: pos, end: pos + lower.length })
    idx = pos + lower.length
  }
  total = matches.length
  return total
}

function mdIndexToBlock(index: number): { blockId: string } | null {
  let cursor = 0
  for (const b of doc.blocks) {
    const md = blockToMarkdown(b)
    if (index < cursor + md.length) return { blockId: b.id }
    cursor += md.length + 2
  }
  return null
}

function onInput() {
  const q = query.value.trim()
  if (!q) {
    total = 0
    current = -1
    return
  }
  if (searchAll(q) > 0) {
    current = 0
    goto(0)
  }
}

function next() {
  if (total === 0) return onInput()
  current = (current + 1) % total
  goto(current)
}
function prev() {
  if (total === 0) return onInput()
  current = (current - 1 + total) % total
  goto(current)
}

function goto(i: number) {
  const m = matches[i]
  if (!m) return
  const target = mdIndexToBlock(m.start)
  if (target) {
    emitEditorCommand('focus-match', { blockId: target.blockId, query: query.value })
  }
}

function replaceCurrent() {
  const m = matches[current]
  if (!m) return
  const newMd = doc.markdown.slice(0, m.start) + replaceText.value + doc.markdown.slice(m.end)
  applyReplaced(newMd)
}

function replaceAll() {
  if (!query.value) return
  const q = query.value
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const newMd = doc.markdown.replace(new RegExp(escaped, 'g'), replaceText.value)
  applyReplaced(newMd)
}

function applyReplaced(newMd: string) {
  doc.applyBlocks(parseMarkdown(newMd))
  onInput()
}

function open() {
  visible.value = true
  void nextTick(() => inputEl.value?.focus())
}
function close() {
  visible.value = false
  query.value = ''
  replaceText.value = ''
  matches.length = 0
  total = 0
  current = -1
  emitEditorCommand('editor-focus')
}

// 快捷键联动
onEditorCommand('toggle-search', () => (visible.value ? close() : open()))
onEditorCommand('open-search', () => open())

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && visible.value) close()
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    open()
  }
})

defineExpose({ close })
</script>

<style scoped lang="scss">
.search-panel {
  position: absolute;
  top: var(--hypora-titlebar-h);
  right: 16px;
  z-index: var(--hypora-z-popover);
  min-width: 380px;
  background: var(--hypora-bg-elevated);
  border: 1px solid var(--hypora-border);
  border-radius: var(--hypora-radius);
  box-shadow: var(--hypora-shadow);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.search-row,
.replace-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.search-input {
  flex: 1;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--hypora-border);
  border-radius: var(--hypora-radius-sm);
  font-size: 12.5px;
  background: var(--hypora-bg);
  color: var(--hypora-fg);
  &:focus {
    border-color: var(--hypora-focus-ring);
  }
}
.match-info {
  font-size: 11.5px;
  color: var(--hypora-fg-subtle);
  min-width: 34px;
  text-align: center;
}
.sp-btn {
  height: 26px;
  padding: 0 9px;
  border-radius: var(--hypora-radius-sm);
  font-size: 12px;
  color: var(--hypora-fg-muted);
  cursor: pointer;
  &:hover {
    background: var(--hypora-bg-hover);
    color: var(--hypora-fg);
  }
  &.close:hover {
    color: var(--hypora-danger);
  }
}
</style>
