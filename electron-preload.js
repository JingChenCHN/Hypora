const { contextBridge, ipcRenderer } = require('electron')

// 是否运行在 Electron 环境
const isElectron = true

contextBridge.exposeInMainWorld('electronAPI', {
  // ===== 菜单动作监听 =====
  onMenuAction: (callback) => ipcRenderer.on('menu-action', (event, action) => callback(action)),
  onOpenFile: (callback) => ipcRenderer.on('open-file', (event, data) => callback(data)),
  // ===== 文件操作 =====
  showSaveDialog: (defaultFilename) => ipcRenderer.invoke('save-dialog', defaultFilename),
  writeFile: (filePath, content, expectedMtimeMs) => ipcRenderer.invoke('write-file', filePath, content, expectedMtimeMs),
  // 外部修改检测：读文档当前内容+mtime；knownMtimeMs 一致时返回 unchanged 免传输内容
  readFileDoc: (filePath, knownMtimeMs) => ipcRenderer.invoke('read-doc-file', filePath, knownMtimeMs),
  writeBinaryFile: (filePath, base64) => ipcRenderer.invoke('write-binary-file', filePath, base64),
  // 图片文件模式：图片落盘文档同目录 assets/（返回绝对+相对路径）；同步文档目录供协议收敛读取范围
  writeDocAsset: (payload) => ipcRenderer.invoke('write-doc-asset', payload),
  setDocBaseDir: (dir) => ipcRenderer.invoke('set-doc-base-dir', dir),
  // 原生导出 PDF（printToPDF 矢量输出，主进程直接落盘）
  printToPDF: (defaultFilename) => ipcRenderer.invoke('print-to-pdf', defaultFilename),
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  registerFileAssociation: () => ipcRenderer.invoke('register-file-association'),
  unregisterFileAssociation: () => ipcRenderer.invoke('unregister-file-association'),
  // ===== 窗口控制（macOS 风格交通灯）=====
  winMinimize: () => ipcRenderer.invoke('win-minimize'),
  winMaximizeToggle: () => ipcRenderer.invoke('win-maximize-toggle'),
  winClose: () => ipcRenderer.invoke('win-close'),
  winIsMaximized: () => ipcRenderer.invoke('win-is-maximized'),
  onMaximizedChange: (callback) => ipcRenderer.on('win-maximized', (event, isMax) => callback(isMax)),
  // ===== 窗口置顶（always-on-top）=====
  winToggleAlwaysOnTop: () => ipcRenderer.invoke('win-toggle-always-on-top'),
  winIsAlwaysOnTop: () => ipcRenderer.invoke('win-is-always-on-top'),
  onAlwaysOnTopChange: (callback) => ipcRenderer.on('win-always-on-top', (event, isOnTop) => callback(isOnTop)),
  // ===== 内置本地助手（llama.cpp 引擎，主进程托管）=====
  aiEngineStatus: () => ipcRenderer.invoke('ai-engine:get-status'),
  aiEngineStart: () => ipcRenderer.invoke('ai-engine:start'),
  aiEngineStop: () => ipcRenderer.invoke('ai-engine:stop'),
  aiEngineConfig: () => ipcRenderer.invoke('ai-engine:get-config'),
  aiEngineDownload: (modelName) => ipcRenderer.invoke('ai-engine:download', modelName),
  aiEngineDownloadCancel: () => ipcRenderer.invoke('ai-engine:download-cancel'),
  aiEngineSetModel: (modelName) => ipcRenderer.invoke('ai-engine:set-model', modelName),
  aiEngineOpenModelsDir: () => ipcRenderer.invoke('ai-engine:open-models-dir'),
  // 订阅主进程状态推送；返回取消订阅函数（面板重挂载时防重复监听）
  onAiEngineStatus: (callback) => {
    const listener = (_e, payload) => callback(payload)
    ipcRenderer.on('ai-engine-status', listener)
    return () => ipcRenderer.removeListener('ai-engine-status', listener)
  },
  onAiEngineDownloadProgress: (callback) => {
    const listener = (_e, payload) => callback(payload)
    ipcRenderer.on('ai-engine-download', listener)
    return () => ipcRenderer.removeListener('ai-engine-download', listener)
  },
  // ===== 知识库（本地 RAG v2：多知识库，主进程托管嵌入服务 + 分库向量索引）=====
  kbConfig: () => ipcRenderer.invoke('kb:get-config'),
  kbSetConfig: (patch) => ipcRenderer.invoke('kb:set-config', patch),
  kbCreate: (name) => ipcRenderer.invoke('kb:create', name),
  kbRename: (kbId, name) => ipcRenderer.invoke('kb:rename', kbId, name),
  kbDelete: (kbId) => ipcRenderer.invoke('kb:delete', kbId),
  kbSetKb: (kbId, patch) => ipcRenderer.invoke('kb:set-kb', kbId, patch),
  kbPickModel: () => ipcRenderer.invoke('kb:pick-model'),
  kbSetModel: (modelPath) => ipcRenderer.invoke('kb:set-model', modelPath),
  kbPickMmproj: () => ipcRenderer.invoke('kb:pick-mmproj'),
  kbSetMmproj: (p) => ipcRenderer.invoke('kb:set-mmproj', p),
  kbAddSource: (kbId) => ipcRenderer.invoke('kb:add-source', kbId),
  kbRemoveSource: (kbId, dir) => ipcRenderer.invoke('kb:remove-source', kbId, dir),
  kbReindex: (opts) => ipcRenderer.invoke('kb:reindex', opts),
  kbCancelIndex: () => ipcRenderer.invoke('kb:cancel-index'),
  kbQuery: (text, topK) => ipcRenderer.invoke('kb:query', text, topK),
  kbOpenIndexDir: (kbId) => ipcRenderer.invoke('kb:open-index-dir', kbId),
  // 订阅推送；返回取消订阅函数
  onKbStatus: (callback) => {
    const listener = (_e, payload) => callback(payload)
    ipcRenderer.on('kb-status', listener)
    return () => ipcRenderer.removeListener('kb-status', listener)
  },
  onKbProgress: (callback) => {
    const listener = (_e, payload) => callback(payload)
    ipcRenderer.on('kb-progress', listener)
    return () => ipcRenderer.removeListener('kb-progress', listener)
  },
  // ===== 开发者模式 =====
  isElectron,
  dev: {
    toggleDevTools: () => ipcRenderer.invoke('dev:toggle-devtools'),
    openDevTools: () => ipcRenderer.invoke('dev:open-devtools'),
    reload: (ignoreCache = false) => ipcRenderer.invoke('dev:reload', ignoreCache),
    getStatus: () => ipcRenderer.invoke('dev:get-status'),
    setDevMode: (enabled) => ipcRenderer.invoke('dev:set-devmode', enabled),
    log: (level, message) => ipcRenderer.invoke('dev:log', level, message),
    exportDiagnostics: () => ipcRenderer.invoke('dev:export-diagnostics'),
    showLogFile: () => ipcRenderer.invoke('dev:show-log-file'),
    openExternal: (url) => ipcRenderer.invoke('dev:open-external', url)
  }
})