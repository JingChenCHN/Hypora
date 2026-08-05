/**
 * 文档 Store（§6.1 编辑管线 / §6.4 导出 / §7 存储）
 * 数据流：键入 → 块级重渲染（保光标）→ 防抖 htmlToMd → store → 防抖写回源文件 + 缓存。
 * undo/redo 走自持历史栈（上限 200）。
 */
import { defineStore } from 'pinia'
import { tauriAPI, settings } from '@/utils/tauriAPI'
import { parseMarkdown, blocksToMarkdown, blocksText, type Block, type BlockType, genId } from '@/utils/markdown'

const MAX_HISTORY = 200
const SAVE_DEBOUNCE = 800
const HISTORY_DEBOUNCE = 600

function emptyBlocks(): Block[] {
  return [{ id: genId(), type: 'p', html: '' }]
}

export const useDocumentStore = defineStore('document', {
  state: () => ({
    path: null as string | null,
    fileName: '未命名.md',
    markdown: '',
    blocks: [] as Block[],
    dirty: false,
    history: [] as string[],
    historyIndex: -1,
    lastSaved: '',
    savedAt: null as string | null,
    wordCount: 0,
    charCount: 0,
    blockCount: 0,
  }),

  getters: {
    isNew: (s) => !s.path,
    canUndo: (s) => s.historyIndex > 0,
    canRedo: (s) => s.historyIndex < s.history.length - 1,
  },

  actions: {
    /* ── 初始化：恢复缓存 + 监听 open-file ── */
    init() {
      const cached = settings.get<{ path: string | null; md: string } | null>('doc_cache', null)
      if (cached?.md) {
        this.loadContent(cached.md, cached.path, false)
      } else {
        this.blocks = emptyBlocks()
        this.markdown = ''
      }
      this.updateStats()

      tauriAPI.onOpenFile(async ({ path, content }) => {
        await this.openFromPath(path, content)
      })
      tauriAPI.onBeforeClose(async () => {
        await this.flushSave()
      })
    },

    /* ── 载入内容（打开/命令行/恢复缓存共用） ── */
    loadContent(md: string, path: string | null, markSaved = true) {
      this.blocks = parseMarkdown(md)
      this.markdown = md
      this.path = path
      this.fileName = path ? path.split(/[\\/]/).pop() || path : '未命名.md'
      this.lastSaved = md
      this.dirty = false
      this.history = [md]
      this.historyIndex = 0
      this.savedAt = new Date().toISOString()
      this.updateStats()
    },

    async openFromPath(path: string | null, content?: string) {
      let text = content
      if (text == null && path) {
        text = await tauriAPI.readFile(path)
      }
      if (text == null) return
      this.loadContent(text, path ?? null)
      settings.set('doc_cache', { path: this.path, md: this.markdown })
    },

    async newDocument() {
      if (this.dirty) {
        await this.flushSave()
      }
      this.path = null
      this.fileName = '未命名.md'
      this.loadContent('', null)
    },

    /* ── 编辑器输入上报（防抖统一在 Editor 内） ── */
    onBlocksChanged(blocks: Block[]) {
      this.blocks = blocks
      this.markdown = blocksToMarkdown(blocks)
      this.updateStats()
      this.scheduleHistory()
      this.scheduleSave()
    },

    /* ── 强制重渲染入口（撤销/重做/AI 插入/打开） ── */
    applyBlocks(blocks: Block[]) {
      this.blocks = blocks
      this.markdown = blocksToMarkdown(blocks)
      this.updateStats()
      this.scheduleSave()
    },

    updateStats() {
      const text = blocksText(this.blocks)
      this.wordCount = text.split(/\s+/).filter(Boolean).length
      this.charCount = text.length
      this.blockCount = this.blocks.length
    },

    /* ── 历史栈（200） ── */
    scheduleHistory() {
      clearTimeout((this as unknown as { _hTimer?: number })._hTimer)
      const timer = window.setTimeout(() => this.pushHistory(), HISTORY_DEBOUNCE)
      ;(this as unknown as { _hTimer?: number })._hTimer = timer
    },

    pushHistory() {
      const md = this.markdown
      // 与栈顶相同则跳过
      if (this.history[this.historyIndex] === md) return
      // 丢弃重做分支
      this.history = this.history.slice(0, this.historyIndex + 1)
      this.history.push(md)
      if (this.history.length > MAX_HISTORY) this.history.shift()
      this.historyIndex = this.history.length - 1
    },

    undo() {
      if (this.historyIndex <= 0) return
      this.historyIndex--
      this.restoreFromHistory()
    },

    redo() {
      if (this.historyIndex >= this.history.length - 1) return
      this.historyIndex++
      this.restoreFromHistory()
    },

    restoreFromHistory() {
      const md = this.history[this.historyIndex]
      if (md == null) return
      this.applyBlocks(parseMarkdown(md))
      this.dirty = md !== this.lastSaved
    },

    /* ── 保存（§10 零丢失：before-close 落盘 + 编辑防抖双保险） ── */
    _saveTimer: 0 as number | ReturnType<typeof setTimeout>,

    scheduleSave() {
      clearTimeout(this._saveTimer as ReturnType<typeof setTimeout>)
      this._saveTimer = setTimeout(() => void this.flushSave(), SAVE_DEBOUNCE)
      // 缓存立即跟随（崩溃容错）
      settings.set('doc_cache', { path: this.path, md: this.markdown })
    },

    async flushSave(): Promise<boolean> {
      clearTimeout(this._saveTimer as ReturnType<typeof setTimeout>)
      settings.set('doc_cache', { path: this.path, md: this.markdown })
      if (this.path) {
        try {
          await tauriAPI.writeFile(this.path, this.markdown)
          this.lastSaved = this.markdown
          this.dirty = false
          this.savedAt = new Date().toISOString()
          return true
        } catch (err) {
          console.error('[document] 写回失败', err)
          this.dirty = true
          return false
        }
      }
      return false
    },

    /* ── 对话框流（§6.3 打开 / 导出管线） ── */
    async openViaDialog() {
      const res = await tauriAPI.openFileDialog()
      if (!res) return
      await this.openFromPath(res.path, res.content)
    },

    async saveAs() {
      const target = await tauriAPI.saveFileDialog(this.fileName, this.markdown)
      if (!target) return null
      this.path = target
      this.fileName = target.split(/[\\/]/).pop() || target
      await this.flushSave()
      return target
    },

    async save() {
      if (!this.path) return this.saveAs()
      await this.flushSave()
      return this.path
    },

    /* ── AI 插入（§6.2：确认后回编辑器） ── */
    insertTextAtCursor(text: string, cursor: { blockId: string; offset: number } | null) {
      const md = text.trim()
      if (!md) return
      const newBlocks = parseMarkdown(md)
      if (!cursor) {
        // 无光标信息：追加到文末
        this.blocks.push(...newBlocks)
        this.applyBlocks(this.blocks)
        return this.blocks[this.blocks.length - 1]?.id ?? null
      }
      const idx = this.blocks.findIndex((b) => b.id === cursor.blockId)
      if (idx < 0) {
        this.blocks.push(...newBlocks)
        this.applyBlocks(this.blocks)
        return this.blocks[this.blocks.length - 1]?.id ?? null
      }
      const target = this.blocks[idx]
      const insertPos = Math.max(0, Math.min(cursor.offset, (target.html ?? '').length))
      const before = (target.html ?? '').slice(0, insertPos)
      const after = (target.html ?? '').slice(insertPos)
      const head = { ...target, id: genId(), html: before }
      const tail = { ...target, id: genId(), html: after }
      this.blocks.splice(idx, 1, head, ...newBlocks, tail)
      this.applyBlocks(this.blocks)
      return newBlocks[newBlocks.length - 1]?.id ?? tail.id
    },

    replaceSelection(start: { blockId: string; offset: number }, end: { blockId: string; offset: number }, text: string) {
      const md = text.trim()
      const idx = this.blocks.findIndex((b) => b.id === start.blockId)
      if (idx < 0) return null
      const head = { ...this.blocks[idx], id: genId(), html: (this.blocks[idx].html ?? '').slice(0, start.offset) }
      const newBlocks = md ? parseMarkdown(md) : []
      this.blocks.splice(idx, 1, head, ...newBlocks)
      this.applyBlocks(this.blocks)
      return newBlocks[newBlocks.length - 1]?.id ?? head.id
    },

    createBlock(type: BlockType, atIndex?: number): string {
      const b: Block = { id: genId(), type }
      if (type === 'p' || type === 'quote') b.html = ''
      if (type === 'code' || type === 'mermaid') b.code = ''
      if (type === 'ul' || type === 'ol' || type === 'task') b.html = '<li><br/></li>'
      if (type === 'ol') b.start = 1
      const idx = atIndex == null ? this.blocks.length : Math.max(0, Math.min(atIndex, this.blocks.length))
      this.blocks.splice(idx, 0, b)
      this.applyBlocks(this.blocks)
      return b.id
    },

    removeBlock(id: string) {
      const idx = this.blocks.findIndex((b) => b.id === id)
      if (idx < 0) return
      if (this.blocks.length <= 1) {
        this.blocks = emptyBlocks()
      } else {
        this.blocks.splice(idx, 1)
      }
      this.applyBlocks(this.blocks)
    },

    /** 转换当前块类型（工具栏 H1/引用/列表/代码…） */
    convertBlock(id: string, type: BlockType) {
      const idx = this.blocks.findIndex((b) => b.id === id)
      if (idx < 0) return null
      const b = this.blocks[idx]
      const textOf = (h?: string) => (h ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()
      const newB: Block = { ...b, id: genId(), type }
      if (type === 'code') {
        newB.code = textOf(b.html)
        delete newB.html
      } else if (type === 'mermaid') {
        newB.code = textOf(b.html)
        delete newB.html
      } else if (type === 'image') {
        const m = (b.html ?? '').match(/src="([^"]*)"/)
        newB.src = m?.[1] ?? ''
        newB.alt = textOf(b.html)
        delete newB.html
      } else if (type === 'hr') {
        // 空内容分隔块
        delete newB.html
        delete newB.code
      } else if (type === 'ul' || type === 'ol' || type === 'task') {
        newB.html = `<li>${b.html ?? ''}</li>`
        newB.start = type === 'ol' ? 1 : undefined
      } else if (type === 'quote') {
        // 保留 html
      } else {
        // p / 标题：保留 html
      }
      this.blocks.splice(idx, 1, newB)
      this.applyBlocks(this.blocks)
      return newB.id
    },

    /** 合并前一个文本块内容到当前块（Backspace 在块首） */
    mergeWithPrevious(id: string): boolean {
      const idx = this.blocks.findIndex((b) => b.id === id)
      if (idx <= 0) return false
      const cur = this.blocks[idx]
      const prev = this.blocks[idx - 1]
      const textTypes: BlockType[] = ['p', 'quote']
      if (!textTypes.includes(cur.type) || !textTypes.includes(prev.type)) return false
      const joined = { ...prev, id: genId(), html: `${prev.html ?? ''}${cur.html ?? ''}` }
      this.blocks.splice(idx - 1, 2, joined)
      this.applyBlocks(this.blocks)
      return true
    },
  },
})
