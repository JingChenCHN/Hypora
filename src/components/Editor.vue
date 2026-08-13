<template>
  <div class="editor-container" ref="containerRef">
    <!-- 所见即所得编辑模式 -->
    <div
      v-if="!docStore.isSourceMode"
      ref="editorRef"
      class="markdown-body"
      :class="{ 'typewriter-mode': docStore.typewriterMode, 'focus-mode': docStore.focusMode }"
      contenteditable="true"
      spellcheck="false"
      @input="handleInput"
      @paste="handlePaste"
      @drop="handleDrop"
      @dragover.prevent
      @keydown="handleKeydown"
      @click="handleClick"
      @focusout="handleFocusOut"
      @contextmenu.prevent="onContextMenu"
      v-html="renderedContent"
    ></div>

    <!-- 源码编辑模式 -->
    <textarea
      v-else
      ref="textareaRef"
      class="source-editor"
      :value="docStore.activeDocument?.content"
      @input="handleSourceInput"
      @contextmenu.prevent="onContextMenu"
      spellcheck="false"
    ></textarea>

    <!-- emoji 补全面板 -->
    <div v-if="emojiVisible" class="emoji-panel" :style="{ left: emojiX + 'px', top: emojiY + 'px' }" @mousedown.prevent>
      <div
        v-for="(emo, i) in emojiList"
        :key="emo.name"
        class="emoji-item"
        :class="{ active: i === emojiIndex }"
        @click="insertEmoji(emo)"
      >
        <span class="emoji-char">{{ emo.char }}</span>
        <span class="emoji-name">:{{ emo.name }}</span>
      </div>
    </div>

    <!-- 右键上下文菜单 -->
    <ContextMenu
      :visible="ctxVisible"
      :x="ctxX"
      :y="ctxY"
      :mode="ctxMode"
      @action="handleContextAction"
      @close="ctxVisible = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { mdToHtml, renderMermaid, extractOutline, handleImagePaste, insertMarkdown, htmlToMd, highlightCodeElement } from '@/utils/markdown'
import type { OutlineItem } from '@/utils/markdown'
import ContextMenu from './ContextMenu.vue'

const emit = defineEmits<{
  (e: 'outlineUpdate', outline: OutlineItem[]): void
  (e: 'statsUpdate', stats: { characters: number; words: number; lines: number }): void
  (e: 'context-action', action: string): void
}>()

const docStore = useDocumentStore()

const containerRef = ref<HTMLElement>()
const editorRef = ref<HTMLElement>()
const textareaRef = ref<HTMLTextAreaElement>()

// 渲染后的HTML内容
const renderedContent = ref('')

// 防抖定时器
let renderTimer: number | null = null
let syncTimer: number | null = null
let isComposing = false
// 标记：当前内容变化是否由用户输入触发（避免输入时 v-html 重渲染导致光标跳动）
let syncingFromInput = false
// 自定义 undo/redo 历史栈（浏览器 contenteditable undo 栈被 v-html 重渲染破坏，不可靠）
const history = ref<string[]>([])
const historyIndex = ref(-1)
let isUndoing = false

// 切换文档（含新建文档）时强制重新渲染，无论 content 是否相同
watch(() => docStore.activeDocId, (newId, oldId) => {
  // 切换前先把当前编辑区（旧文档）内容同步回旧文档，避免丢失最近编辑
  if (oldId && editorRef.value && !docStore.isSourceMode) {
    const oldDoc = docStore.documents.find(d => d.id === oldId)
    if (oldDoc) {
      try {
        const md = htmlToMd(editorRef.value.innerHTML)
        if (md && md !== oldDoc.content) {
          oldDoc.content = md
          oldDoc.isSaved = false
          docStore.saveToLocal()
        }
      } catch {}
    }
  }
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null }
  syncingFromInput = false
  const content = docStore.activeDocument?.content ?? ''
  renderContent(content)
  // 源码模式下切换文档，textarea 需重新自适应高度
  if (docStore.isSourceMode) {
    nextTick(() => autoResizeTextarea())
  }
}, { immediate: true })

// 内容变化时渲染（用户输入触发的变化跳过，避免光标跳动）
watch(() => docStore.activeDocument?.content, (newContent) => {
  if (syncingFromInput) {
    syncingFromInput = false
    return
  }
  if (newContent === undefined) return
  if (docStore.isSourceMode) {
    // 源码模式不重渲染所见即所得，仅更新统计
    updateStats()
  } else {
    debouncedRender(newContent)
  }
})

// 监听主题变化，重新渲染Mermaid
watch(() => docStore.currentTheme, () => {
  nextTick(() => {
    if (editorRef.value) {
      renderMermaid(editorRef.value)
    }
  })
})

// 源码模式切换时同步内容，避免切换丢失
watch(() => docStore.isSourceMode, (isSource) => {
  if (isSource) {
    // 切到源码前：记录光标所在块文本（用于切回后定位光标），并同步内容到 store
    let blockText = ''
    if (editorRef.value) {
      const sel = window.getSelection()
      const block = sel && sel.rangeCount > 0 ? getCurrentBlock(sel) : null
      if (block) blockText = (block.textContent || '').trim()
      const md = htmlToMd(editorRef.value.innerHTML)
      syncingFromInput = true
      docStore.updateContent(md)
    }
    // 自适应高度 + 光标定位到原块对应的源码行（而非每次都回第一行）
    nextTick(() => {
      autoResizeTextarea()
      const ta = textareaRef.value
      if (!ta) return
      const content = docStore.activeDocument?.content || ''
      const pos = findSourcePosForBlock(content, blockText)
      ta.focus({ preventScroll: true })
      ta.setSelectionRange(pos, pos)
      scrollToCaretInTextarea(ta)
    })
  } else {
    // 切回所见即所得：重新渲染 store 内容
    syncingFromInput = false
    renderContent(docStore.activeDocument?.content || '')
  }
})

// 源码模式 textarea 自适应高度（撑开编辑区，避免内容显示不全）
function autoResizeTextarea() {
  const ta = textareaRef.value
  if (!ta) return
  ta.style.height = 'auto'
  ta.style.height = Math.max(ta.scrollHeight, ta.parentElement?.clientHeight || 0) + 'px'
}

// 去除 markdown 行首/行内语法，得到渲染后的纯文本（用于源码行与所见即所得块文本匹配）
function stripMdSyntax(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/^(- \[[ x]\]\s+)/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/==([^=]+)==/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim()
}

// 在源码中找到与所见即所得块文本匹配的行起始偏移（行级光标保持）
function findSourcePosForBlock(content: string, blockText: string): number {
  if (!blockText) return 0
  const target = blockText.trim()
  const lines = content.split('\n')
  let offset = 0
  for (const line of lines) {
    const stripped = stripMdSyntax(line)
    if (stripped && (stripped === target || target.startsWith(stripped) || stripped.startsWith(target))) {
      return offset
    }
    offset += line.length + 1
  }
  return 0
}

// 滚动使 textarea 光标行可见（textarea 被 autoResizeTextarea 撑高，滚动发生在 .editor-container）
// 用 rAF 延迟设值，覆盖 focus 触发的浏览器默认滚动；配合 focus({preventScroll:true}) 确保聚焦光标行
function scrollToCaretInTextarea(ta: HTMLTextAreaElement) {
  const doScroll = () => {
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 22
    const lineNum = ta.value.slice(0, ta.selectionStart).split('\n').length - 1
    const target = lineNum * lineHeight
    if (containerRef.value) {
      containerRef.value.scrollTop = Math.max(0, target - containerRef.value.clientHeight / 3)
    }
  }
  requestAnimationFrame(doScroll)
}

// 防抖渲染（外部内容变化，如切换文档、源码模式回写）
function debouncedRender(content: string) {
  if (renderTimer) clearTimeout(renderTimer)
  renderTimer = window.setTimeout(() => {
    renderContent(content)
  }, 100)
}

// 渲染内容到编辑区
function renderContent(content: string) {
  renderedContent.value = mdToHtml(content)

  nextTick(async () => {
    if (editorRef.value) {
      await renderMermaid(editorRef.value)
      const outline = extractOutline(editorRef.value)
      emit('outlineUpdate', outline)
      // 重置 undo 历史：当前 DOM 作为初始快照
      history.value = [editorRef.value.innerHTML]
      historyIndex.value = 0
    }
    updateStats()
  })
}

// 更新字数统计
function updateStats() {
  const text = docStore.activeDocument?.content || ''
  const characters = text.length
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const lines = text.split('\n').length
  emit('statsUpdate', { characters, words, lines })
}

// 处理输入：把 contenteditable 的 HTML 转回 Markdown 同步到 store（防抖）
function handleInput(e: Event) {
  if (isComposing) return
  // 代码块内不触发自动格式化与 emoji 补全（避免在代码里误触 # 标题、:emoji 等）
  const insideCode = isInsideCode(window.getSelection())
  if (!insideCode) applyAutoFormat(e)
  debouncedSyncToStore()
  updateTypewriterAndFocus()
  if (!insideCode) detectEmoji()
}

// 打字机模式：当前光标行居中；焦点模式：当前段落高亮、其余变淡
function updateTypewriterAndFocus() {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const range = sel.getRangeAt(0)
  // 打字机：滚动使光标居中
  if (docStore.typewriterMode && containerRef.value) {
    const rect = range.getBoundingClientRect()
    const containerRect = containerRef.value.getBoundingClientRect()
    const target = containerRect.top + containerRect.height / 2
    const delta = rect.top - target
    containerRef.value.scrollTop += delta
  }
  // 焦点模式：标记当前块，其余变淡
  if (docStore.focusMode && editorRef.value) {
    editorRef.value.querySelectorAll('.focused').forEach(el => el.classList.remove('focused'))
    let node: Node | null = range.startContainer
    if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement
    while (node && node !== editorRef.value && node.parentElement) {
      const el = node as HTMLElement
      if (['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE'].includes(el.tagName)) {
        el.classList.add('focused')
        break
      }
      node = el.parentElement
    }
  }
}

// 防抖同步：HTML → Markdown → store（不触发重渲染，保留光标）
function debouncedSyncToStore() {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = window.setTimeout(() => {
    if (!editorRef.value) return
    const html = editorRef.value.innerHTML
    const md = htmlToMd(html)
    // 标记为用户输入触发，watch content 时跳过渲染
    syncingFromInput = true
    docStore.updateContent(md)

    // 记录 undo 历史（undo 操作本身不入栈）
    if (!isUndoing) {
      history.value = history.value.slice(0, historyIndex.value + 1)
      history.value.push(html)
      historyIndex.value = history.value.length - 1
      // 限制栈大小，避免内存膨胀
      if (history.value.length > 200) {
        history.value.shift()
        historyIndex.value--
      }
    }

    // 更新大纲（基于当前 DOM，无需重渲染）
    const outline = extractOutline(editorRef.value)
    emit('outlineUpdate', outline)
    updateStats()
  }, 300)
}

// 撤销：回退到上一个历史快照
function undo() {
  if (historyIndex.value <= 0) return
  historyIndex.value--
  const html = history.value[historyIndex.value]
  isUndoing = true
  if (editorRef.value) {
    editorRef.value.innerHTML = html
    // 快照可能含编辑态裸文本代码块，统一恢复高亮、退出编辑态
    rehighlightAllCodeBlocks(editorRef.value)
  }
  syncingFromInput = true
  docStore.updateContent(htmlToMd(html))
  isUndoing = false
  // 光标移到末尾
  const sel = window.getSelection()
  if (sel && editorRef.value) {
    const r = document.createRange()
    r.selectNodeContents(editorRef.value)
    r.collapse(false)
    sel.removeAllRanges()
    sel.addRange(r)
  }
  const outline = extractOutline(editorRef.value!)
  emit('outlineUpdate', outline)
  updateStats()
}

// 重做：前进到下一个历史快照
function redo() {
  if (historyIndex.value >= history.value.length - 1) return
  historyIndex.value++
  const html = history.value[historyIndex.value]
  isUndoing = true
  if (editorRef.value) {
    editorRef.value.innerHTML = html
    rehighlightAllCodeBlocks(editorRef.value)
  }
  syncingFromInput = true
  docStore.updateContent(htmlToMd(html))
  isUndoing = false
  const sel = window.getSelection()
  if (sel && editorRef.value) {
    const r = document.createRange()
    r.selectNodeContents(editorRef.value)
    r.collapse(false)
    sel.removeAllRanges()
    sel.addRange(r)
  }
  const outline = extractOutline(editorRef.value!)
  emit('outlineUpdate', outline)
  updateStats()
}

// 获取当前光标所在的块级元素（p/li/blockquote/h1-6）
function getCurrentBlock(sel: Selection): HTMLElement | null {
  let n: Node | null = sel.anchorNode
  if (!n) return null
  if (n.nodeType === Node.TEXT_NODE) n = n.parentElement
  while (n && n !== editorRef.value) {
    const el = n as HTMLElement
    if (['P', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(el.tagName)) {
      return el
    }
    n = el.parentElement
  }
  return null
}

// 用新元素替换当前块，光标重定位到新元素内首个可编辑位置（避免语法标记残留）
function replaceCurrentBlock(sel: Selection, newEl: HTMLElement) {
  const block = getCurrentBlock(sel)
  if (block) {
    block.replaceWith(newEl)
  } else if (editorRef.value) {
    editorRef.value.appendChild(newEl)
  }
  const target = newEl.querySelector('span') || newEl.querySelector('li') || newEl.querySelector('code') || newEl
  const r = document.createRange()
  r.selectNodeContents(target)
  r.collapse(true)
  sel.removeAllRanges()
  sel.addRange(r)
}

// ============ 代码块所见即所得编辑（对标 Typora） ============
// 代码块默认 contenteditable=false（不可编辑、显示语法高亮）；
// 点击进入编辑态：转为裸文本（移除 Prism token span，光标不卡在 span 内）；
// 失焦退出编辑态：重新 Prism 高亮、恢复不可编辑。

// 判断光标是否在代码块内
function isInsideCode(sel: Selection | null | undefined): boolean {
  const node = sel?.anchorNode
  if (!node) return false
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement | null)
  return !!el?.closest('.code-block-wrapper')
}

// 进入代码块编辑态：裸文本可编辑，光标定位到 offset（默认开头）
function enterCodeEditMode(code: HTMLElement, offset = 0) {
  // 移除 Prism token span，转为单一文本节点，保证编辑时光标干净
  const raw = code.textContent || ''
  code.textContent = raw
  if (!code.firstChild) code.appendChild(document.createTextNode(''))
  code.contentEditable = 'true'
  code.closest('.code-block-wrapper')?.classList.add('editing')
  code.focus()
  const sel = window.getSelection()
  if (!sel) return
  const node = code.firstChild
  const safeOffset = Math.min(offset, node?.textContent?.length ?? 0)
  const r = document.createRange()
  if (node) r.setStart(node, safeOffset)
  else r.setStart(code, 0)
  r.collapse(true)
  sel.removeAllRanges()
  sel.addRange(r)
}

// 点击代码区域进入编辑态：按点击坐标还原光标到对应字符
function activateCodeEdit(code: HTMLElement, e: MouseEvent) {
  let offset = 0
  // 高亮态下点击位置落在 Prism token span 内，用 toString 长度折算为裸文本字符偏移
  const pointRange = (document as any).caretRangeFromPoint?.(e.clientX, e.clientY)
  if (pointRange && code.contains(pointRange.startContainer)) {
    const measure = document.createRange()
    measure.selectNodeContents(code)
    try { measure.setEnd(pointRange.startContainer, pointRange.startOffset) } catch {}
    offset = measure.toString().length
  }
  enterCodeEditMode(code, offset)
}

// 退出代码块编辑态：重新语法高亮、恢复不可编辑，并同步历史快照
function deactivateCodeEdit(code: HTMLElement) {
  highlightCodeElement(code)
  code.contentEditable = 'false'
  code.closest('.code-block-wrapper')?.classList.remove('editing')
  // 取消待执行的防抖同步，立即同步
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null }
  if (!editorRef.value) return
  const html = editorRef.value.innerHTML
  const md = htmlToMd(html)
  syncingFromInput = true
  docStore.updateContent(md)
  // 与上一快照文本一致（仅高亮态变化）→ 覆盖当前快照，避免 undo 出现无变化的空步；
  // 文本有变化（有未同步的编辑/新建）→ 压入新快照，保留编辑前可撤销状态
  const prevMd = historyIndex.value >= 0 ? htmlToMd(history.value[historyIndex.value]) : null
  if (prevMd !== null && prevMd === md) {
    history.value[historyIndex.value] = html
  } else {
    history.value = history.value.slice(0, historyIndex.value + 1)
    history.value.push(html)
    historyIndex.value = history.value.length - 1
    if (history.value.length > 200) { history.value.shift(); historyIndex.value-- }
  }
  emit('outlineUpdate', extractOutline(editorRef.value))
  updateStats()
}

// focusout 事件委托：失焦的代码块退出编辑态
function handleFocusOut(e: FocusEvent) {
  const t = e.target as HTMLElement | null
  if (t && t.tagName === 'CODE' && t.contentEditable === 'true' && t.closest('.code-block-wrapper')) {
    deactivateCodeEdit(t)
  }
}

// 代码块内插入换行符（pre 上下文渲染为换行、textContent 保留 \n，避免 <br> 丢行）
function insertNewlineAtCaret() {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const range = sel.getRangeAt(0)
  range.deleteContents()
  const nl = document.createTextNode('\n')
  range.insertNode(nl)
  const r = document.createRange()
  r.setStartAfter(nl)
  r.collapse(true)
  sel.removeAllRanges()
  sel.addRange(r)
}

// 把光标定位到块内首个可编辑位置；代码块则进入编辑态
function focusBlockStart(target: HTMLElement, sel: Selection | null) {
  if (target.tagName === 'CODE' && target.closest('.code-block-wrapper')) {
    enterCodeEditMode(target)
    return
  }
  const r = document.createRange()
  r.selectNodeContents(target)
  r.collapse(true)
  sel?.removeAllRanges()
  sel?.addRange(r)
}

// 重新高亮所有代码块并退出编辑态（undo/redo 恢复快照后统一规整）
function rehighlightAllCodeBlocks(root: HTMLElement) {
  root.querySelectorAll('.code-block-wrapper code').forEach(c => {
    const code = c as HTMLElement
    code.contentEditable = 'false'
    code.closest('.code-block-wrapper')?.classList.remove('editing')
    highlightCodeElement(code)
  })
}

// 自动格式化 - 实现Typora即时渲染效果
function applyAutoFormat(e: Event) {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return

  const range = selection.getRangeAt(0)
  const node = range.startContainer
  if (node.nodeType !== Node.TEXT_NODE) return

  const text = node.textContent || ''
  const cursorPos = range.startOffset

  // # 空格自动转标题
  const headingMatch = text.match(/^(#{1,6})\s$/)
  if (headingMatch && cursorPos === text.length) {
    const level = headingMatch[1].length
    // 列表内：退出列表后插入标题（避免 ul>h 非法嵌套），光标定位到标题内
    const curBlock = getCurrentBlock(selection)
    if (curBlock?.tagName === 'LI') {
      const h = document.createElement(`h${level}`)
      if (exitListAndInsert(h, selection)) {
        // exitListAndInsert 光标默认到 p，重定位到 h 内以便输入标题
        const r = document.createRange()
        r.selectNodeContents(h)
        r.collapse(true)
        selection.removeAllRanges()
        selection.addRange(r)
        e.preventDefault()
        return
      }
    }
    document.execCommand('formatBlock', false, `h${level}`)
    // 清空 "## " 残留，使 :empty 占位生效，并把光标重定位到空标题内
    const h = selection.anchorNode?.parentElement
    if (h && h.tagName === `H${level}`) {
      h.innerHTML = ''
      const r = document.createRange()
      r.selectNodeContents(h)
      r.collapse(true)
      selection.removeAllRanges()
      selection.addRange(r)
    } else {
      node.textContent = ''
    }
    e.preventDefault()
    return
  }

  // ``` 回车生成代码块
  const codeBlockMatch = text.match(/^```(\w*)$/)
  if (codeBlockMatch && cursorPos === text.length) {
    const lang = codeBlockMatch[1] || 'plaintext'
    const wrapper = document.createElement('div')
    wrapper.className = 'code-block-wrapper'
    wrapper.setAttribute('contenteditable', 'false')
    const header = document.createElement('div')
    header.className = 'code-block-header'
    const langSpan = document.createElement('span')
    langSpan.className = 'code-lang'
    langSpan.textContent = lang
    const copyBtn = document.createElement('button')
    copyBtn.className = 'code-copy-btn'
    copyBtn.textContent = '复制'
    copyBtn.onclick = () => { window.copyCode?.(copyBtn) }
    header.append(langSpan, copyBtn)
    const pre = document.createElement('pre')
    pre.className = `language-${lang}`
    const code = document.createElement('code')
    code.className = `language-${lang}`
    pre.appendChild(code)
    wrapper.append(header, pre)
    // 列表内：退出列表后插入代码块，避免 ul>div 非法嵌套
    if (exitListAndInsert(wrapper, selection)) {
      e.preventDefault()
      return
    }
    const p = document.createElement('p')
    p.innerHTML = '<br>'
    const block = getCurrentBlock(selection)
    if (block) {
      block.replaceWith(wrapper)
      wrapper.after(p)
    } else if (editorRef.value) {
      editorRef.value.append(wrapper, p)
    }
    // 进入代码块编辑态：裸文本可编辑，失焦后恢复语法高亮
    focusBlockStart(code, selection)
    e.preventDefault()
    return
  }

  // * 空格 或 - 空格 生成无序列表
  const ulMatch = text.match(/^[\*\-]\s$/)
  if (ulMatch && cursorPos === text.length) {
    const block = getCurrentBlock(selection)
    // 已在列表项内：消费 "- " 语法，不嵌套新列表，清空当前项让用户继续输入
    if (block?.tagName === 'LI') {
      block.innerHTML = ''
      const r = document.createRange()
      r.selectNodeContents(block); r.collapse(true)
      selection.removeAllRanges(); selection.addRange(r)
      e.preventDefault()
      return
    }
    const ul = document.createElement('ul')
    ul.appendChild(document.createElement('li'))
    replaceCurrentBlock(selection, ul)
    e.preventDefault()
    return
  }

  // 1. 空格 生成有序列表
  const olMatch = text.match(/^\d+\.\s$/)
  if (olMatch && cursorPos === text.length) {
    const block = getCurrentBlock(selection)
    if (block?.tagName === 'LI') {
      block.innerHTML = ''
      const r = document.createRange()
      r.selectNodeContents(block); r.collapse(true)
      selection.removeAllRanges(); selection.addRange(r)
      e.preventDefault()
      return
    }
    const ol = document.createElement('ol')
    ol.appendChild(document.createElement('li'))
    replaceCurrentBlock(selection, ol)
    e.preventDefault()
    return
  }

  // > 空格 生成引用
  const quoteMatch = text.match(/^>\s$/)
  if (quoteMatch && cursorPos === text.length) {
    const bq = document.createElement('blockquote')
    const inner = document.createElement('p')  // 引用内放 p，确保空引用光标可定位
    bq.appendChild(inner)
    // 列表内：退出列表后插入引用，避免 ul>blockquote 非法嵌套
    if (exitListAndInsert(bq, selection)) {
      e.preventDefault()
      return
    }
    const block = getCurrentBlock(selection)
    if (block) block.replaceWith(bq)
    else if (editorRef.value) editorRef.value.appendChild(bq)
    const r = document.createRange()
    r.selectNodeContents(inner)
    r.collapse(true)
    selection.removeAllRanges()
    selection.addRange(r)
    e.preventDefault()
    return
  }

  // --- 回车生成分割线
  const hrMatch = text.match(/^(-{3,}|\*{3,}|_{3,})$/)
  if (hrMatch && cursorPos === text.length) {
    const hr = document.createElement('hr')
    const p = document.createElement('p')
    p.innerHTML = '<br>'
    const block = getCurrentBlock(selection)
    if (block?.tagName === 'LI') {
      // 列表项内：退出列表，在列表之后插入 hr（避免 ul>hr 非法嵌套，复用 exitListAndInsert 避免 detached 丢失）
      if (exitListAndInsert(hr, selection)) {
        e.preventDefault()
        return
      }
    } else if (block) {
      block.replaceWith(hr)
      hr.after(p)
    } else if (editorRef.value) {
      editorRef.value.append(hr, p)
    }
    const r = document.createRange()
    r.selectNodeContents(p)
    r.collapse(true)
    selection.removeAllRanges()
    selection.addRange(r)
    e.preventDefault()
    return
  }

  // [] 空格 生成任务列表
  const taskMatch = text.match(/^\[\s\]\s$/)
  if (taskMatch && cursorPos === text.length) {
    const ul = document.createElement('ul')
    const li = document.createElement('li')
    li.className = 'task-list-item'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.className = 'task-checkbox'
    li.appendChild(input)
    ul.appendChild(li)
    // 列表内：退出列表后插入任务列表，避免 ul>ul 非法嵌套
    if (exitListAndInsert(ul, selection)) {
      e.preventDefault()
      return
    }
    const block = getCurrentBlock(selection)
    if (block) block.replaceWith(ul)
    else if (editorRef.value) editorRef.value.appendChild(ul)
    // 光标精确定位到 input 之后，使输入文字出现在复选框后
    const r = document.createRange()
    r.setStartAfter(input)
    r.collapse(true)
    selection.removeAllRanges()
    selection.addRange(r)
    e.preventDefault()
    return
  }
}

// 处理粘贴
async function handlePaste(e: ClipboardEvent) {
  e.preventDefault()
  const items = e.clipboardData?.items

  if (items) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile()
        if (file) {
          const imgData = await handleImagePaste(file)
          document.execCommand('insertHTML', false, `<img src="${imgData}" alt="pasted image">`)
          return
        }
      }
    }
  }

  // 粘贴纯文本
  const text = e.clipboardData?.getData('text/plain') || ''
  document.execCommand('insertText', false, text)
}

// 处理拖拽
async function handleDrop(e: DragEvent) {
  e.preventDefault()
  const files = e.dataTransfer?.files

  if (files && files.length > 0) {
    for (let i = 0; i < files.length; i++) {
      if (files[i].type.indexOf('image') !== -1) {
        const imgData = await handleImagePaste(files[i])
        document.execCommand('insertHTML', false, `<img src="${imgData}" alt="dropped image">`)
        return
      }
    }
  }

  const text = e.dataTransfer?.getData('text/plain') || ''
  if (text) {
    document.execCommand('insertText', false, text)
  }
}

// 源码模式输入
function handleSourceInput(e: Event) {
  const value = (e.target as HTMLTextAreaElement).value
  docStore.updateContent(value)
  autoResizeTextarea()
}

// 键盘事件处理
function handleKeydown(e: KeyboardEvent) {
  const selection = window.getSelection()

  // 撤销/重做（自定义历史栈，避免浏览器 undo 只回退一步）
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault()
    undo()
    return
  }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
    e.preventDefault()
    redo()
    return
  }

  // 选中整块（代码块/表格 wrapper）时，Backspace/Delete 删除整块（对标 Typora 块选中删除）
  if ((e.key === 'Backspace' || e.key === 'Delete') && selection && selection.rangeCount > 0 && !selection.isCollapsed) {
    const an = selection.anchorNode
    const fn = selection.focusNode
    if (an === fn && an && an.nodeType === Node.ELEMENT_NODE) {
      const el = an as HTMLElement
      const wrapper = el.closest('.code-block-wrapper') || el.closest('.table-wrapper')
      if (wrapper && editorRef.value) {
        e.preventDefault()
        const p = document.createElement('p')
        p.innerHTML = '<br>'
        wrapper.replaceWith(p)
        // 光标定位到新空段落
        const r = document.createRange()
        r.selectNodeContents(p)
        r.collapse(true)
        selection.removeAllRanges()
        selection.addRange(r)
        // 同步 store + 历史快照（与 deactivateCodeEdit 一致）
        if (syncTimer) { clearTimeout(syncTimer); syncTimer = null }
        const html = editorRef.value.innerHTML
        const md = htmlToMd(html)
        syncingFromInput = true
        docStore.updateContent(md)
        const prevMd = historyIndex.value >= 0 ? htmlToMd(history.value[historyIndex.value]) : null
        if (prevMd !== null && prevMd === md) {
          history.value[historyIndex.value] = html
        } else {
          history.value = history.value.slice(0, historyIndex.value + 1)
          history.value.push(html)
          historyIndex.value = history.value.length - 1
          if (history.value.length > 200) { history.value.shift(); historyIndex.value-- }
        }
        emit('outlineUpdate', extractOutline(editorRef.value))
        updateStats()
        updateTypewriterAndFocus()
        return
      }
    }
  }

  // 空列表项退格/删除：删除圆点并退出列表（对标 Typora 空项删除圆点）。
  // 浏览器默认在 <li> 内按 Backspace 不会移除空项，导致 `- ` 自动生成的列表删不掉、无法退出。
  if ((e.key === 'Backspace' || e.key === 'Delete') && selection && selection.rangeCount > 0 && selection.isCollapsed) {
    const block = getCurrentBlock(selection)
    if (block?.tagName === 'LI' && isEmptyListItem(block)) {
      e.preventDefault()
      exitEmptyListItem(block, selection)
      return
    }
  }

  // emoji 补全面板键盘控制
  if (emojiVisible.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      emojiIndex.value = (emojiIndex.value + 1) % emojiList.value.length
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      emojiIndex.value = (emojiIndex.value - 1 + emojiList.value.length) % emojiList.value.length
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      insertEmoji(emojiList.value[emojiIndex.value])
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      emojiVisible.value = false
      return
    }
  }

  // Tab 键缩进
  if (e.key === 'Tab') {
    e.preventDefault()
    document.execCommand('insertText', false, '    ')
    return
  }

  // 代码块内 Enter：插入换行符（pre 上下文渲染为换行、textContent 保留 \n，避免 <br> 丢行）
  if (e.key === 'Enter' && isInsideCode(selection)) {
    e.preventDefault()
    insertNewlineAtCaret()
    debouncedSyncToStore()
    updateTypewriterAndFocus()
    return
  }

  // 解析组合键字符串
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('ctrl')
  if (e.shiftKey) parts.push('shift')
  if (e.altKey) parts.push('alt')
  parts.push(e.key.toLowerCase())
  const keyStr = parts.join('+')

  // Typora 风格编辑快捷键映射
  const shortcutMap: Record<string, string> = {
    'ctrl+b': 'bold',
    'ctrl+i': 'italic',
    'ctrl+u': 'underline',
    'alt+shift+5': 'strikethrough',
    'ctrl+shift+s': 'strikethrough',
    'ctrl+shift+h': 'highlight',
    'ctrl+`': 'code',
    'ctrl+shift+`': 'code',
    'ctrl+shift+c': 'code',
    'ctrl+shift+k': 'codeBlock',
    'ctrl+shift+m': 'math',
    'ctrl+k': 'link',
    'ctrl+shift+i': 'image',
    'ctrl+1': 'h1', 'ctrl+2': 'h2', 'ctrl+3': 'h3',
    'ctrl+4': 'h4', 'ctrl+5': 'h5', 'ctrl+6': 'h6',
    'ctrl+0': 'paragraph',
    'ctrl+]': 'headingUp',
    'ctrl+[': 'headingDown',
    'ctrl+shift+q': 'quote',
    'ctrl+q': 'quote',
    'ctrl+shift+t': 'table',
    'ctrl+shift+u': 'ul',
    'ctrl+shift+o': 'ol',
    'ctrl+shift+x': 'task',
    'ctrl+\\': 'clearFormat'
  }

  // 代码块内禁用格式快捷键（避免在代码里插入 <strong>/<mark> 等污染代码内容）
  if (isInsideCode(selection) && shortcutMap[keyStr]) {
    e.preventDefault()
    return
  }

  if (shortcutMap[keyStr]) {
    e.preventDefault()
    insertFormat(shortcutMap[keyStr])
    return
  }

  // 回车：在标题中回车自动退出为段落（Typora 行为）
  if (e.key === 'Enter' && !e.shiftKey && selection && selection.rangeCount > 0) {
    const block = selection.anchorNode?.parentElement
    if (block?.tagName?.match(/^H[1-6]$/)) {
      setTimeout(() => {
        document.execCommand('formatBlock', false, 'p')
      }, 0)
    }
  }
}

function handleClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  // 点击任务列表复选框切换状态，并同步到文档（避免勾选不保存）
  if (target.classList.contains('task-checkbox')) {
    e.preventDefault()
    target.toggleAttribute('checked')
    debouncedSyncToStore()
    updateTypewriterAndFocus()
    return
  }
  // 点击代码块 header（语言条，排除复制按钮）选中整块，便于整体删除（对标 Typora 块选中）
  if (target.closest('.code-block-header') && !target.closest('.code-copy-btn')) {
    e.preventDefault()
    const wrapper = target.closest('.code-block-wrapper') as HTMLElement | null
    if (wrapper) selectWholeBlock(wrapper)
    return
  }
  // 代码块：点击代码区域进入编辑态（裸文本可编辑，失焦后恢复语法高亮）
  // 复制按钮走 window.copyCode，不进入编辑态
  if (!target.closest('.code-copy-btn')) {
    const pre = target.closest('pre') as HTMLElement | null
    const code = pre?.querySelector('code') as HTMLElement | null
    if (code && code.contentEditable !== 'true') {
      activateCodeEdit(code, e)
    }
  }
  // 点击后更新打字机/焦点状态
  setTimeout(updateTypewriterAndFocus, 0)

  // 点击链接在系统浏览器打开
  if (target.tagName === 'A') {
    e.preventDefault()
    const url = (target as HTMLAnchorElement).href
    if ((window as any).electronAPI?.dev?.openExternal) {
      ;(window as any).electronAPI.dev.openExternal(url)
    } else {
      window.open(url, '_blank')
    }
  }
}

// ============ 右键上下文菜单（对标 Typora） ============
const ctxVisible = ref(false)
const ctxX = ref(0)
const ctxY = ref(0)
const ctxMode = ref<'default' | 'table'>('default')
const ctxCell = ref<HTMLTableCellElement | null>(null)

// ============ emoji 补全（输入 :name 弹出选择） ============
const EMOJIS: { name: string; char: string }[] = [
  { name: 'smile', char: '😄' }, { name: 'laugh', char: '😆' }, { name: 'joy', char: '😂' },
  { name: 'rofl', char: '🤣' }, { name: 'wink', char: '😉' }, { name: 'blush', char: '😊' },
  { name: 'heart', char: '❤️' }, { name: 'broken', char: '💔' }, { name: 'fire', char: '🔥' },
  { name: 'star', char: '⭐' }, { name: 'thumbsup', char: '👍' }, { name: 'thumbsdown', char: '👎' },
  { name: 'ok', char: '👌' }, { name: 'clap', char: '👏' }, { name: 'wave', char: '👋' },
  { name: 'check', char: '✅' }, { name: 'cross', char: '❌' }, { name: 'warning', char: '⚠️' },
  { name: 'info', char: 'ℹ️' }, { name: 'bulb', char: '💡' }, { name: 'rocket', char: '🚀' },
  { name: 'tada', char: '🎉' }, { name: '100', char: '💯' }, { name: 'eyes', char: '👀' },
  { name: 'thinking', char: '🤔' }, { name: 'cool', char: '😎' }, { name: 'cry', char: '😢' },
  { name: 'angry', char: '😠' }, { name: 'sleep', char: '😴' }, { name: 'coffee', char: '☕' },
  { name: 'beer', char: '🍺' }, { name: 'cake', char: '🍰' }, { name: 'apple', char: '🍎' },
  { name: 'book', char: '📖' }, { name: 'pen', char: '🖊️' }, { name: 'link', char: '🔗' },
  { name: 'gear', char: '⚙️' }, { name: 'lock', char: '🔒' }, { name: 'key', char: '🔑' },
  { name: 'flag', char: '🚩' }, { name: 'mail', char: '✉️' }, { name: 'phone', char: '📞' },
  { name: 'clock', char: '⏰' }, { name: 'calendar', char: '📅' }, { name: 'umbrella', char: '☂️' },
  { name: 'snow', char: '❄️' }, { name: 'sun', char: '☀️' }, { name: 'moon', char: '🌙' },
  { name: 'cloud', char: '☁️' }, { name: 'rainbow', char: '🌈' }, { name: 'leaf', char: '🍃' },
  { name: 'flower', char: '🌸' }, { name: 'tree', char: '🌳' }, { name: 'cat', char: '🐱' },
  { name: 'dog', char: '🐶' }, { name: 'bird', char: '🐦' }, { name: 'fish', char: '🐟' },
  { name: 'car', char: '🚗' }, { name: 'plane', char: '✈️' }, { name: 'bike', char: '🚲' },
  { name: 'house', char: '🏠' }, { name: 'office', char: '🏢' }, { name: 'school', char: '🏫' },
  { name: 'hospital', char: '🏥' }, { name: 'money', char: '💰' }, { name: 'chart', char: '📊' },
  { name: 'memo', char: '📝' }, { name: 'art', char: '🎨' }, { name: 'music', char: '🎵' },
  { name: 'game', char: '🎮' }, { name: 'gift', char: '🎁' }, { name: 'pizza', char: '🍕' },
  { name: 'burger', char: '🍔' }, { name: 'sushi', char: '🍣' }, { name: 'wine', char: '🍷' },
  { name: 'camera', char: '📷' }, { name: 'pc', char: '💻' }, { name: 'phone2', char: '📱' },
]
const emojiVisible = ref(false)
const emojiList = ref<typeof EMOJIS>([])
const emojiIndex = ref(0)
const emojiQuery = ref('')
const emojiX = ref(0)
const emojiY = ref(0)

// 检测光标前 :name 模式，弹出 emoji 面板
function detectEmoji() {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) { emojiVisible.value = false; return }
  const range = sel.getRangeAt(0)
  const node = range.startContainer
  if (node.nodeType !== Node.TEXT_NODE) { emojiVisible.value = false; return }
  const text = node.textContent || ''
  const before = text.slice(0, range.startOffset)
  const m = before.match(/:([a-zA-Z0-9_+-]{1,20})$/)
  if (!m) { emojiVisible.value = false; return }
  emojiQuery.value = m[1]
  const matched = EMOJIS.filter(e => e.name.includes(m[1].toLowerCase())).slice(0, 8)
  if (matched.length === 0) { emojiVisible.value = false; return }
  emojiList.value = matched
  emojiIndex.value = 0
  const rect = range.getBoundingClientRect()
  emojiX.value = rect.left
  emojiY.value = rect.bottom + 4
  emojiVisible.value = true
}

// 插入选中的 emoji，替换 :query
function insertEmoji(emoji: { name: string; char: string }) {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const range = sel.getRangeAt(0)
  const node = range.startContainer
  if (node.nodeType !== Node.TEXT_NODE) return
  const text = node.textContent || ''
  const before = text.slice(0, range.startOffset)
  const after = text.slice(range.startOffset)
  const idx = before.lastIndexOf(':')
  if (idx === -1) return
  node.textContent = before.slice(0, idx) + emoji.char + after
  // 光标移到 emoji 后
  const newOffset = idx + emoji.char.length
  range.setStart(node, newOffset)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
  emojiVisible.value = false
  debouncedSyncToStore()
}

function onContextMenu(e: MouseEvent) {
  // 源码模式下用系统默认右键菜单
  if (docStore.isSourceMode) return
  e.preventDefault()
  // 检测右键位置是否在表格单元格内
  const target = e.target as HTMLElement
  const cell = target.closest('td, th') as HTMLTableCellElement | null
  if (cell) {
    ctxMode.value = 'table'
    ctxCell.value = cell
  } else {
    ctxMode.value = 'default'
    ctxCell.value = null
  }
  // 边界处理：避免菜单超出窗口
  const menuW = 240, menuH = 480
  ctxX.value = Math.min(e.clientX, window.innerWidth - menuW)
  ctxY.value = Math.min(e.clientY, window.innerHeight - menuH)
  ctxVisible.value = true
}

// 右键菜单 action 分流：编辑命令→自定义undo/execCommand，表格→表格操作，格式→insertFormat，全局→emit
function handleContextAction(action: string) {
  ctxVisible.value = false
  // undo/redo 用自定义历史栈
  if (action === 'undo') { undo(); return }
  if (action === 'redo') { redo(); return }
  const editCmds: Record<string, string> = {
    cut: 'cut', copy: 'copy', paste: 'paste', selectAll: 'selectAll'
  }
  if (action in editCmds) {
    document.execCommand(editCmds[action])
    if (ctxCell.value) debouncedSyncToStore()
    return
  }
  if (action === 'search' || action === 'sourceMode') {
    emit('context-action', action)
    return
  }
  // 表格操作
  if (handleTableAction(action)) {
    debouncedSyncToStore()
    return
  }
  // 其余格式动作复用 insertFormat
  editorRef.value?.focus()
  insertFormat(action)
}

// ============ 表格操作（右键菜单） ============
function handleTableAction(action: string): boolean {
  const cell = ctxCell.value
  if (!cell) return false
  const row = cell.closest('tr')
  const table = cell.closest('table')
  if (!row || !table) return false
  const idx = cell.cellIndex
  const isHead = (tr: Element) => tr.parentElement?.tagName === 'THEAD'

  switch (action) {
    case 'insertRowAbove':
    case 'insertRowBelow': {
      const below = action === 'insertRowBelow'
      const newRow = document.createElement('tr')
      const colCount = row.cells.length
      for (let i = 0; i < colCount; i++) {
        const td = document.createElement('td')
        td.innerHTML = '<br>'
        newRow.appendChild(td)
      }
      // thead 下方插入 → 插到 tbody 第一行前（thead 只保留表头行）
      if (row.parentElement!.nodeName === 'THEAD' && below) {
        const tbody = table.querySelector('tbody')
        if (tbody && tbody.firstChild) (tbody.firstChild as Element).before(newRow)
        else tbody?.appendChild(newRow)
      } else if (below) {
        row.after(newRow)
      } else {
        row.before(newRow)
      }
      return true
    }
    case 'insertColumnLeft':
    case 'insertColumnRight': {
      const right = action === 'insertColumnRight'
      table.querySelectorAll('tr').forEach(tr => {
        const ref = tr.cells[idx]
        if (!ref) return
        const newCell = document.createElement(isHead(tr) ? 'th' : 'td')
        newCell.innerHTML = '<br>'
        if (right) ref.after(newCell)
        else ref.before(newCell)
      })
      return true
    }
    case 'deleteRow':
      row.remove()
      if (table.querySelectorAll('tr').length === 0) deleteTableEl(table)
      return true
    case 'deleteColumn':
      table.querySelectorAll('tr').forEach(tr => { tr.cells[idx]?.remove() })
      if ((table.querySelector('tr') as HTMLTableRowElement)?.cells.length === 0) deleteTableEl(table)
      return true
    case 'deleteTable':
      deleteTableEl(table)
      return true
    case 'alignLeft':
    case 'alignCenter':
    case 'alignRight': {
      const align = action === 'alignLeft' ? 'left' : action === 'alignCenter' ? 'center' : 'right'
      table.querySelectorAll('tr').forEach(tr => {
        if (tr.cells[idx]) (tr.cells[idx] as HTMLElement).style.textAlign = align
      })
      return true
    }
  }
  return false
}

function deleteTableEl(table: Element) {
  const wrapper = table.closest('.table-wrapper') || table
  wrapper.remove()
}

// 选中整个块级 wrapper（代码块/表格），作为可整体删除的入口（对标 Typora 块选中）
function selectWholeBlock(el: HTMLElement) {
  const sel = window.getSelection()
  if (!sel || !el.isConnected) return
  const r = document.createRange()
  r.selectNode(el)
  sel.removeAllRanges()
  sel.addRange(r)
  editorRef.value?.focus({ preventScroll: true })
}

// 构建 code-block-wrapper 元素
function buildCodeBlock(lang: string): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'code-block-wrapper'
  wrapper.setAttribute('contenteditable', 'false')
  const header = document.createElement('div')
  header.className = 'code-block-header'
  const langSpan = document.createElement('span')
  langSpan.className = 'code-lang'
  langSpan.textContent = lang
  const copyBtn = document.createElement('button')
  copyBtn.className = 'code-copy-btn'
  copyBtn.textContent = '复制'
  copyBtn.onclick = () => (window as any).copyCode?.(copyBtn)
  header.append(langSpan, copyBtn)
  const pre = document.createElement('pre')
  pre.className = `language-${lang}`
  const code = document.createElement('code')
  code.className = `language-${lang}`
  pre.appendChild(code)
  wrapper.append(header, pre)
  return wrapper
}

// 在当前块位置插入块级元素，光标重定位到可编辑位置
function insertBlockElement(el: HTMLElement, sel: Selection | null, withNewPara = true) {
  const block = sel ? getCurrentBlock(sel) : null
  const p = document.createElement('p')
  p.innerHTML = '<br>'
  const isEmptyP = block?.tagName === 'P' && (block.textContent?.trim() === '' || block.innerHTML === '<br>')
  if (block && isEmptyP) {
    block.replaceWith(el)
    if (withNewPara) el.after(p)
  } else if (block) {
    block.after(el)
    el.after(p)
  } else if (editorRef.value) {
    editorRef.value.append(el, p)
  }
  const target = el.querySelector('code') || el.querySelector('li') || (withNewPara ? p : el)
  focusBlockStart(target as HTMLElement, sel)
}

// 列表项内触发块级元素时：退出列表，在列表之后插入元素（避免 ul>块级 非法嵌套）
// 返回 true 表示已处理（调用方应 return），false 表示不在列表内需走普通逻辑
function exitListAndInsert(el: HTMLElement, sel: Selection | null): boolean {
  const block = sel ? getCurrentBlock(sel) : null
  if (block?.tagName !== 'LI') return false
  const list = block.parentElement as HTMLElement | null
  // 删除前先记录列表的父级和后继，防止列表变空被 remove 后变成 detached 节点导致 .after() 失效
  const parent = list?.parentElement as HTMLElement | null
  const next = list?.nextSibling as Node | null
  block.remove()
  let listRemoved = false
  if (list && list.children.length === 0) { list.remove(); listRemoved = true }

  const p = document.createElement('p')
  p.innerHTML = '<br>'
  if (!listRemoved && list) {
    // 列表仍在 DOM，元素插到列表之后
    list.after(el)
  } else if (parent) {
    // 列表被删，元素插到原列表位置（next 之前）
    if (next && next.parentNode) parent.insertBefore(el, next)
    else parent.appendChild(el)
  } else if (editorRef.value) {
    editorRef.value.appendChild(el)
  }
  el.after(p)

  const target = el.querySelector('code') || el.querySelector('li') || p
  focusBlockStart(target as HTMLElement, sel)
  return true
}

// 空列表项判断：无文本内容（任务列表项允许仅有 checkbox，checkbox 无文本）
function isEmptyListItem(li: HTMLElement): boolean {
  const text = (li.textContent || '').replace(/ /g, '').trim()
  return text === ''
}

// 空列表项退格/删除：删掉当前空项；首项则整段列表退出为段落（对标 Typora 空项退格删圆点）
function exitEmptyListItem(li: HTMLElement, sel: Selection) {
  const list = li.parentElement as HTMLElement | null
  // 先记录父级/后继/前一项，防止列表变空 remove 后 .after()/.previousElementSibling 失效
  const parent = list?.parentElement as HTMLElement | null
  const next = list?.nextSibling as Node | null
  const isFirst = !li.previousElementSibling
  const prev = li.previousElementSibling as HTMLElement | null
  li.remove()
  let listRemoved = false
  if (list && list.children.length === 0) { list.remove(); listRemoved = true }

  if (isFirst) {
    if (listRemoved) {
      // 整个列表只有一个空项：列表退出为段落，光标回到段落开头
      const p = document.createElement('p')
      p.innerHTML = '<br>'
      if (parent) {
        if (next && next.parentNode) parent.insertBefore(p, next)
        else parent.appendChild(p)
      } else if (editorRef.value) {
        editorRef.value.appendChild(p)
      }
      focusBlockStart(p, sel)
    } else if (list) {
      // 列表还有其他项：只删空项，光标落到新首项开头
      focusBlockStart(list.firstElementChild as HTMLElement, sel)
    }
  } else if (prev) {
    // 非首项退格：光标落到前一项末尾
    focusBlockEnd(prev, sel)
  }

  debouncedSyncToStore()
  updateTypewriterAndFocus()
}

// 光标定位到元素末尾
function focusBlockEnd(target: HTMLElement, sel: Selection | null) {
  const r = document.createRange()
  r.selectNodeContents(target)
  r.collapse(false)
  sel?.removeAllRanges()
  sel?.addRange(r)
}

// 调整标题级别（Typora Ctrl+] 升级 / Ctrl+[ 降级）
// 列表项缩进：把当前 li 移入前一个 li 的嵌套子列表（生成合法嵌套结构）
function indentListItem(sel: Selection | null): boolean {
  const li = sel ? getCurrentBlock(sel) : null
  if (!li || li.tagName !== 'LI') return false
  const prev = li.previousElementSibling as HTMLElement | null
  if (!prev) return false // 第一个列表项无法缩进
  let subUl = prev.querySelector(':scope > ul, :scope > ol') as HTMLElement | null
  if (!subUl) {
    subUl = document.createElement(li.parentElement!.tagName.toLowerCase() === 'ol' ? 'ol' : 'ul')
    prev.appendChild(subUl)
  }
  subUl.appendChild(li)
  // 光标回到 li
  const r = document.createRange()
  r.selectNodeContents(li)
  r.collapse(true)
  sel?.removeAllRanges()
  sel?.addRange(r)
  return true
}

// 列表项反缩进：把嵌套 li 提升到外层
function outdentListItem(sel: Selection | null): boolean {
  const li = sel ? getCurrentBlock(sel) : null
  if (!li || li.tagName !== 'LI') return false
  const parentList = li.parentElement as HTMLElement | null
  if (!parentList) return false
  const grandLi = parentList.parentElement as HTMLElement | null
  if (!grandLi || grandLi.tagName !== 'LI') return false // 顶层列表项无法反缩进
  grandLi.after(li)
  if (parentList.children.length === 0) parentList.remove()
  const r = document.createRange()
  r.selectNodeContents(li)
  r.collapse(true)
  sel?.removeAllRanges()
  sel?.addRange(r)
  return true
}

function adjustHeadingLevel(delta: number, sel: Selection | null) {
  if (!sel) return
  let block: Node | null = sel.anchorNode
  if (block?.nodeType === Node.TEXT_NODE) block = block.parentElement
  while (block && block !== editorRef.value && !['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI'].includes((block as HTMLElement).tagName)) {
    block = (block as HTMLElement).parentElement
  }
  if (!block) return
  const tag = (block as HTMLElement).tagName
  // 列表项中：缩进/反缩进（生成嵌套子列表），不改变标题级别
  if (tag === 'LI') {
    if (delta > 0) indentListItem(sel)
    else outdentListItem(sel)
    return
  }
  // 标题/段落：调整标题级别（Ctrl+] 升级字号变大 h6→h1，Ctrl+[ 降级 h1→h6→p）
  let level = tag.startsWith('H') ? parseInt(tag[1]) : 0
  level = Math.max(0, Math.min(6, level + delta))
  document.execCommand('formatBlock', false, level === 0 ? 'p' : `h${level}`)
}

// 插入格式
function insertFormat(action: string, value?: string) {
  if (docStore.isSourceMode) {
    const textarea = textareaRef.value
    if (!textarea) return

    switch (action) {
      case 'bold':
        insertMarkdown(textarea, '**', '**', '粗体文本')
        break
      case 'italic':
        insertMarkdown(textarea, '*', '*', '斜体文本')
        break
      case 'strikethrough':
        insertMarkdown(textarea, '~~', '~~', '删除线文本')
        break
      case 'highlight':
        insertMarkdown(textarea, '==', '==', '高亮文本')
        break
      case 'code':
        insertMarkdown(textarea, '`', '`', '代码')
        break
      case 'codeBlock':
        insertMarkdown(textarea, '```\n', '\n```', '代码块')
        break
      case 'link':
        insertMarkdown(textarea, '[', '](链接地址)', '链接文本')
        break
      case 'image':
        insertMarkdown(textarea, '![', '](图片地址)', '图片描述')
        break
      case 'h1':
        insertMarkdown(textarea, '# ', '', '标题1')
        break
      case 'h2':
        insertMarkdown(textarea, '## ', '', '标题2')
        break
      case 'h3':
        insertMarkdown(textarea, '### ', '', '标题3')
        break
      case 'h4':
        insertMarkdown(textarea, '#### ', '', '标题4')
        break
      case 'quote':
        insertMarkdown(textarea, '> ', '', '引用内容')
        break
      case 'ul':
        insertMarkdown(textarea, '- ', '', '列表项')
        break
      case 'ol':
        insertMarkdown(textarea, '1. ', '', '列表项')
        break
      case 'task':
        insertMarkdown(textarea, '- [ ] ', '', '任务项')
        break
      case 'table':
        const tableTemplate = '\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n'
        insertMarkdown(textarea, tableTemplate, '', '')
        break
    }
    docStore.updateContent(textarea.value)
  } else {
    // 所见即所得：选区在编辑区内时直接操作，不强制 focus（避免丢失选区）
    const sel = window.getSelection()
    if (!editorRef.value?.contains(sel?.anchorNode)) {
      editorRef.value?.focus()
    }
    switch (action) {
      case 'bold':
        document.execCommand('bold')
        break
      case 'italic':
        document.execCommand('italic')
        break
      case 'underline':
        document.execCommand('underline')
        break
      case 'strikethrough':
        document.execCommand('strikeThrough')
        break
      case 'highlight': {
        const t = sel?.toString() || '高亮'
        document.execCommand('insertHTML', false, `<mark>${t}</mark>`)
        break
      }
      case 'clearFormat':
        document.execCommand('removeFormat')
        document.execCommand('formatBlock', false, 'p')
        break
      case 'code': {
        const t = sel?.toString() || '代码'
        document.execCommand('insertHTML', false, `<code class="inline-code">${t}</code>`)
        break
      }
      case 'codeBlock':
        insertBlockElement(buildCodeBlock('plaintext'), sel)
        break
      case 'math': {
        const div = document.createElement('div')
        div.className = 'math-block'
        div.textContent = '$$E=mc^2$$'
        insertBlockElement(div, sel)
        break
      }
      case 'h1':
        document.execCommand('formatBlock', false, 'h1')
        break
      case 'h2':
        document.execCommand('formatBlock', false, 'h2')
        break
      case 'h3':
        document.execCommand('formatBlock', false, 'h3')
        break
      case 'h4':
        document.execCommand('formatBlock', false, 'h4')
        break
      case 'h5':
        document.execCommand('formatBlock', false, 'h5')
        break
      case 'h6':
        document.execCommand('formatBlock', false, 'h6')
        break
      case 'paragraph':
        document.execCommand('formatBlock', false, 'p')
        break
      case 'headingUp':
      case 'headingDown':
        adjustHeadingLevel(action === 'headingUp' ? -1 : 1, sel)
        break
      case 'quote':
        document.execCommand('formatBlock', false, 'blockquote')
        break
      case 'ul':
        document.execCommand('insertUnorderedList')
        break
      case 'ol':
        document.execCommand('insertOrderedList')
        break
      case 'task': {
        const ul = document.createElement('ul')
        const li = document.createElement('li')
        li.className = 'task-list-item'
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.className = 'task-checkbox'
        li.appendChild(cb)
        ul.appendChild(li)
        insertBlockElement(ul, sel, true)
        const r = document.createRange()
        r.setStartAfter(cb)
        r.collapse(true)
        sel?.removeAllRanges()
        sel?.addRange(r)
        break
      }
      case 'link': {
        const url = prompt('请输入链接地址:', 'https://')
        if (url) {
          document.execCommand('createLink', false, url)
        }
        break
      }
      case 'image': {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/*'
        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0]
          if (file) {
            const imgData = await handleImagePaste(file)
            document.execCommand('insertHTML', false, `<img src="${imgData}" alt="image">`)
          }
        }
        input.click()
        break
      }
      case 'table': {
        const wrap = document.createElement('div')
        wrap.className = 'table-wrapper'
        const table = document.createElement('table')
        const thead = document.createElement('thead')
        const tr = document.createElement('tr')
        for (let i = 0; i < 3; i++) {
          const th = document.createElement('th')
          th.textContent = `列${i + 1}`
          tr.appendChild(th)
        }
        thead.appendChild(tr)
        const tbody = document.createElement('tbody')
        const tr2 = document.createElement('tr')
        for (let i = 0; i < 3; i++) {
          const td = document.createElement('td')
          td.textContent = '内容'
          tr2.appendChild(td)
        }
        tbody.appendChild(tr2)
        table.append(thead, tbody)
        wrap.appendChild(table)
        insertBlockElement(wrap, sel, true)
        break
      }
      case 'hr': {
        const hr = document.createElement('hr')
        insertBlockElement(hr, sel, true)
        break
      }
    }
  }
}

// 立即同步当前编辑内容到 store（Ctrl+S 保存前调用，确保内容最新，不等防抖）
function flushSync() {
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null }
  if (!docStore.isSourceMode && editorRef.value) {
    const md = htmlToMd(editorRef.value.innerHTML)
    syncingFromInput = true
    docStore.updateContent(md)
    const outline = extractOutline(editorRef.value)
    emit('outlineUpdate', outline)
    updateStats()
  } else if (docStore.isSourceMode && textareaRef.value) {
    docStore.updateContent(textareaRef.value.value)
  }
}

// 强制重新渲染当前 store content（搜索替换/外部改 content 后调用，绕过 syncingFromInput 跳过）
function forceRender() {
  syncingFromInput = false
  renderContent(docStore.activeDocument?.content || '')
  // 搜索替换流程是 flushSync（updateContent 会触发 content watch）后再 forceRender：
  // 这里重新置 true，让同 tick 里已被队列的 content watch 在 nextTick 命中时仅复位、跳过
  // 多余的 debouncedRender（否则 100ms 后二次渲染会清掉刚重新应用的高亮标记）。
  // watch 处理完即复位 false，不会影响后续正常的外部 content 更新渲染。
  syncingFromInput = true
}

// 规整所有代码块：退出编辑态、恢复语法高亮（导出 HTML/PDF/图片前调用，避免导出裸文本）
function normalizeCodeBlocks() {
  if (editorRef.value) rehighlightAllCodeBlocks(editorRef.value)
}

// 暴露方法给父组件
// ============ AI 助手集成：选区/插入/替换 ============

// 获取当前选中文本（供 AI 助手“对选中文字操作”使用）
function getSelectedText(): string {
  return window.getSelection()?.toString() || ''
}

// 在光标处插入 AI 回复（所见即所得渲染成 HTML 插入，源码模式插入纯文本到 textarea）
function insertTextAtCursor(text: string) {
  if (docStore.isSourceMode) {
    const ta = textareaRef.value
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const val = ta.value
    docStore.updateContent(val.slice(0, start) + text + val.slice(end))
    nextTick(() => {
      ta.focus()
      const pos = start + text.length
      ta.setSelectionRange(pos, pos)
    })
    return
  }
  if (!editorRef.value) return
  const sel = window.getSelection()
  if (!editorRef.value.contains(sel?.anchorNode)) editorRef.value.focus()
  // AI 回复是 markdown，渲染成 HTML 插入更贴近所见即所得
  document.execCommand('insertHTML', false, mdToHtml(text))
  debouncedSyncToStore()
}

// 替换当前选区为 AI 回复
function replaceSelection(text: string) {
  if (docStore.isSourceMode) {
    const ta = textareaRef.value
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const val = ta.value
    docStore.updateContent(val.slice(0, start) + text + val.slice(end))
    nextTick(() => {
      ta.focus()
      const pos = start + text.length
      ta.setSelectionRange(pos, pos)
    })
    return
  }
  flushSync()
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !editorRef.value?.contains(sel.anchorNode)) return
  document.execCommand('insertHTML', false, mdToHtml(text))
  debouncedSyncToStore()
}

defineExpose({
  insertFormat,
  getEditorElement: () => editorRef.value,
  flushSync,
  forceRender,
  normalizeCodeBlocks,
  undo,
  redo,
  getSelectedText,
  insertTextAtCursor,
  replaceSelection
})

onMounted(() => {
  // 初始化主题
  document.documentElement.setAttribute('data-theme', docStore.currentTheme)

  // 监听中文输入
  if (editorRef.value) {
    editorRef.value.addEventListener('compositionstart', () => { isComposing = true })
    editorRef.value.addEventListener('compositionend', () => {
      isComposing = false
      // 中文输入结束后同步内容到 store（input 事件在 composition 期间被跳过）
      // 代码块内不触发自动格式化（避免中文输入误触 # 标题、:emoji 等）
      if (!isInsideCode(window.getSelection())) applyAutoFormat(new Event('input'))
      debouncedSyncToStore()
    })
  }
})
</script>

<style lang="scss" scoped>
.editor-container {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--bg-primary);
  position: relative;
}

.source-editor {
  width: 100%;
  min-height: 100%;
  height: auto;
  padding: 40px 60px;
  max-width: 900px;
  margin: 0 auto;
  box-sizing: border-box;
  background: transparent;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 14px;
  line-height: 1.6;
  resize: none;
  border: none;
  outline: none;
  overflow: hidden;
}

:deep(.markdown-body) {
  caret-color: var(--text-primary);
}

:deep(.markdown-body:empty::before) {
  content: '开始输入...';
  color: var(--text-muted);
  pointer-events: none;
}

/* emoji 补全面板 */
.emoji-panel {
  position: fixed;
  z-index: 9999;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 2px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  padding: 6px;
  max-width: 240px;
}
.emoji-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 2px;
  cursor: pointer;
  font-size: 13px;
  &:hover, &.active { background: var(--bg-secondary); }
  .emoji-char { font-size: 18px; }
  .emoji-name { color: var(--text-muted); font-size: 12px; }
}
</style>