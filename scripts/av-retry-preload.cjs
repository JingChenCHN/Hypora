// ============ Windows 杀软锁重试 preload ============
// 现象：本机杀软（Defender/360/EDR 等）对刚落地的 Hypora.exe 实时扫描期间持有句柄，
// electron-builder 的 editWindowsResources（app-builder-lib/out/util/resEdit.js:32 用
// fs/promises.writeFile 写回 exe）open 失败报 `UNKNOWN: unknown error`，构建必挂。
// 方案：node --require 本文件，给 fs.promises 的写类操作包一层退避重试——
// 仅对 `.exe` 路径 + 锁类错误码生效，次数/间隔封顶，超限原样抛错（不掩盖真故障）。
// 用法（package.json scripts 已接好）：
//   node --require ./scripts/av-retry-preload.cjs node_modules/electron-builder/cli.js ...

const fs = require('fs')

const RETRYABLE = new Set(['UNKNOWN', 'EBUSY', 'EPERM', 'EACCES', 'EMFILE'])
const MAX_TRIES = Number(process.env.HYPORA_AV_RETRY_MAX || 10)       // 总尝试次数
const BASE_MS = Number(process.env.HYPORA_AV_RETRY_BASE_MS || 800)    // 线性退避基数

const isExePath = (p) =>
  (typeof p === 'string' && p.toLowerCase().endsWith('.exe')) ||
  (p instanceof URL && p.pathname.toLowerCase().endsWith('.exe'))

function wrap(obj, key) {
  const orig = obj[key]
  if (typeof orig !== 'function' || orig.__hyporaAvRetry) return
  const wrapped = async function (...args) {
    let lastErr
    for (let i = 1; i <= MAX_TRIES; i++) {
      try {
        return await orig.apply(this, args)
      } catch (e) {
        lastErr = e
        if (!isExePath(args[0]) || !e || !RETRYABLE.has(e.code) || i === MAX_TRIES) throw e
        const delay = BASE_MS * i
        console.warn(`[av-retry] ${key} ${e.code} on ${args[0]}，${delay}ms 后第 ${i + 1}/${MAX_TRIES} 次重试（杀软扫描锁）`)
        await new Promise((r) => setTimeout(r, delay))
      }
    }
    throw lastErr
  }
  wrapped.__hyporaAvRetry = true
  obj[key] = wrapped
}

// require("fs").promises 与 require("fs/promises") 是同一对象，包一处全覆盖
wrap(fs.promises, 'writeFile')
wrap(fs.promises, 'rename')
wrap(fs.promises, 'unlink')
wrap(fs.promises, 'copyFile')
