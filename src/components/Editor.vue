<template>
  <div class="hypora-editor" @mouseup="scheduleSelectionUpdate" @keyup="scheduleSelectionUpdate">
    <div class="editor-scroll" :class="{ 'is-split': viewMode === 'split' }" @click="onContainerClick">
      <!-- 编辑窗格 -->
      <div v-show="viewMode !== 'preview'" class="editor-pane">
        <div
          v-for="block in doc.blocks"
          :key="block.id"
          class="hypora-block"
          :class="[`is-${block.type}`, { active: block.id === activeBlockId }]"
        >
          <!-- 文本 / 引用 / 标题 / 列表 -->
          <component
            v-if="isTextType(block)"
            :is="rootTag(block)"
            :ref="(el: any) => setEl(block.id, el)"
            class="hypora-text"
            :class="[typeClass(block.type), block.type === 'task' ? 'task-list' : '']"
            :contenteditable="true"
            :data-block="block.id"
            :data-placeholder="placeholderFor(block)"
            v-html-sync="block"
            spellcheck="false"
            @input="onTextInput(block, $event)"
            @focus="onBlockFocus(block)"
            @keydown="onTextKeydown(block, $event)"
          ></component>

          <!-- 代码块 -->
          <div v-else-if="block.type === 'code'" class="hypora-codeblock">
            <div class="code-meta">
              <span class="code-dots"></span>
              <input
                class="code-lang"
                :value="block.lang || ''"
                placeholder="语言（如 ts / python）"
                spellcheck="false"
                @change="setCodeLang(block, $event)"
              />
              <button class="icon-btn danger" title="删除代码块" @click="removeBlock(block)">✕</button>
            </div>
            <pre
              :ref="(el: any) => setEl(block.id, el)"
              class="code-pre"
              :data-block="block.id"
              contenteditable="true"
              spellcheck="false"
              v-text-sync="block"
              @input="onCodeInput(block, $event)"
              @focus="onBlockFocus(block)"
              @keydown="onCodeKeydown(block, $event)"
            ></pre>
          </div>

          <!-- Mermaid 图 -->
          <div v-else-if="block.type === 'mermaid'" class="hypora-mermaid">
            <div class="mermaid-meta">
              <span class="mm-icon">◇</span>
              <span>Mermaid 图</span>
              <button class="mini-btn" @click="editMermaid(block)">编辑源码</button>
              <button class="mini-btn" @click="renderMermaid(block)">重渲染</button>
              <button class="icon-btn danger" @click="removeBlock(block)">✕</button>
            </div>
            <div :ref="(el: any) => setEl(block.id, el)" class="mermaid-render" :data-block="block.id"></div>
          </div>

          <!-- 图片 -->
          <div v-else-if="block.type === 'image'" class="hypora-image">
            <img :src="block.src" :alt="block.alt || ''" draggable="false" />
            <div class="image-meta">
              <span class="img-name">{{ block.alt || 'image' }}</span>
              <button class="mini-btn" @click="replaceImage(block)">替换</button>
              <button class="icon-btn danger" @click="removeBlock(block)">✕</button>
            </div>
          </div>

          <!-- 分隔线 -->
          <div v-else-if="block.type === 'hr'" class="hypora-hr">
            <hr />
            <button class="icon-btn danger" @click="removeBlock(block)">✕</button>
          </div>

          <!-- 表格 -->
          <div v-else-if="block.type === 'table'" class="hypora-table">
            <div class="table-body" v-html="tableHtml(block)"></div>
            <button class="mini-btn" @click="editTable(block)">编辑表格（Markdown）</button>
          </div>
        </div>

        <div v-if="doc.blocks.length === 0" class="empty-hint">空文档 — 点击上方工具栏开始</div>
      </div>

      <!-- 预览窗格 -->
      <div v-show="viewMode === 'preview' || viewMode === 'split'" class="preview-pane" ref="previewEl"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Directive } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { parseMarkdown, markdownToHtml, escapeHtml, genId, type Block, type BlockType } from '@/utils/markdown'
import { editorState, updateSelection, type ViewMode } from '@/utils/editorBus'
import { useAIStore } from '@/stores/ai'
import { useImageBase64 } from '@/components/imageBase64'

/* ───────────── Store ───────────── */
const doc = useDocumentStore()
const ai = useAIStore()

/* ───────────── 视图 / 状态 ───────────── */
const viewMode = computed<ViewMode>(() => editorState.viewMode)
const activeBlockId = ref('')

/* ───────────── 元素引用 ───────────── */
const elMap = new Map<string, HTMLElement>()
const previewEl = ref<HTMLElement | null>(null)
const previewHtml = ref('')
const mmRenderCount = new Map<string, number>()

function setEl(id: string, el: HTMLElement | null) {
  if (el) elMap.set(id, el)
  else elMap.delete(id)
}

function isTextType(b: Block): boolean {
  return ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'quote', 'ul', 'ol', 'task'].includes(b.type)
}

function rootTag(b: Block): string {
  if (b.type === 'ul' || b.type === 'task') return 'ul'
  if (b.type === 'ol') return 'ol'
  return 'div'
}

function typeClass(t: BlockType): string {
  return t === 'p' ? '' : `t-${t}`
}

function placeholderFor(b: Block): string {
  switch (b.type) {
    case 'p':
      return '开始输入…（Ctrl+S 保存 · Ctrl+F 查找 · AI 面板在右侧）'
    case 'quote':
      return '引用文字…'
    default:
      return ''
  }
}

/* ───────────── v-html-sync / v-text-sync（保光标重渲染，§6.1） ───────────── */
const vHtmlSync: Directive<HTMLElement, Block> = {
  mounted(el, binding) {
    const html = binding.value.html ?? ''
    if (el.innerHTML !== html) el.innerHTML = html
  },
  updated(el, binding) {
    if (el.contains(document.activeElement)) return
    const html = binding.value.html ?? ''
    if (el.innerHTML !== html) el.innerHTML = html
  },
}

const vTextSync: Directive<HTMLElement, Block> = {
  mounted(el, binding) {
    const t = binding.value.code ?? ''
    if (el.textContent !== t) el.textContent = t
  },
  updated(el, binding) {
    if (el.contains(document.activeElement)) return
    const t = binding.value.code ?? ''
    if (el.textContent !== t) el.textContent = t
  },
}

/* ───────────── 输入处理（§6.1 编辑管线） ───────────── */
let dirtyTimer = 0 as ReturnType<typeof setTimeout>

function markDirty() {
  clearTimeout(dirtyTimer)
  dirtyTimer = setTimeout(() => doc.onBlocksChanged(doc.blocks), 300)
}

function onTextInput(block: Block, e: Event) {
  const el = e.currentTarget as HTMLElement
  block.html = el.innerHTML
  // 块拆分：Enter 在 div 内产生多个块级子元素 → 拆分为新块
  if (['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(block.type)) {
    const children = Array.from(el.children).filter((c) => /^(DIV|P|UL|OL|BLOCKQUOTE|PRE)$/.test(c.tagName))
    if (children.length > 1) {
      splitBlock(block, children)
      return
    }
  }
  markDirty()
}

function splitBlock(block: Block, children: Element[]) {
  // 定位光标所在子元素
  const sel = window.getSelection()
  let targetIdx = children.length - 1
  if (sel && sel.rangeCount) {
    const node = sel.getRangeAt(0).startContainer as Node
    const child = findContainingChild(node, children)
    if (child) targetIdx = children.indexOf(child)
  }
  const firstType = block.type
  const newBlocks: Block[] = children.map((c, i) => ({
    id: genId(),
    type: i === 0 ? firstType : 'p',
    html: c.innerHTML,
  }))
  const idx = doc.blocks.indexOf(block)
  doc.blocks.splice(idx, 1, ...newBlocks)
  doc.applyBlocks(doc.blocks)
  const target = newBlocks[targetIdx]
  void nextTick(() => focusBlock(target.id, true))
}

function onCodeInput(block: Block, e: Event) {
  const el = e.currentTarget as HTMLElement
  block.code = getPreText(el)
  markDirty()
}

function onCodeKeydown(block: Block, e: KeyboardEvent) {
  if (e.key === 'Tab') {
    e.preventDefault()
    document.execCommand('insertText', false, '  ')
  }
}

function getPreText(el: HTMLElement): string {
  // innerText 优先（保留 br/div 换行），降级手工转换
  const it = (el as { innerText?: string }).innerText
  if (typeof it === 'string') return it.replace(/ /g, ' ')
  const clone = el.cloneNode(true) as HTMLElement
  clone.querySelectorAll('br').forEach((br) => br.replaceWith(document.createTextNode('\n')))
  clone.querySelectorAll('div, p').forEach((d) => d.replaceWith(document.createTextNode('\n')))
  return (clone.textContent ?? '').replace(/ /g, ' ')
}

/* ───────────── 键盘：undo/redo/退格合并 ───────────── */
function onTextKeydown(block: Block, e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    if (e.shiftKey) doc.redo()
    else doc.undo()
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault()
    doc.redo()
    return
  }
  // 空段落：Enter 不产生新块；Backspace 合并/移除
  if (e.key === 'Enter') {
    const text = getBlockText(block)
    if (!text) {
      e.preventDefault()
      return
    }
  }
  if (e.key === 'Backspace' && !getBlockText(block)) {
    e.preventDefault()
    if (!doc.mergeWithPrevious(block.id)) {
      doc.removeBlock(block.id)
    }
    void nextTick(() => {
      const prev = doc.blocks[Math.max(0, doc.blocks.findIndex((b) => b.id === block.id) - 1)]
      if (prev) focusBlock(prev.id, true)
      else focusLast()
    })
  }
}

function getBlockText(b: Block): string {
  return (b.html ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()
}

/* ───────────── 焦点 / 光标 ───────────── */
function onBlockFocus(block: Block) {
  activeBlockId.value = block.id
  editorState.activeBlockId = block.id
  scheduleSelectionUpdate()
}

function onContainerClick() {
  // 点击空白聚焦最后一个块
  const target = document.activeElement
  if (target && (target as HTMLElement).closest?.('.hypora-block')) return
  focusLast()
}

function focusBlock(id: string, toEnd = true) {
  const el = elMap.get(id)
  if (!el) {
    void nextTick(() => focusBlock(id, toEnd))
    return
  }
  el.focus()
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(!toEnd)
  sel.removeAllRanges()
  sel.addRange(range)
}

function focusLast() {
  const blocks = doc.blocks
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.type === 'code' || b.type === 'mermaid' || b.type === 'image' || b.type === 'table') continue
    const el = elMap.get(b.id)
    if (el) {
      focusBlock(b.id, true)
      return
    }
  }
}

/** 搜索跳转：定位块内首个匹配文本节点并选中（SearchPanel 调用） */
function focusMatch(blockId: string, query: string) {
  const el = elMap.get(blockId)
  if (!el) {
    void nextTick(() => focusMatch(blockId, query))
    return
  }
  focusBlock(blockId, false)
  const sel = window.getSelection()
  if (!sel || !query) return
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const q = query.toLowerCase()
  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? ''
    const idx = text.toLowerCase().indexOf(q)
    if (idx >= 0) {
      const range = document.createRange()
      range.setStart(node, idx)
      range.setEnd(node, idx + q.length)
      sel.removeAllRanges()
      sel.addRange(range)
      el.scrollIntoView({ block: 'center' })
      return
    }
  }
}

function scheduleSelectionUpdate() {
  setTimeout(updateSelection, 0)
}

/* ───────────── 块操作辅助 ───────────── */
function removeBlock(block: Block) {
  doc.removeBlock(block.id)
  void nextTick(focusLast)
}

function setCodeLang(block: Block, e: Event) {
  block.lang = (e.target as HTMLInputElement).value.trim()
  markDirty()
}

function editMermaid(block: Block) {
  const code = prompt('编辑 Mermaid 源码：', block.code ?? '')
  if (code == null) return
  block.code = code
  doc.applyBlocks(doc.blocks)
  void nextTick(() => renderMermaid(block))
}

async function renderMermaid(block: Block) {
  const el = elMap.get(block.id)
  if (!el) return
  const source = (block.code ?? '').trim()
  if (!source) {
    el.innerHTML = '<p class="mm-empty">（空 Mermaid 源码）</p>'
    return
  }
  try {
    const { default: mermaid } = await import('mermaid')
    const dark = (document.documentElement.dataset.theme || '').includes('dark')
    mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict' })
    const count = (mmRenderCount.get(block.id) ?? 0) + 1
    mmRenderCount.set(block.id, count)
    const id = `mmd-${block.id}-${count}`
    const { svg } = await mermaid.render(id, source)
    el.innerHTML = svg
  } catch (err) {
    el.innerHTML = `<p class="mm-error">Mermaid 渲染失败：${escapeHtml(String(err).slice(0, 200))}</p>`
  }
}

function tableHtml(block: Block): string {
  const rows = (block.tableMd ?? '')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
  const isDelim = (cells: string[]) => cells.length > 0 && /^:?-{1,}:?$/.test(cells[0] ?? '')
  let head = ''
  let body = ''
  let inHead = true
  for (const cells of rows) {
    if (isDelim(cells)) continue
    const tr = `<tr>${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`
    if (inHead) {
      head = `<thead>${tr.replace(/<td/g, '<th').replace(/<\/td>/g, '</th>')}</thead>`
      inHead = false
    } else {
      body += tr
    }
  }
  return `<table>${head}<tbody>${body}</tbody></table>`
}

function editTable(block: Block) {
  const md = prompt('编辑表格（Markdown 语法）：', block.tableMd ?? '')
  if (md == null) return
  block.tableMd = md
  doc.applyBlocks(doc.blocks)
}

function replaceImage(block: Block) {
  const { openImageDialog } = useImageBase64()
  openImageDialog().then((dataUrl) => {
    if (dataUrl) {
      block.src = dataUrl
      doc.applyBlocks(doc.blocks)
    }
  })
}

/* ───────────── AI 插入（§6.2） ───────────── */
interface CaretSplit {
  blockId: string
  beforeHtml: string
  afterHtml: string
}

function getCaretSplit(): CaretSplit | null {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return null
  const range = sel.getRangeAt(0)
  const node = range.startContainer as Node
  const blockEl = findBlockEl(node)
  if (!blockEl) return null
  const before = range.cloneRange()
  before.selectNodeContents(blockEl)
  before.setEnd(range.startContainer, range.startOffset)
  const after = range.cloneRange()
  after.selectNodeContents(blockEl)
  after.setStart(range.startContainer, range.startOffset)
  return {
    blockId: blockEl.dataset.block as string,
    beforeHtml: fragmentHtml(before.cloneContents()),
    afterHtml: fragmentHtml(after.cloneContents()),
  }
}

function fragmentHtml(frag: DocumentFragment): string {
  const div = document.createElement('div')
  div.appendChild(frag)
  return div.innerHTML
}

function findBlockEl(node: Node): HTMLElement | null {
  let n: Node | null = node
  while (n) {
    const el = n as HTMLElement
    if (el.closest?.('[data-block]')) return el.closest('[data-block]')
    n = n.parentNode
  }
  return null
}

function findContainingChild(node: Node, children: Element[]): Element | null {
  let n: Node | null = node
  while (n) {
    if (n.parentNode === children[0]?.parentNode && children.includes(n as Element)) return n as Element
    if (children.includes(n as Element)) return n as Element
    n = n.parentNode
  }
  return null
}

function getSelectionText(): string {
  return editorState.selectionText || (window.getSelection()?.toString().trim() ?? '')
}

/** AI 插入：拆分当前块 → 插入新块 → 聚焦插入内容末尾 */
async function insertAIText(text: string): Promise<void> {
  const md = text.trim()
  if (!md) return
  const caret = getCaretSplit()
  const newBlocks = parseMarkdown(md)
  if (!caret) {
    doc.blocks.push(...newBlocks)
    doc.applyBlocks(doc.blocks)
    const last = newBlocks[newBlocks.length - 1]
    if (last) {
      editorState.lastInsertedBlockId = last.id
      await nextTick()
      focusBlock(last.id, true)
    }
    return
  }
  const idx = doc.blocks.findIndex((b) => b.id === caret.blockId)
  if (idx < 0) return
  const target = doc.blocks[idx]
  const head: Block = { ...target, id: genId(), html: caret.beforeHtml }
  const tail: Block = { ...target, id: genId(), html: caret.afterHtml }
  doc.blocks.splice(idx, 1, head, ...newBlocks, tail)
  doc.applyBlocks(doc.blocks)
  const last = newBlocks[newBlocks.length - 1] ?? tail
  editorState.lastInsertedBlockId = last.id
  await nextTick()
  focusBlock(last.id, false)
}

/** 替换选区（AI 润色/改写） */
async function replaceSelectionText(start: CaretSplit, end: CaretSplit, text: string): Promise<void> {
  const md = text.trim()
  const startIdx = doc.blocks.findIndex((b) => b.id === start.blockId)
  const endIdx = doc.blocks.findIndex((b) => b.id === end.blockId)
  if (startIdx < 0 || endIdx < 0 || startIdx > endIdx) return
  const newBlocks = md ? parseMarkdown(md) : []
  const prefix: Block = { ...doc.blocks[startIdx], id: genId(), html: start.beforeHtml }
  const suffix: Block = { ...doc.blocks[endIdx], id: genId(), html: end.afterHtml }
  const rest: Block[] = []
  doc.blocks.splice(startIdx, endIdx - startIdx + 1, prefix, ...newBlocks, suffix)
  doc.applyBlocks(doc.blocks)
  const last = newBlocks[newBlocks.length - 1] ?? suffix
  editorState.lastInsertedBlockId = last.id
  await nextTick()
  focusBlock(last.id, false)
}

function getCaretRange(): { start: CaretSplit; end: CaretSplit } | null {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  const startEl = findBlockEl(range.startContainer)
  const endEl = findBlockEl(range.endContainer)
  if (!startEl || !endEl) return null
  const s = range.cloneRange()
  s.selectNodeContents(startEl)
  s.setEnd(range.startContainer, range.startOffset)
  const e = range.cloneRange()
  e.selectNodeContents(endEl)
  e.setStart(range.endContainer, range.endOffset)
  return {
    start: { blockId: startEl.dataset.block as string, beforeHtml: fragmentHtml(s.cloneContents()), afterHtml: '' },
    end: { blockId: endEl.dataset.block as string, beforeHtml: '', afterHtml: fragmentHtml(e.cloneContents()) },
  }
}

/* ───────────── 预览渲染（§9 预热 / Prism 懒加载） ───────────── */
let prism: typeof import('prismjs') | null = null
async function ensurePrism() {
  if (prism) return prism
  const P = await import('prismjs')
  const langs = ['javascript', 'typescript', 'python', 'bash', 'json', 'css', 'html', 'java', 'c', 'cpp', 'go', 'rust', 'sql', 'yaml', 'markdown']
  for (const l of langs) {
    try {
      await import(`prismjs/components/prism-${l}.min.js`)
    } catch {
      /* 语言缺失忽略 */
    }
  }
  prism = P
  return P
}

let previewTimer = 0 as ReturnType<typeof setTimeout>
async function refreshPreview() {
  if (viewMode.value === 'edit') return
  const md = doc.markdown
  previewHtml.value = markdownToHtml(md)
  await nextTick()
  const root = previewEl.value
  if (!root) return
  const P = await ensurePrism()
  root.querySelectorAll('pre code').forEach((el) => {
    try {
      P.highlightElement(el as HTMLElement)
    } catch {
      /* ignore */
    }
  })
}

function schedulePreview() {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(refreshPreview, 250)
}

/* ───────────── 生命周期 ───────────── */
let onDocChange: () => void

onMounted(() => {
  // 渲染 mermaid 块
  doc.blocks.filter((b) => b.type === 'mermaid').forEach((b) => void renderMermaid(b))
  onDocChange = () => {
    doc.blocks.filter((b) => b.type === 'mermaid').forEach((b) => {
      const el = elMap.get(b.id)
      if (el && !el.innerHTML) void renderMermaid(b)
    })
    schedulePreview()
  }
  window.addEventListener('selectionchange', scheduleSelectionUpdate)
  focusLast()
})

onBeforeUnmount(() => {
  clearTimeout(dirtyTimer)
  clearTimeout(previewTimer)
  window.removeEventListener('selectionchange', scheduleSelectionUpdate)
})

watch(
  () => [doc.blocks.length, doc.markdown] as const,
  () => {
    onDocChange?.()
  },
)

watch(
  () => document.documentElement.dataset.theme,
  () => schedulePreview(),
)

defineExpose({
  focusBlock,
  focusLast,
  focusMatch,
  insertAIText,
  replaceSelectionText,
  getSelectionText,
  getCaretRange,
  getCaretSplit,
  activeBlockId,
})
</script>

<style scoped lang="scss">
.hypora-editor {
  flex: 1;
  display: flex;
  min-width: 0;
  height: 100%;
}

.editor-scroll {
  flex: 1;
  display: flex;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 24px 32px 120px;
  @include subtle-scrollbar;

  &.is-split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
  }
}

.editor-pane {
  max-width: 840px;
  width: 100%;
  margin: 0 auto;
}

.hypora-block {
  position: relative;
  border-radius: var(--hypora-radius-sm);
  transition: box-shadow var(--hypora-transition-fast);

  &:hover {
    .icon-btn {
      opacity: 1;
    }
  }

  &.active::after {
    content: '';
    position: absolute;
    left: -14px;
    top: 4px;
    bottom: 4px;
    width: 3px;
    border-radius: var(--hypora-radius-full);
    background: var(--hypora-accent);
    opacity: 0.7;
  }
}

.hypora-text {
  line-height: 1.75;
  padding: 2px 0;
  border-radius: var(--hypora-radius-sm);
  white-space: pre-wrap;
  word-break: break-word;

  &:focus {
    outline: none;
  }

  &.t-h1 {
    font-size: 1.9em;
    font-weight: 700;
    line-height: 1.35;
    margin: 0.4em 0 0.2em;
  }
  &.t-h2 {
    font-size: 1.5em;
    font-weight: 700;
    line-height: 1.35;
    margin: 0.4em 0 0.2em;
  }
  &.t-h3 {
    font-size: 1.25em;
    font-weight: 600;
    margin: 0.3em 0 0.15em;
  }
  &.t-h4 {
    font-size: 1.1em;
    font-weight: 600;
  }
  &.t-h5 {
    font-size: 1em;
    font-weight: 600;
    color: var(--hypora-fg-muted);
  }
  &.t-h6 {
    font-size: 0.92em;
    font-weight: 600;
    color: var(--hypora-fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  &.t-quote {
    border-left: 3px solid var(--hypora-accent);
    padding-left: 14px;
    margin: 4px 0;
    color: var(--hypora-fg-muted);
    font-style: italic;
  }
}

.hypora-text.t-ul,
.hypora-text.t-ol {
  padding-left: 24px;
  &::marker {
    color: var(--hypora-accent);
  }
}

.hypora-text.task-list {
  list-style: none;
  padding-left: 4px;

  .task-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    list-style: none;
  }

  input[type='checkbox'] {
    accent-color: var(--hypora-accent);
    margin-top: 5px;
  }
}

.code-meta,
.mermaid-meta,
.image-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border: 1px solid var(--hypora-border);
  border-bottom: none;
  border-radius: var(--hypora-radius) var(--hypora-radius) 0 0;
  background: var(--hypora-bg-inset);
  color: var(--hypora-fg-subtle);
  font-size: 12px;
}

.code-dots {
  width: 42px;
  height: 10px;
  border-radius: var(--hypora-radius-full);
  background: linear-gradient(90deg, var(--hypora-danger) 0 30%, var(--hypora-warning) 30% 60%, var(--hypora-success) 60%);
  opacity: 0.8;
}

.code-lang {
  flex: 1;
  background: transparent;
  font-family: var(--hypora-font-mono);
  font-size: 12px;
  color: var(--hypora-fg-muted);
}

.code-pre {
  margin: 0;
  padding: 14px 16px;
  overflow-x: auto;
  background: var(--hypora-bg-inset);
  border: 1px solid var(--hypora-border);
  border-radius: 0 0 var(--hypora-radius) var(--hypora-radius);
  font-family: var(--hypora-font-mono);
  font-size: 13px;
  line-height: 1.6;
  color: var(--hypora-code-fg);
  white-space: pre;
  @include subtle-scrollbar;

  &:focus {
    outline: none;
    border-color: var(--hypora-focus-ring);
  }
}

.mm-icon {
  color: var(--hypora-accent);
}

.mermaid-render {
  border: 1px solid var(--hypora-mermaid-border);
  border-radius: 0 0 var(--hypora-radius) var(--hypora-radius);
  padding: 16px;
  background: var(--hypora-bg-elevated);
  overflow-x: auto;
  min-height: 40px;
  @include subtle-scrollbar;
}

.mm-empty {
  color: var(--hypora-fg-subtle);
  font-size: 13px;
}
.mm-error {
  color: var(--hypora-danger);
  font-size: 13px;
}

.hypora-image {
  img {
    max-width: 100%;
    border-radius: var(--hypora-radius);
    border: 1px solid var(--hypora-border);
    background: var(--hypora-bg-elevated);
  }
}

.img-name {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hypora-hr {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 0;

  hr {
    flex: 1;
    border: none;
    border-top: 1px solid var(--hypora-border-strong);
  }
}

.hypora-table {
  .table-body {
    overflow-x: auto;
    border: 1px solid var(--hypora-border);
    border-radius: var(--hypora-radius);

    :deep(table) {
      font-size: 13px;

      th,
      td {
        border: 1px solid var(--hypora-border);
        padding: 6px 12px;
        text-align: left;
      }
      th {
        background: var(--hypora-table-head);
        font-weight: 600;
      }
    }
  }

  .mini-btn {
    margin-top: 8px;
  }
}

.mini-btn,
.icon-btn {
  border: 1px solid var(--hypora-border);
  background: var(--hypora-bg-elevated);
  color: var(--hypora-fg);
  border-radius: var(--hypora-radius-sm);
  padding: 2px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: all var(--hypora-transition-fast);

  &:hover {
    background: var(--hypora-bg-hover);
    border-color: var(--hypora-border-strong);
  }
}

.icon-btn {
  padding: 2px 8px;
  opacity: 0;
  transition: opacity var(--hypora-transition-fast);

  &.danger:hover {
    color: var(--hypora-danger);
    border-color: var(--hypora-danger);
  }
}

.empty-hint {
  color: var(--hypora-fg-subtle);
  text-align: center;
  padding: 40px 0;
}

.preview-pane {
  max-width: 840px;
  width: 100%;
  margin: 0 auto;
  line-height: 1.75;
  word-break: break-word;
  user-select: text;

  :deep(h1) {
    font-size: 1.9em;
    border-bottom: 2px solid var(--hypora-accent);
    padding-bottom: 8px;
  }
  :deep(h2) {
    font-size: 1.5em;
    margin-top: 1.2em;
  }
  :deep(h3) {
    font-size: 1.25em;
  }
  :deep(blockquote) {
    border-left: 3px solid var(--hypora-accent);
    margin: 8px 0;
    padding: 2px 14px;
    color: var(--hypora-fg-muted);
  }
  :deep(pre) {
    background: var(--hypora-bg-inset);
    border: 1px solid var(--hypora-border);
    border-radius: var(--hypora-radius);
    padding: 12px 14px;
    overflow-x: auto;
    font-family: var(--hypora-font-mono);
    font-size: 13px;
    @include subtle-scrollbar;
  }
  :deep(code) {
    font-family: var(--hypora-font-mono);
    background: var(--hypora-bg-inset);
    padding: 1px 5px;
    border-radius: var(--hypora-radius-sm);
    font-size: 0.9em;
  }
  :deep(pre code) {
    background: none;
    padding: 0;
  }
  :deep(table) {
    font-size: 13px;
    th,
    td {
      border: 1px solid var(--hypora-border);
      padding: 6px 12px;
    }
    th {
      background: var(--hypora-table-head);
    }
  }
  :deep(img) {
    max-width: 100%;
    border-radius: var(--hypora-radius);
  }
  :deep(a) {
    color: var(--hypora-link);
  }
}
</style>
