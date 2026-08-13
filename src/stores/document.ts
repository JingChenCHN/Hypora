import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface Document {
  id: string
  title: string
  content: string
  createTime: number
  updateTime: number
  isSaved: boolean
  filePath?: string  // 打开的本地文件路径，Ctrl+S 时写回该文件
}

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

  // 当前激活文档
  const activeDocument = computed(() => {
    return documents.value.find(doc => doc.id === activeDocId.value)
  })

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
      documents.value = JSON.parse(savedDocs)
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
    saveToLocal()
    return id
  }

  // 更新文档内容
  function updateContent(content: string) {
    const doc = activeDocument.value
    if (!doc) return
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

  function saveToLocal() {
    const doc = activeDocument.value
    if (doc) {
      doc.isSaved = true
      // 若有源文件路径且在 Electron 环境，自动保存时同步写回原文件（避免"假保存"）
      const electronAPI = (window as any).electronAPI
      if (doc.filePath && electronAPI?.writeFile) {
        electronAPI.writeFile(doc.filePath, doc.content).catch(() => {})
      }
    }
    // localStorage 持久化（容错：含大图片base64可能溢出5MB，但文件已写回）
    try {
      localStorage.setItem('hypora_documents', JSON.stringify(documents.value))
      localStorage.setItem('hypora_active_doc', activeDocId.value)
      localStorage.setItem('hypora_theme', currentTheme.value)
      localStorage.setItem('hypora_autosave', String(autoSave.value))
      localStorage.setItem('hypora_sidebar', String(sidebarVisible.value))
      localStorage.setItem('hypora_typewriter', String(typewriterMode.value))
      localStorage.setItem('hypora_focus', String(focusMode.value))
    } catch (e) {
      console.warn('localStorage 持久化失败（可能含大图片），文档已写回文件', e)
    }
  }

  // 切换文档
  function switchDocument(id: string) {
    activeDocId.value = id
    saveToLocal()
  }

  // 删除文档
  function deleteDocument(id: string) {
    const index = documents.value.findIndex(d => d.id === id)
    if (index > -1) {
      documents.value.splice(index, 1)
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

  // 切换源码模式
  function toggleSourceMode() {
    isSourceMode.value = !isSourceMode.value
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
    saveToLocal()
    return id
  }

  return {
    documents,
    activeDocId,
    activeDocument,
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
    toggleSourceMode,
    toggleFullscreen,
    toggleTypewriter,
    toggleFocus,
    toggleSidebar,
    setTheme,
    renameDocument,
    importDocument
  }
})