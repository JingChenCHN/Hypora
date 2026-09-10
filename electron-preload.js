const { contextBridge, ipcRenderer } = require('electron')

// 是否运行在 Electron 环境
const isElectron = true

contextBridge.exposeInMainWorld('electronAPI', {
  // ===== 菜单动作监听 =====
  onMenuAction: (callback) => ipcRenderer.on('menu-action', (event, action) => callback(action)),
  onOpenFile: (callback) => ipcRenderer.on('open-file', (event, data) => callback(data)),
  // ===== 文件操作 =====
  showSaveDialog: (defaultFilename) => ipcRenderer.invoke('save-dialog', defaultFilename),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  writeBinaryFile: (filePath, base64) => ipcRenderer.invoke('write-binary-file', filePath, base64),
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