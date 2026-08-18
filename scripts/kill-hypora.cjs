#!/usr/bin/env node
// 打包前静默结束正在运行的 Hypora.exe，避免 exe 文件被锁导致打包失败。
//
// 根因：electron-builder 打包时若 Hypora 仍在运行（含渲染子进程，通常 4 个），
// 进程锁住 exe，electron-builder 替换文件时报 EPERM: unlink，图标注入步骤没完成，
// 产物留下 Electron 原版图标。手动注入式打包（scripts/build-with-icon.cjs）同样受影响。
//
// 本脚本在 Windows 下用 taskkill 静默结束所有 Hypora.exe 实例；无进程时自动跳过、不报错。
// 非 Windows 平台直接跳过（打包目标是 Windows，其他平台不需要）。
const { execSync } = require('child_process')
const os = require('os')

if (os.platform() !== 'win32') {
  console.log('[kill-hypora] 非 Windows 环境，跳过。')
  process.exit(0)
}

try {
  // /F 强制结束，/T 连带子进程；无进程时 taskkill 报错，用 stdio:'ignore' + catch 吞掉
  execSync('taskkill /IM Hypora.exe /F /T', { stdio: 'ignore' })
  console.log('[kill-hypora] 已结束正在运行的 Hypora.exe ✅')
} catch {
  console.log('[kill-hypora] 未检测到运行中的 Hypora.exe，跳过。')
}
