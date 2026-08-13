// 编辑器配置
export const editorConfig = {
  // 支持的语言列表
  languages: [
    'javascript', 'typescript', 'python', 'java', 'go', 'c', 'cpp', 'csharp',
    'ruby', 'php', 'swift', 'kotlin', 'rust', 'sql', 'html', 'css', 'scss',
    'json', 'yaml', 'xml', 'shell', 'bash', 'markdown', 'plaintext'
  ],
  // 快捷键映射
  shortcuts: {
    save: { key: 'ctrl+s', action: 'save' },
    bold: { key: 'ctrl+b', action: 'bold' },
    italic: { key: 'ctrl+i', action: 'italic' },
    underline: { key: 'ctrl+u', action: 'underline' },
    strikethrough: { key: 'ctrl+shift+s', action: 'strikethrough' },
    highlight: { key: 'ctrl+h', action: 'highlight' },
    code: { key: 'ctrl+`', action: 'code' },
    codeBlock: { key: 'ctrl+shift+`', action: 'codeBlock' },
    h1: { key: 'ctrl+1', action: 'h1' },
    h2: { key: 'ctrl+2', action: 'h2' },
    h3: { key: 'ctrl+3', action: 'h3' },
    h4: { key: 'ctrl+4', action: 'h4' },
    link: { key: 'ctrl+k', action: 'link' },
    image: { key: 'ctrl+g', action: 'image' },
    table: { key: 'ctrl+t', action: 'table' },
    ul: { key: 'ctrl+shift+u', action: 'ul' },
    ol: { key: 'ctrl+shift+o', action: 'ol' },
    task: { key: 'ctrl+shift+x', action: 'task' },
    quote: { key: 'ctrl+q', action: 'quote' },
    sourceMode: { key: 'ctrl+/', action: 'sourceMode' },
    fullscreen: { key: 'f11', action: 'fullscreen' },
    search: { key: 'ctrl+f', action: 'search' }
  },
  // 主题列表
  themes: [
    { id: 'light', name: '浅色白', primary: '#ffffff', text: '#333333' },
    { id: 'dark', name: '暗色黑', primary: '#1e1e1e', text: '#e0e0e0' },
    { id: 'beige', name: '米色护眼', primary: '#f5f0e6', text: '#3b3b3b' },
    { id: 'gray', name: '极简灰', primary: '#f8f9fa', text: '#212529' },
    { id: 'ice', name: '冰雪', primary: '#F0F7FA', text: '#2C5F7A' }
  ],
  // 字体选项
  fonts: [
    { id: 'system', name: '系统默认', value: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
    { id: 'yahei', name: '微软雅黑', value: '"Microsoft YaHei", sans-serif' },
    { id: 'songti', name: '宋体', value: 'SimSun, serif' },
    { id: 'kaiti', name: '楷体', value: 'KaiTi, serif' },
    { id: 'mono', name: '等宽字体', value: '"JetBrains Mono", Consolas, Monaco, monospace' }
  ],
  // 字号选项
  fontSizes: [12, 14, 16, 18, 20, 22, 24],
  // 行高选项
  lineHeights: [1.2, 1.4, 1.6, 1.8, 2.0, 2.2],
  // 边距选项
  margins: [0, 20, 40, 60, 80, 100]
}

// 自动保存间隔(ms)
export const AUTO_SAVE_DELAY = 1000

// 本地存储key
export const STORAGE_KEYS = {
  DOCUMENTS: 'hypora_documents',
  ACTIVE_DOC: 'hypora_active_doc',
  THEME: 'hypora_theme',
  FONT: 'hypora_font',
  FONT_SIZE: 'hypora_font_size',
  LINE_HEIGHT: 'hypora_line_height',
  MARGIN: 'hypora_margin',
  AUTOSAVE: 'hypora_autosave',
  SIDEBAR: 'hypora_sidebar'
}