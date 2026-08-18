// Hypora 一键打包脚本（手动注入图标，绕过 electron-builder 重命名 bug）
// 用法: node scripts/build-with-icon.cjs
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { packSourcecode } = require('./pack-sourcecode.cjs')

const root = path.join(__dirname, '..')

// 打包前静默结束正在运行的 Hypora.exe（否则 exe 被锁 → rcedit/重命名失败，图标注入不生效）
try {
  require('./kill-hypora.cjs')
} catch {}

// rcedit 路径（electron-builder 缓存中，含图标注入能力）
const RCEDIT = path.join(os.homedir(), 'AppData/Local/electron-builder/Cache/winCodeSign/310595615/rcedit-x64.exe')

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`)
  execSync(cmd, { stdio: 'inherit', cwd: root, ...opts })
}

// 查找已缓存的 electron 压缩包（优先 v42）
function findElectronZip() {
  const cacheDir = path.join(os.homedir(), 'AppData/Local/electron/Cache')
  if (!fs.existsSync(cacheDir)) throw new Error('未找到 electron 缓存，请先运行一次 npm run electron:dev 下载')
  const allZips = []
  for (const d of fs.readdirSync(cacheDir)) {
    const full = path.join(cacheDir, d)
    try {
      if (fs.statSync(full).isDirectory()) {
        for (const f of fs.readdirSync(full)) {
          if (f.includes('electron-v') && f.endsWith('-win32-x64.zip')) {
            allZips.push(path.join(full, f))
          }
        }
      } else if (d.includes('electron-v') && d.endsWith('-win32-x64.zip')) {
        allZips.push(full)
      }
    } catch {}
  }
  if (!allZips.length) throw new Error('缓存中无 electron win32-x64 zip')
  // 优先 v42，其次取版本号最大的
  const v42 = allZips.find(p => p.includes('electron-v42'))
  if (v42) return v42
  allZips.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  return allZips[0]
}

// rcedit 命令带重试（避免杀毒软件临时锁定导致 "Unable to commit changes"）
function rcedit(args, cwd, retries = 5) {
  for (let i = 1; i <= retries; i++) {
    try {
      execSync(`"${RCEDIT}" ${args}`, { cwd, stdio: 'pipe' })
      return
    } catch (e) {
      console.log(`  rcedit 第${i}次失败: ${e.message.split('\n')[0]}, 重试...`)
      if (i === retries) throw e
      // 释放文件锁
      try { execSync(`attrib -R electron.exe`, { cwd, stdio: 'ignore' }) } catch {}
      const sleep = require('child_process').execSync
      execSync('ping 127.0.0.1 -n 4 > nul', { cwd, stdio: 'ignore' })
    }
  }
}

function main() {
  console.log('【1/5】构建前端资源...')
  run('npx vite build')

  console.log('【2/5】清理输出目录...')
  const outDir = path.join(root, 'release/Hypora')
  // 保留输出目录中已有的 .bat（如 .md 关联/取消关联脚本），避免清理时丢失
  const preservedBats = {}
  if (fs.existsSync(outDir)) {
    for (const f of fs.readdirSync(outDir)) {
      if (f.toLowerCase().endsWith('.bat')) {
        preservedBats[f] = fs.readFileSync(path.join(outDir, f))
      }
    }
    fs.rmSync(outDir, { recursive: true, force: true })
  }
  fs.mkdirSync(outDir, { recursive: true })

  console.log('【3/5】解压 Electron 运行时...')
  const electronZip = findElectronZip()
  console.log(`  使用缓存: ${electronZip}`)
  run(`unzip -q "${electronZip}"`, { cwd: outDir })

  console.log('【4/5】注入图标和版本信息（含重试）...')
  fs.copyFileSync(path.join(root, 'public/favicon.ico'), path.join(outDir, 'favicon.ico'))
  rcedit('electron.exe --set-icon favicon.ico', outDir)
  rcedit('electron.exe --set-version-string "ProductName" "Hypora"', outDir)
  rcedit('electron.exe --set-version-string "FileDescription" "Hypora - Markdown Editor"', outDir)
  rcedit('electron.exe --set-version-string "CompanyName" "Hypora"', outDir)
  rcedit('electron.exe --set-file-version "1.0.0"', outDir)
  rcedit('electron.exe --set-product-version "1.0.0"', outDir)
  fs.unlinkSync(path.join(outDir, 'favicon.ico'))
  fs.renameSync(path.join(outDir, 'electron.exe'), path.join(outDir, 'Hypora.exe'))

  console.log('【5/6】组装应用资源...')
  fs.mkdirSync(path.join(outDir, 'resources/app'), { recursive: true })
  fs.copyFileSync(path.join(root, 'electron-main.js'), path.join(outDir, 'resources/app/electron-main.js'))
  fs.copyFileSync(path.join(root, 'electron-preload.js'), path.join(outDir, 'resources/app/electron-preload.js'))
  fs.copyFileSync(path.join(root, 'package.json'), path.join(outDir, 'resources/app/package.json'))
  fs.cpSync(path.join(root, 'dist'), path.join(outDir, 'resources/app/dist'), { recursive: true })

  // 还原保留的 .bat 脚本，与 exe 同目录
  for (const name of Object.keys(preservedBats)) {
    fs.writeFileSync(path.join(outDir, name), preservedBats[name])
  }
  // 从项目根复制 .md 关联/取消关联 .bat 脚本（源头在根目录，防止 release 目录被清理后丢失）
  for (const bat of ['关联MD文件.bat', '取消MD关联.bat']) {
    const src = path.join(root, bat)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, bat))
  }

  console.log('【6/6】打包源码模块 sourcecode（供服务器编译与二次开发）...')
  packSourcecode(outDir, 'electron')

  console.log('\n✅ 打包完成！')
  console.log(`📍 程序位置: ${outDir}\\Hypora.exe`)
  console.log(`📍 源码位置: ${outDir}\\sourcecode\\`)
}

main()
