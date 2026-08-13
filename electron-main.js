const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execSync } = require('child_process')

const isDev = process.env.NODE_ENV === 'development'

// 设置 AppUserModelId，让 Windows 任务栏/窗口预览/跳转列表显示 Hypora 而非 Electron
app.setAppUserModelId('com.hypora.app')

let mainWindow

// ============ 日志系统 ============
const userDataPath = app.getPath('userData')
const logsDir = path.join(userDataPath, 'logs')
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true })
const logFile = path.join(logsDir, `app-${getDateStr()}.log`)

function getDateStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function writeLog(level, source, message) {
  const time = new Date().toISOString()
  const line = `[${time}] [${level}] [${source}] ${message}\n`
  try {
    fs.appendFileSync(logFile, line)
  } catch (e) { /* 忽略写入失败 */ }
  if (isDev) console.log(line.trim())
}

// 应用级日志（主进程）
function appLog(level, message) {
  writeLog(level, 'main', message)
}

// 捕获主进程未处理异常
process.on('uncaughtException', (err) => {
  appLog('ERROR', `UncaughtException: ${err.stack || err.message}`)
})
process.on('unhandledRejection', (reason) => {
  appLog('ERROR', `UnhandledRejection: ${reason}`)
})

// 开发者模式开关（持久化到 userData）
const devModeFile = path.join(userDataPath, 'dev-mode.json')
function isDevMode() {
  try {
    return JSON.parse(fs.readFileSync(devModeFile, 'utf-8')).enabled === true
  } catch { return false }
}
function setDevMode(enabled) {
  try {
    fs.writeFileSync(devModeFile, JSON.stringify({ enabled }, null, 2))
  } catch (e) { appLog('ERROR', `保存开发者模式失败: ${e.message}`) }
}

// ============ 打开本地文件 ============
async function openLocalFile() {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'Markdown文件', extensions: ['md', 'markdown'] }, { name: '所有文件', extensions: ['*'] }],
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) return { success: false, canceled: true }
  try {
    const filePath = result.filePaths[0]
    const content = fs.readFileSync(filePath, 'utf-8')
    const title = path.basename(filePath, path.extname(filePath))
    mainWindow.webContents.send('open-file', { title, content, filePath })
    appLog('INFO', `打开文件: ${filePath}`)
    return { success: true, filePath }
  } catch (e) {
    appLog('ERROR', `打开文件失败: ${e.message}`)
    return { success: false, error: e.message }
  }
}

// 从命令行参数提取 .md/.markdown 文件路径（双击文件打开时）
function getFileFromArgv(argv) {
  const args = argv || process.argv
  for (let i = 1; i < args.length; i++) {
    const a = String(args[i])
    if (/\.md$/i.test(a) || /\.markdown$/i.test(a)) return a
  }
  return null
}

// 按路径打开文件（命令行参数 / 双击文件触发）
async function openFilePath(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const title = path.basename(filePath, path.extname(filePath))
    mainWindow.webContents.send('open-file', { title, content, filePath })
    appLog('INFO', `通过参数打开文件: ${filePath}`)
  } catch (e) {
    appLog('ERROR', `打开文件失败: ${e.message}`)
  }
}

// 关联 .md 文件到 Hypora（写 HKCU 注册表，无需管理员）
// 生成 .reg 文件内容（路径反斜杠转义为 \\，引号转义为 \"）
function buildAssocReg(exePath) {
  const e = exePath.replace(/\\/g, '\\\\')  // .reg 里 \ 转 \\
  const openCmd = `\\"${e}\\" \\"%1\\"`     // "exe" "%1"
  const icon = `${e},0`
  return [
    'Windows Registry Editor Version 5.00',
    '',
    '[HKEY_CURRENT_USER\\Software\\Classes\\.md]',
    '@="Hypora.md"',
    '',
    '[HKEY_CURRENT_USER\\Software\\Classes\\Hypora.md]',
    '@="Hypora"',
    '',
    '[HKEY_CURRENT_USER\\Software\\Classes\\Hypora.md\\DefaultIcon]',
    `@="${icon}"`,
    '',
    '[HKEY_CURRENT_USER\\Software\\Classes\\Hypora.md\\shell\\open\\command]',
    `@="${openCmd}"`,
    '',
    '[HKEY_CURRENT_USER\\Software\\Classes\\SystemFileAssociations\\.md\\shell\\Hypora]',
    '@="用 Hypora 打开"',
    '',
    '[HKEY_CURRENT_USER\\Software\\Classes\\SystemFileAssociations\\.md\\shell\\Hypora\\command]',
    `@="${openCmd}"`,
    '',
    '[HKEY_CURRENT_USER\\Software\\Classes\\Applications\\Hypora.exe]',
    '@="Hypora"',
    '"FriendlyAppName"="Hypora"',
    '',
    '[HKEY_CURRENT_USER\\Software\\Classes\\Applications\\Hypora.exe\\shell\\open\\command]',
    `@="${openCmd}"`,
    ''
  ].join('\r\n')
}

function registerFileAssociation() {
  const exePath = process.execPath
  const regFile = path.join(os.tmpdir(), 'hypora-assoc.reg')
  try {
    // UTF-16LE with BOM（Windows regedit 对中文值的最可靠编码）
    const content = buildAssocReg(exePath)
    const buf = Buffer.from('﻿' + content, 'utf16le')
    fs.writeFileSync(regFile, buf)
    execSync(`reg import "${regFile}"`, { stdio: 'ignore' })
  } catch (e) {
    appLog('ERROR', `关联失败: ${e.message}`)
    try { fs.unlinkSync(regFile) } catch {}
    return { success: false, error: e.message }
  }
  try { fs.unlinkSync(regFile) } catch {}
  appLog('INFO', `已关联.md文件到 ${exePath}`)
  return { success: true, exePath }
}

function unregisterFileAssociation() {
  const regFile = path.join(os.tmpdir(), 'hypora-unassoc.reg')
  try {
    const content = [
      'Windows Registry Editor Version 5.00',
      '',
      '[-HKEY_CURRENT_USER\\Software\\Classes\\Hypora.md]',
      '',
      '[-HKEY_CURRENT_USER\\Software\\Classes\\SystemFileAssociations\\.md\\shell\\Hypora]',
      '',
      '[-HKEY_CURRENT_USER\\Software\\Classes\\Applications\\Hypora.exe]',
      ''
    ].join('\r\n')
    fs.writeFileSync(regFile, Buffer.from('﻿' + content, 'utf16le'))
    execSync(`reg import "${regFile}"`, { stdio: 'ignore' })
  } catch (e) {
    appLog('ERROR', `取消关联失败: ${e.message}`)
  }
  try { fs.unlinkSync(regFile) } catch {}
  appLog('INFO', '已取消.md文件关联')
  return { success: true }
}

// ============ 窗口创建 ============
function createWindow() {
  const devMode = isDevMode()

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Hypora - Markdown编辑器',
    icon: path.join(__dirname, isDev ? 'public/favicon.ico' : 'dist/favicon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      webSecurity: true,
      preload: path.join(__dirname, 'electron-preload.js')
    },
    frame: false,
    show: false
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5300')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist/index.html'))
    // 非开发环境，若开启了开发者模式则自动打开 DevTools
    if (devMode) {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    appLog('INFO', '应用窗口已显示')
  })

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    appLog('ERROR', `渲染进程崩溃: ${JSON.stringify(details)}`)
  })

  // 关闭窗口前触发前端保存，避免丢失未保存内容
  let isClosing = false
  mainWindow.on('close', async (e) => {
    if (isClosing) return
    isClosing = true
    e.preventDefault()
    try {
      await mainWindow.webContents.executeJavaScript('window.__saveBeforeClose && window.__saveBeforeClose()')
    } catch (err) {
      appLog('ERROR', `关闭前保存失败: ${err.message}`)
    }
    mainWindow.destroy()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // 窗口最大化状态变化，通知渲染进程更新交通灯图标
  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('win-maximized', true)
    // Windows 下最大化可能重置 WS_EX_TOPMOST，若已置顶则重新应用
    if (process.platform === 'win32' && mainWindow.isAlwaysOnTop()) applyAlwaysOnTop(true)
  })
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('win-maximized', false))
  // 窗口置顶状态变化通知
  mainWindow.on('always-on-top-changed', (_e, isOnTop) => mainWindow.webContents.send('win-always-on-top', isOnTop))

  createMenu()
}

// ============ 菜单 ============
function createMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '新建文档', accelerator: 'Ctrl+N', click: () => mainWindow.webContents.send('menu-action', 'new-document') },
        {
          label: '打开本地文件', accelerator: 'Ctrl+O',
          click: () => openLocalFile()
        },
        { type: 'separator' },
        { label: '保存', accelerator: 'Ctrl+S', click: () => mainWindow.webContents.send('menu-action', 'save') },
        { label: '导出为Markdown', accelerator: 'Ctrl+Shift+S', click: () => mainWindow.webContents.send('menu-action', 'export-md') },
        { label: '导出为HTML', click: () => mainWindow.webContents.send('menu-action', 'export-html') },
        { label: '导出为PDF', click: () => mainWindow.webContents.send('menu-action', 'export-pdf') },
        { type: 'separator' },
        { label: '退出', accelerator: 'Alt+F4', click: () => app.quit() }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'Ctrl+Z', role: 'undo' },
        { label: '重做', accelerator: 'Ctrl+Y', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', accelerator: 'Ctrl+X', role: 'cut' },
        { label: '复制', accelerator: 'Ctrl+C', role: 'copy' },
        { label: '粘贴', accelerator: 'Ctrl+V', role: 'paste' },
        { label: '全选', accelerator: 'Ctrl+A', role: 'selectAll' },
        { type: 'separator' },
        { label: '查找', accelerator: 'Ctrl+F', click: () => mainWindow.webContents.send('menu-action', 'search') }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '切换源码模式', accelerator: 'Ctrl+/', click: () => mainWindow.webContents.send('menu-action', 'toggle-source') },
        { label: '切换侧边栏', accelerator: 'Ctrl+Shift+B', click: () => mainWindow.webContents.send('menu-action', 'toggle-sidebar') },
        { label: '全屏模式', accelerator: 'F11', click: () => mainWindow.setFullScreen(!mainWindow.isFullScreen()) },
        { type: 'separator' },
        { label: '放大', accelerator: 'Ctrl+=', role: 'zoomIn' },
        { label: '缩小', accelerator: 'Ctrl+-', role: 'zoomOut' },
        { label: '重置缩放', accelerator: 'Ctrl+0', role: 'resetZoom' }
      ]
    },
    {
      label: '开发者',
      submenu: [
        {
          label: '开发者工具', accelerator: 'F12',
          click: () => mainWindow.webContents.toggleDevTools()
        },
        {
          label: '自动打开开发者工具（开发者模式）', type: 'checkbox', checked: isDevMode(),
          click: (menuItem) => {
            setDevMode(menuItem.checked)
            appLog('INFO', `开发者模式已${menuItem.checked ? '开启' : '关闭'}（重启后生效`)
            dialog.showMessageBox(mainWindow, {
              type: 'info', title: '开发者模式',
              message: `开发者模式已${menuItem.checked ? '开启' : '关闭'}`,
              detail: menuItem.checked
                ? '开启后，每次启动应用会自动打开开发者工具，便于排查问题。重启应用后生效。'
                : '已关闭。重启应用后生效。'
            })
          }
        },
        { type: 'separator' },
        {
          label: '重新加载页面', accelerator: 'Ctrl+R',
          click: () => mainWindow.webContents.reload()
        },
        {
          label: '强制重新加载', accelerator: 'Ctrl+Shift+R',
          click: () => mainWindow.webContents.reloadIgnoringCache()
        },
        { type: 'separator' },
        {
          label: '查看日志文件',
          click: () => {
            shell.showItemInFolder(logFile)
            appLog('INFO', '在资源管理器中显示日志文件')
          }
        },
        {
          label: '导出诊断报告...（反馈问题用）',
          click: async () => {
            const reportPath = await exportDiagnostics()
            if (reportPath) {
              shell.showItemInFolder(reportPath)
              appLog('INFO', `诊断报告已导出: ${reportPath}`)
            }
          }
        }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于Hypora',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info', title: '关于Hypora',
              message: 'Hypora - 开源Markdown编辑器',
              detail: `版本: 1.0.0\nElectron: ${process.versions.electron}\nChrome: ${process.versions.chrome}\nNode: ${process.versions.node}\n\n对标Typora的所见即所得编辑器\n完全开源免费`
            })
          }
        },
        {
          label: '反馈问题 / 提交建议',
          click: () => {
            shell.openExternal('https://github.com/hypora/hypora/issues/new')
            dialog.showMessageBox(mainWindow, {
              type: 'info', title: '反馈问题',
              message: '请在“开发者”菜单中点击“导出诊断报告...”',
              detail: '建议先导出诊断报告，把报告文件一并发给我们，能大幅加快问题定位。'
            })
          }
        },
        { type: 'separator' },
        {
          label: '关联 .md 文件（设为默认打开方式）',
          click: () => {
            const r = registerFileAssociation()
            if (r.success) {
              dialog.showMessageBox(mainWindow, {
                type: 'info', title: '关联成功',
                message: '已将 .md 文件关联到 Hypora',
                detail: `程序路径: ${r.exePath}\n\n现在双击 .md 文件会用 Hypora 打开，\n右键 .md 文件也有"用 Hypora 打开"选项。\n\n如未立即生效，请重启资源管理器或注销重新登录。`
              })
            } else {
              dialog.showErrorBox('关联失败', r.error || '请稍后重试')
            }
          }
        },
        {
          label: '取消 .md 文件关联',
          click: () => {
            unregisterFileAssociation()
            dialog.showMessageBox(mainWindow, {
              type: 'info', title: '已取消', message: '已取消 .md 文件关联'
            })
          }
        },
        { type: 'separator' },
        { label: '快捷键说明', click: () => mainWindow.webContents.send('menu-action', 'show-shortcuts') }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

// ============ 诊断报告导出 ============
async function exportDiagnostics() {
  try {
    // 收集日志（最近1000行）
    let logs = '（无日志）'
    try {
      const allLogs = fs.readFileSync(logFile, 'utf-8').split('\n')
      logs = allLogs.slice(-1000).join('\n')
    } catch (e) { logs = `读取日志失败: ${e.message}` }

    const report = `# Hypora 诊断报告

> 生成时间: ${new Date().toLocaleString('zh-CN')}
> 请将本文件发送给开发者以帮助定位问题。

## 一、应用信息
- 应用名称: Hypora
- 应用版本: 1.0.0
- Electron 版本: ${process.versions.electron}
- Chrome 版本: ${process.versions.chrome}
- Node.js 版本: ${process.versions.node}
- V8 版本: ${process.versions.v8}

## 二、系统环境
- 操作系统: ${os.type()} ${os.release()} ${os.arch()}
- 系统平台: ${process.platform}
- 主机名: ${os.hostname()}
- CPU: ${os.cpus()[0]?.model || '未知'} (${os.cpus().length} 核)
- 总内存: ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)} GB
- 空闲内存: ${(os.freemem() / 1024 / 1024 / 1024).toFixed(2)} GB
- 用户数据目录: ${userDataPath}
- 日志文件: ${logFile}

## 三、最近日志（最后1000行）
\`\`\`
${logs}
\`\`\`

## 四、问题反馈
请在此处描述你遇到的问题：
1. 你做了什么操作？
2. 期望的结果是什么？
3. 实际发生了什么？
4. 是否能稳定复现？（是/否）

---

*本报告由 Hypora 开发者模式自动生成，不包含你的文档内容隐私数据。*
`

    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `Hypora-诊断报告-${getDateStr()}.md`,
      filters: [{ name: 'Markdown文件', extensions: ['md'] }, { name: '所有文件', extensions: ['*'] }]
    })
    if (canceled || !filePath) return null

    fs.writeFileSync(filePath, report, 'utf-8')
    dialog.showMessageBox(mainWindow, {
      type: 'info', title: '导出成功',
      message: '诊断报告已导出',
      detail: `已保存到: ${filePath}\n\n请把此文件发送给开发者，配合文字描述可快速定位问题。`
    })
    return filePath
  } catch (e) {
    appLog('ERROR', `导出诊断报告失败: ${e.stack || e.message}`)
    dialog.showErrorBox('导出失败', e.message)
    return null
  }
}

// ============ IPC 处理 ============
ipcMain.handle('open-file-dialog', async () => {
  return await openLocalFile()
})

// 窗口控制（自定义 macOS 风格交通灯：关闭/最小化/最大化）
ipcMain.handle('win-minimize', () => { mainWindow?.minimize() })
ipcMain.handle('win-maximize-toggle', () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})
ipcMain.handle('win-close', () => { mainWindow?.close() })
ipcMain.handle('win-is-maximized', () => mainWindow?.isMaximized() ?? false)

// 窗口置顶（always-on-top）
// Windows 部分系统/Electron 版本下，无边框或最大化窗口的 setAlwaysOnTop
// 不能稳定保持 WS_EX_TOPMOST，需要带 level 重设一次兜底
function applyAlwaysOnTop(flag) {
  if (!mainWindow) return false
  mainWindow.setAlwaysOnTop(flag)
  if (process.platform === 'win32') {
    try {
      mainWindow.setAlwaysOnTop(flag, flag ? 'pop-up-menu' : 'normal')
    } catch { /* 兜底失败时保持默认 level 的结果 */ }
  }
  appLog('INFO', `窗口置顶: ${mainWindow.isAlwaysOnTop()}`)
  return mainWindow.isAlwaysOnTop()
}

ipcMain.handle('win-toggle-always-on-top', () => {
  if (!mainWindow) return false
  const next = !mainWindow.isAlwaysOnTop()
  return applyAlwaysOnTop(next)
})
ipcMain.handle('win-is-always-on-top', () => mainWindow?.isAlwaysOnTop() ?? false)

// 关联 .md 文件到 Hypora（写入 HKCU 注册表，无需管理员权限）
ipcMain.handle('register-file-association', async () => registerFileAssociation())

// 取消 .md 文件关联
ipcMain.handle('unregister-file-association', async () => unregisterFileAssociation())

ipcMain.handle('save-dialog', async (event, defaultFilename) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultFilename || 'document.md',
    filters: [{ name: 'Markdown文件', extensions: ['md'] }, { name: '所有文件', extensions: ['*'] }]
  })
  return result
})

ipcMain.handle('write-file', async (event, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8')
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// 写入二进制文件（PDF/图片，base64 传输）
ipcMain.handle('write-binary-file', async (event, filePath, base64) => {
  try {
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'))
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// 开发者模式相关 IPC
ipcMain.handle('dev:toggle-devtools', () => {
  mainWindow.webContents.toggleDevTools()
})
ipcMain.handle('dev:open-devtools', () => {
  mainWindow.webContents.openDevTools({ mode: 'detach' })
})
ipcMain.handle('dev:reload', (event, ignoreCache) => {
  if (ignoreCache) mainWindow.webContents.reloadIgnoringCache()
  else mainWindow.webContents.reload()
})
ipcMain.handle('dev:get-status', () => {
  return {
    devMode: isDevMode(),
    isDev: isDev,
    versions: {
      app: '1.0.0',
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    },
    platform: { type: os.type(), release: os.release(), arch: os.arch() },
    logFile
  }
})
ipcMain.handle('dev:set-devmode', (event, enabled) => {
  setDevMode(enabled)
  appLog('INFO', `开发者模式已${enabled ? '开启' : '关闭'}`)
  return true
})
// 渲染进程日志转发到主进程日志文件
ipcMain.handle('dev:log', (event, level, message) => {
  writeLog(level, 'renderer', message)
  return true
})
ipcMain.handle('dev:export-diagnostics', async () => {
  return await exportDiagnostics()
})
ipcMain.handle('dev:show-log-file', () => {
  shell.showItemInFolder(logFile)
  return logFile
})
ipcMain.handle('dev:open-external', (event, url) => {
  shell.openExternal(url)
})

appLog('INFO', `应用启动, 开发者模式: ${isDevMode()}, isDev: ${isDev}`)

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  // 启动时处理命令行文件参数（双击.md文件打开）
  const file = getFileFromArgv()
  if (file && mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => openFilePath(file))
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
      // 已运行实例时双击另一.md文件，打开它
      const file = getFileFromArgv(argv)
      if (file) openFilePath(file)
    }
  })
}