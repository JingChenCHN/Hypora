#!/usr/bin/env node
/**
 * fetch-llamacpp.cjs —— 拉取 llama.cpp 预编译二进制到 ai-engine/<platform>/<backend>/
 *
 * 用途：为「内置助手」（electron-ai-engine.cjs）准备 llama-server 运行时。
 *   - Windows 产物进 electron-builder extraResources（ai-engine/win-x64/{vulkan,cpu}）
 *   - Linux 产物供本机 harness（scripts/ai-engine-harness.cjs）驱动主进程逻辑
 *
 * 资产名 / 内部结构均为 2026-09 对 b10872 release 的实测：
 *   - win zip 内容**完全扁平**（llama-server.exe 与各 DLL 在 zip 根，无 build/bin 前缀）
 *   - linux 为 tar.gz，内含单层顶层目录
 *   - 两种后端 DLL 集不同，必须分目录存放，不可混放
 *
 * 用法：
 *   node scripts/fetch-llamacpp.cjs                 # 默认拉取当前平台
 *   node scripts/fetch-llamacpp.cjs --only-win      # 仅 Windows 资产（CI 用）
 *   node scripts/fetch-llamacpp.cjs --only-linux    # 仅 Linux 资产
 *   node scripts/fetch-llamacpp.cjs --skip-download # 只建目录树 + manifest（不下载）
 *
 * 下载源依次回落：GitHub 直连 → HYPORA_LLAMA_MIRROR（自定义前缀）→ 公共 gh 镜像。
 * 退出码语义：任一后端就绪即 0（引擎支持单后端运行）；全部缺失才 1（构建链用 && 严格中断，
 * 避免「静默打出空引擎目录 → 运行时报引擎文件缺失」）。
 * 网络受限时可手动下载 zip，解压到 ai-engine/<平台>/<后端>/（llama-server.exe 须直接位于该目录）。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const https = require('https')
const { execFileSync } = require('child_process')

const LLAMA_TAG = 'b10872'
const RELEASE_BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}`

// 下载源前缀依次回落：''直连 → 自定义镜像（HYPORA_LLAMA_MIRROR）→ 公共 gh 镜像（国内网络）
const MIRROR_PREFIXES = [
  '',
  process.env.HYPORA_LLAMA_MIRROR || null,
  'https://ghfast.top/',
  'https://gh-proxy.com/',
].filter((p) => p !== null)

// 平台 → 后端 → 资产文件名（b10872 实测清单）
const ASSETS = {
  'win-x64': {
    vulkan: `llama-${LLAMA_TAG}-bin-win-vulkan-x64.zip`,
    cpu: `llama-${LLAMA_TAG}-bin-win-cpu-x64.zip`,
  },
  'linux-x64': {
    vulkan: `llama-${LLAMA_TAG}-bin-ubuntu-vulkan-x64.tar.gz`,
    cpu: `llama-${LLAMA_TAG}-bin-ubuntu-x64.tar.gz`,
  },
}

const SCRIPT_PLATFORM = process.platform === 'win32' ? 'win-x64' : 'linux-x64'
const args = process.argv.slice(2)
const SKIP_DOWNLOAD = args.includes('--skip-download')
const ONLY_WIN = args.includes('--only-win')
const ONLY_LINUX = args.includes('--only-linux')

const ROOT = path.resolve(__dirname, '..')
const AI_DIR = path.join(ROOT, 'ai-engine')

let manifest = { tag: LLAMA_TAG, fetchedAt: null, platforms: {} }
const manifestPath = path.join(AI_DIR, 'manifest.json')

function log(msg) { console.log(`[fetch-llamacpp] ${msg}`) }

// ---- HTTPS 下载（手动跟随 3xx，GitHub release 会 302 到 objects.githubusercontent.com）----
function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向次数过多'))
    const req = https.get(url, { headers: { 'User-Agent': 'hypora-fetch-llamacpp' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        return resolve(download(next, dest, redirects + 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode}（资产不存在或网络受限）`))
      }
      const out = fs.createWriteStream(dest)
      res.pipe(out)
      out.on('finish', () => out.close(resolve))
      out.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(300_000, () => req.destroy(new Error('下载超时（300s）')))
  })
}

// ---- 解压：win zip 走 tar(bsdtar)/unzip，linux tar.gz 走 tar；统一解到 tmp 再搬移 ----
function extract(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  const isZip = archivePath.endsWith('.zip')
  if (isZip && process.platform !== 'win32') {
    execFileSync('unzip', ['-oq', archivePath, '-d', destDir])
  } else {
    // win10+ 自带 bsdtar（支持 zip）；linux/mac 用系统 tar
    execFileSync('tar', [isZip ? '-xf' : '-xzf', archivePath, '-C', destDir])
  }
  // 归一化：若解压产物是单层顶层目录（linux tar.gz 如此），把其内容上提一层，
  // 让 llama-server 永远位于 <backend>/ 下的固定相对位置
  const entries = fs.readdirSync(destDir)
  if (entries.length === 1) {
    const only = path.join(destDir, entries[0])
    if (fs.statSync(only).isDirectory()) {
      for (const name of fs.readdirSync(only)) {
        fs.renameSync(path.join(only, name), path.join(destDir, name))
      }
      fs.rmdirSync(only)
    }
  }
}

// ---- 拉取一个 平台×后端 ----
async function fetchOne(platform, backend, assetName) {
  const targetDir = path.join(AI_DIR, platform, backend)
  fs.mkdirSync(targetDir, { recursive: true })
  if (SKIP_DOWNLOAD) return
  // 幂等：目标二进制已存在则跳过（构建链可反复调用而不重复下载）
  const markerNow = process.platform === 'win32' || platform === 'win-x64' ? 'llama-server.exe' : 'llama-server'
  if (fs.existsSync(path.join(targetDir, markerNow))) {
    log(`${platform}/${backend} 已存在，跳过下载`)
    return
  }

  const archivePath = path.join(os.tmpdir(), `hypora-${assetName}`)
  let lastErr = null
  for (const prefix of MIRROR_PREFIXES) {
    const url = `${prefix}${RELEASE_BASE}/${assetName}`
    log(`${platform}/${backend} ← ${prefix || 'github 直连'}${assetName}`)
    try {
      await download(url, archivePath)
      lastErr = null
      break
    } catch (e) {
      lastErr = e
      log(`  源失败（${e.message}），换下一个源…`)
    }
  }
  if (lastErr) throw lastErr
  const sizeMB = (fs.statSync(archivePath).size / 1024 / 1024).toFixed(1)
  log(`  下载完成 ${sizeMB} MB，解压…`)
  extract(archivePath, targetDir)
  fs.rmSync(archivePath, { force: true })

  const marker = process.platform === 'win32' || platform === 'win-x64' ? 'llama-server.exe' : 'llama-server'
  if (!fs.existsSync(path.join(targetDir, marker))) {
    throw new Error(`解压后未找到 ${marker}（${targetDir}）`)
  }
  log(`  ✓ ${targetDir}`)
}

async function main() {
  fs.mkdirSync(AI_DIR, { recursive: true })
  // 恢复既有 manifest（增量补平台），没有则以当前时间起一份
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) } catch { /* 首次 */ }

  let platforms = [SCRIPT_PLATFORM]
  if (ONLY_WIN) platforms = ['win-x64']
  if (ONLY_LINUX) platforms = ['linux-x64']

  const failures = []
  for (const platform of platforms) {
    const backends = ASSETS[platform] || {}
    manifest.platforms[platform] = {}
    for (const backend of Object.keys(backends)) {
      try {
        await fetchOne(platform, backend, backends[backend])
        manifest.platforms[platform][backend] = { asset: backends[backend], ok: true }
      } catch (e) {
        log(`✗ ${platform}/${backend}: ${e.message}`)
        manifest.platforms[platform][backend] = { asset: backends[backend], ok: false, error: e.message }
        failures.push(`${platform}/${backend}`)
      }
    }
  }

  manifest.fetchedAt = new Date().toISOString()
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  log(`manifest.json 已写入${SKIP_DOWNLOAD ? '（skip-download：仅目录树）' : ''}`)

  // 退出码：任一后端就绪即放行（引擎按存在的二进制挑后端）；全缺才判失败中断构建
  if (!SKIP_DOWNLOAD) {
    const ready = []
    const missing = []
    for (const platform of platforms) {
      const marker = platform === 'win-x64' ? 'llama-server.exe' : 'llama-server'
      for (const backend of Object.keys(ASSETS[platform] || {})) {
        ;(fs.existsSync(path.join(AI_DIR, platform, backend, marker)) ? ready : missing).push(`${platform}/${backend}`)
      }
    }
    if (missing.length) log(`⚠ 缺少 ${missing.join(', ')}——引擎将以单后端运行；可重试或手动放置后重新构建`)
    if (!ready.length) {
      log('✗ 没有任何可用后端，继续打包将导致运行时报「引擎文件缺失」')
      log('  手动修复：下载 llama.cpp win zip 解压到 ai-engine/win-x64/<vulkan|cpu>/，llama-server.exe 须直接位于该目录')
      process.exitCode = 1
    } else {
      log(`完成（就绪: ${ready.join(', ')}）`)
    }
  } else {
    log('完成')
  }
}

main().catch((e) => {
  log(`致命错误: ${e.message}`)
  process.exitCode = 1
})
