import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { ElNotification } from 'element-plus'

export type DocumentKind = 'markdown' | 'pdf'

export interface Document {
  id: string
  title: string
  content: string
  createTime: number
  updateTime: number
  isSaved: boolean
  filePath?: string  // 打开的本地文件路径，Ctrl+S 时写回该文件
  kind?: DocumentKind  // 缺省视为 markdown；pdf 文档为只读预览（字节存会话内存，不进缓存）
}

// PDF 文件的二进制（base64）：模块级非响应式 Map，绝不进 localStorage（~5MB 配额）、
// 绝不写入 content 字段（会流经渲染链路）、绝不写回源文件。会话结束即丢弃。
const pdfBytes = new Map<string, string>()

export const useDocumentStore = defineStore('document', () => {
  // 首次启动的欢迎引导内容
  const WELCOME_CONTENT = `# 欢迎使用 Hypora

这是一款对标 Typora 的在线 Markdown 编辑器，所见即所得，实时渲染。

## 功能特性

- ✅ 所见即所得实时编辑
- ✅ Markdown 全语法支持
- ✅ LaTeX 数学公式
- ✅ Mermaid 流程图
- ✅ 多主题切换
- ✅ 本地自动保存
- ✅ 导出 PDF/HTML/Markdown

### 代码示例

\`\`\`javascript
console.log("Hello Hypora!")
\`\`\`

### 数学公式

$$E=mc^2$$

### 任务列表

- [x] 完成基础编辑功能
- [x] 支持语法高亮
- [ ] 多人协作功能

### 分割线样式

行内只写标记：\`---\` 实线 · \`***\` 虚线 · \`___\` 双实线；标记后加关键词可换更多风格：
\`--- wavy\` 波浪 · \`--- dotted\` 点线 · \`--- thick\` 粗实线（也可用中文：波浪 / 点线 / 粗实线）。

开始输入你的内容吧！`

  // 所有文档
  const documents = ref<Document[]>([])
  // 当前激活文档ID
  const activeDocId = ref<string>('')
  // 是否源码模式
  const isSourceMode = ref(false)
  // 是否全屏模式
  const isFullscreen = ref(false)
  // 侧边栏显示状态
  const sidebarVisible = ref(true)
  // 打字机模式（当前行居中）
  const typewriterMode = ref(false)
  // 焦点模式（其他段落变淡）
  const focusMode = ref(false)
  // 当前主题
  const currentTheme = ref('light')
  // 自动保存状态
  const autoSave = ref(true)

  // ===== PDF 阅读视图状态（session-only，供 Statusbar 与 PdfViewer 共享）=====
  const pdfPage = ref(0)
  const pdfTotalPages = ref(0)
  const pdfZoom = ref(100)
  const pdfFitWidth = ref(true)
  function resetPdfViewState() {
    pdfPage.value = 0
    pdfTotalPages.value = 0
    pdfZoom.value = 100
    pdfFitWidth.value = true
  }

  // 当前激活文档
  const activeDocument = computed(() => {
    return documents.value.find(doc => doc.id === activeDocId.value)
  })

  // 当前激活文档是否为 PDF（只读预览）
  const isPdfActive = computed(() => activeDocument.value?.kind === 'pdf')

  // 初始化 - 从本地存储加载文档
  function init() {
    const savedDocs = localStorage.getItem('hypora_documents')
    const savedActiveId = localStorage.getItem('hypora_active_doc')
    const savedTheme = localStorage.getItem('hypora_theme')
    const savedAutoSave = localStorage.getItem('hypora_autosave')
    const savedSidebar = localStorage.getItem('hypora_sidebar')
    const savedTypewriter = localStorage.getItem('hypora_typewriter')
    const savedFocus = localStorage.getItem('hypora_focus')

    if (savedTheme) {
      currentTheme.value = savedTheme
      document.documentElement.setAttribute('data-theme', savedTheme)
    }
    if (savedAutoSave !== null) {
      autoSave.value = savedAutoSave === 'true'
    }
    if (savedSidebar !== null) {
      sidebarVisible.value = savedSidebar === 'true'
    }
    if (savedTypewriter !== null) {
      typewriterMode.value = savedTypewriter === 'true'
    }
    if (savedFocus !== null) {
      focusMode.value = savedFocus === 'true'
    }

    if (savedDocs) {
      // 防御性过滤：PDF 文档只存在会话内存，不应出现在缓存里（正常不会命中）
      documents.value = (JSON.parse(savedDocs) as Document[]).filter(d => d.kind !== 'pdf')
      if (savedActiveId && documents.value.some(d => d.id === savedActiveId)) {
        activeDocId.value = savedActiveId
      } else if (documents.value.length > 0) {
        activeDocId.value = documents.value[0].id
      } else {
        newDocument('欢迎使用 Hypora', WELCOME_CONTENT)
      }
    } else {
      newDocument('欢迎使用 Hypora', WELCOME_CONTENT)
    }
  }

  // 新建文档（content 默认空白；首次启动可传入欢迎引导内容）
  function newDocument(title = '未命名文档', content = '') {
    const id = `${Date.now()}${Math.floor(Math.random() * 1000)}`
    const newDoc: Document = {
      id,
      title,
      content,
      createTime: Date.now(),
      updateTime: Date.now(),
      isSaved: true
    }
    documents.value.push(newDoc)
    activeDocId.value = id
    resetPdfViewState()
    saveToLocal()
    return id
  }

  // 更新文档内容
  function updateContent(content: string) {
    const doc = activeDocument.value
    if (!doc) return
    if (doc.kind === 'pdf') return  // PDF 只读，内容更新无效
    doc.content = content
    doc.updateTime = Date.now()
    doc.isSaved = false

    // 自动提取标题
    const titleMatch = content.match(/^#\s+(.+)$/m)
    if (titleMatch) {
      doc.title = titleMatch[1].trim()
    }

    if (autoSave.value) {
      debounceSave()
    }
  }

  // 保存到本地存储
  let saveTimer: number | null = null
  function debounceSave(delay = 1000) {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      saveToLocal()
    }, delay)
  }

  // 未能写入浏览器离线缓存的文档（配额超限降级淘汰），供列表标「未缓存」
  const unpersistedIds = ref<Set<string>>(new Set())
  let lastUnpersistedKey = ''

  // 记录降级结果；同一批文档只在首次打扰用户（每次编辑触发的自动保存都会走到这里）
  function setUnpersisted(persisted: Set<string>) {
    // PDF 文档本就不参与缓存，不计入「未缓存」名单（避免无意义的配额警告）
    const miss = documents.value.filter(d => !persisted.has(d.id) && d.kind !== 'pdf')
    unpersistedIds.value = new Set(miss.map(d => d.id))
    if (miss.length === 0) { lastUnpersistedKey = ''; return }
    const key = unpersistedIds.value.size + ':' + [...unpersistedIds.value].sort().join(',')
    if (key === lastUnpersistedKey) return
    lastUnpersistedKey = key
    console.warn('[hypora] 离线缓存空间不足，未能写入缓存的文档：', miss.map(d => d.title))
    const names = miss.slice(0, 3).map(d => d.title || '未命名').join('」「')
    ElNotification({
      title: '离线缓存空间不足',
      message: `「${names}」${miss.length > 3 ? `等 ${miss.length} 个文档` : ''}未能写入浏览器缓存（多因图片过大）。请 Ctrl+S 下载 .md，或「文件 → 保存 → 保存到云端」。`,
      type: 'warning',
      duration: 8000
    })
  }

  function saveToLocal() {
    const doc = activeDocument.value
    if (doc) {
      doc.isSaved = true
      // 若有源文件路径且在 Electron 环境，自动保存时同步写回原文件（避免"假保存"）
      // PDF 文档为只读预览（content 为空字符串），绝不写回——否则会把源 PDF 覆写为 0 字节
      const electronAPI = (window as any).electronAPI
      if (doc.kind !== 'pdf' && doc.filePath && electronAPI?.writeFile) {
        electronAPI.writeFile(doc.filePath, doc.content).catch(() => {})
      }
    }
    // localStorage 持久化（容错：文档列表可能含大图 base64，超出 ~5MB 配额）
    // PDF 文档只存会话内存（字节在 pdfBytes Map），不进缓存，否则会打爆配额并挤掉其他文档
    const persistable = documents.value.filter(d => d.kind !== 'pdf')
    let persisted = new Set<string>()
    try {
      localStorage.setItem('hypora_documents', JSON.stringify(persistable))
      persisted = new Set(persistable.map(d => d.id))
    } catch {
      // 全量超配额：按内容体积从大到小逐个淘汰（当前编辑文档最后才考虑），保住其余文档
      const sorted = [...persistable].sort((a, b) => (b.content?.length || 0) - (a.content?.length || 0))
      let list = persistable.slice()
      let ok = false
      for (const victim of sorted) {
        if (list.length <= 1) break
        if (doc && victim.id === doc.id) continue
        list = list.filter(d => d.id !== victim.id)
        try {
          localStorage.setItem('hypora_documents', JSON.stringify(list))
          persisted = new Set(list.map(d => d.id))
          ok = true
          break
        } catch { /* 仍放不下，继续淘汰 */ }
      }
      if (!ok) {
        // 兜底：当前文档单独放不下时，还要试着保住其余较小文档（内容仍在内存与已下载的 .md 中）
        persisted = new Set()
        const fallbacks: any[][] = []
        if (doc && doc.kind !== 'pdf') fallbacks.push([doc])
        const others = documents.value.filter(d => (!doc || d.id !== doc.id) && d.kind !== 'pdf')
        if (others.length) fallbacks.push(others)
        for (const fl of fallbacks) {
          try {
            localStorage.setItem('hypora_documents', JSON.stringify(fl))
            persisted = new Set(fl.map(d => d.id))
            break
          } catch { /* 下一个兜底 */ }
        }
      }
      setUnpersisted(persisted)
    }
    // 小 key 与文档列表分离落盘：此前在同一 try 里，大图撑爆配额时主题/侧栏等设置也一并丢失
    try {
      localStorage.setItem('hypora_active_doc', activeDocId.value)
      localStorage.setItem('hypora_theme', currentTheme.value)
      localStorage.setItem('hypora_autosave', String(autoSave.value))
      localStorage.setItem('hypora_sidebar', String(sidebarVisible.value))
      localStorage.setItem('hypora_typewriter', String(typewriterMode.value))
      localStorage.setItem('hypora_focus', String(focusMode.value))
    } catch { /* 忽略：小 key 理论上不会超限 */ }
    if (persisted.size === persistable.length && unpersistedIds.value.size > 0) {
      unpersistedIds.value = new Set()
      lastUnpersistedKey = ''
    }
  }

  // 切换编辑焦点时复位 PDF 阅读视图状态
  function switchDocument(id: string) {
    activeDocId.value = id
    resetPdfViewState()
    saveToLocal()
  }

  // ===== 离线备份（误删恢复）：删除的文档先移入本浏览器备份池 =====
  // 只存 localStorage（不上云），上限 30 条，超出淘汰最旧；配额溢出时只留最近 3 条
  const BACKUP_KEY = 'hypora_doc_backup'
  const BACKUP_MAX = 30

  interface BackupDoc extends Document {
    deletedAt: number
  }

  function readBackup(): BackupDoc[] {
    try {
      const list = JSON.parse(localStorage.getItem(BACKUP_KEY) || '[]')
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  function saveBackup(list: BackupDoc[]) {
    try {
      localStorage.setItem(BACKUP_KEY, JSON.stringify(list))
    } catch {
      // 配额溢出（大图 base64）：只保留最近 3 条再试一次
      try { localStorage.setItem(BACKUP_KEY, JSON.stringify(list.slice(0, 3))) } catch {}
    }
  }

  function backupDocument(doc: Document) {
    const list = readBackup()
    list.unshift({ ...doc, deletedAt: Date.now() })
    saveBackup(list.slice(0, BACKUP_MAX))
  }

  function getBackupDocs(): BackupDoc[] {
    return readBackup()
  }

  // 备份池恢复结果：PDF 文档字节只存会话内存，恢复无意义，需向调用方区分提示
  interface BackupRestoreResult {
    ok: boolean
    pdfSessionOnly?: boolean
  }

  function restoreFromBackup(id: string): BackupRestoreResult {
    const list = readBackup()
    const idx = list.findIndex(d => d.id === id)
    if (idx === -1) return { ok: false }
    const doc = list[idx]
    if (doc.kind === 'pdf') {
      list.splice(idx, 1)
      saveBackup(list)
      return { ok: false, pdfSessionOnly: true }
    }
    if (!documents.value.some(d => d.id === doc.id)) {
      documents.value.push({
        id: doc.id, title: doc.title, content: doc.content,
        createTime: doc.createTime, updateTime: doc.updateTime, isSaved: doc.isSaved, filePath: doc.filePath
      })
    }
    list.splice(idx, 1)
    saveBackup(list)
    activeDocId.value = doc.id
    saveToLocal()
    return { ok: true }
  }

  function purgeBackup(id: string) {
    saveBackup(readBackup().filter(d => d.id !== id))
  }

  function clearBackup() {
    saveBackup([])
  }

  // ===== 离线缓存（localStorage 真正落盘的版本）查看 =====
  const DOCS_KEY = 'hypora_documents'

  // 读取 localStorage 原始缓存（可能与内存中未保存的编辑不同步）
  function getCachedDocs(): Document[] {
    try {
      const list = JSON.parse(localStorage.getItem(DOCS_KEY) || '[]')
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  // 缓存中的文档不在当前列表时（如内存态丢失），从缓存恢复并打开
  function restoreFromCache(id: string): boolean {
    const cached = getCachedDocs().find(d => d.id === id)
    if (!cached) return false
    if (!documents.value.some(d => d.id === id)) {
      documents.value.push({ ...cached })
    }
    activeDocId.value = id
    saveToLocal()
    return true
  }

  // 删除文档
  function deleteDocument(id: string) {
    const index = documents.value.findIndex(d => d.id === id)
    if (index > -1) {
      // 先移入离线备份池（误删可从「文件 → 打开 → 从备份中打开」恢复）
      const doc = documents.value[index]
      if (doc) backupDocument(doc)
      documents.value.splice(index, 1)
      // PDF 文档删除时同步丢弃会话字节，防止内存滞留
      pdfBytes.delete(id)
      if (activeDocId.value === id) {
        if (documents.value.length > 0) {
          activeDocId.value = documents.value[Math.min(index, documents.value.length - 1)].id
        } else {
          newDocument()
        }
      }
      saveToLocal()
    }
  }

  // 切换源码模式：进入时收起侧边栏（记住原状态），退出时还原
  // PDF 文档为只读预览，无源码形态——单点拦截 Ctrl+/ / 菜单 / 右键菜单等所有入口
  let sidebarVisibleBeforeSource = true
  function toggleSourceMode() {
    if (activeDocument.value?.kind === 'pdf') return
    if (!isSourceMode.value) {
      sidebarVisibleBeforeSource = sidebarVisible.value
      sidebarVisible.value = false
      isSourceMode.value = true
    } else {
      isSourceMode.value = false
      sidebarVisible.value = sidebarVisibleBeforeSource
    }
  }

  // 切换全屏
  function toggleFullscreen() {
    isFullscreen.value = !isFullscreen.value
    if (isFullscreen.value) {
      document.documentElement.requestFullscreen?.()
    } else {
      document.exitFullscreen?.()
    }
  }

  // 切换打字机模式
  function toggleTypewriter() {
    typewriterMode.value = !typewriterMode.value
    saveToLocal()
  }

  // 切换焦点模式
  function toggleFocus() {
    focusMode.value = !focusMode.value
    saveToLocal()
  }

  // 切换侧边栏
  function toggleSidebar() {
    sidebarVisible.value = !sidebarVisible.value
    saveToLocal()
  }

  // 切换主题
  function setTheme(theme: string) {
    currentTheme.value = theme
    document.documentElement.setAttribute('data-theme', theme)
    saveToLocal()
  }

  // 重命名文档
  function renameDocument(id: string, title: string) {
    const doc = documents.value.find(d => d.id === id)
    if (doc) {
      doc.title = title
      saveToLocal()
    }
  }

  // 导入文档
  function importDocument(title: string, content: string, filePath?: string) {
    const id = `${Date.now()}${Math.floor(Math.random() * 1000)}`
    const newDoc: Document = {
      id,
      title,
      content,
      createTime: Date.now(),
      updateTime: Date.now(),
      isSaved: true,
      filePath
    }
    documents.value.push(newDoc)
    activeDocId.value = id
    resetPdfViewState()
    saveToLocal()
    return id
  }

  // 导入 PDF 文档：字节存会话内存 Map，文档记录只带元信息（content 留空），只读预览
  function importPdfDocument(title: string, base64: string, filePath?: string) {
    const id = `${Date.now()}${Math.floor(Math.random() * 1000)}`
    const newDoc: Document = {
      id,
      title,
      content: '',
      createTime: Date.now(),
      updateTime: Date.now(),
      isSaved: true,
      filePath,
      kind: 'pdf'
    }
    pdfBytes.set(id, base64)
    documents.value.push(newDoc)
    activeDocId.value = id
    resetPdfViewState()
    saveToLocal()
    return id
  }

  // 取 PDF 会话字节（base64）；非 PDF 或已失效返回 undefined
  function getPdfBase64(id: string): string | undefined {
    return pdfBytes.get(id)
  }

  return {
    documents,
    activeDocId,
    activeDocument,
    unpersistedIds,
    isSourceMode,
    isFullscreen,
    typewriterMode,
    focusMode,
    sidebarVisible,
    currentTheme,
    autoSave,
    init,
    newDocument,
    updateContent,
    saveToLocal,
    switchDocument,
    deleteDocument,
    getBackupDocs,
    restoreFromBackup,
    purgeBackup,
    clearBackup,
    getCachedDocs,
    restoreFromCache,
    toggleSourceMode,
    toggleFullscreen,
    toggleTypewriter,
    toggleFocus,
    toggleSidebar,
    setTheme,
    renameDocument,
    importDocument,
    importPdfDocument,
    getPdfBase64,
    isPdfActive,
    pdfPage,
    pdfTotalPages,
    pdfZoom,
    pdfFitWidth
  }
})