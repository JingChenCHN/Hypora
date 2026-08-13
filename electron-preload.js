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