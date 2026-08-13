// 共享：打包源码模块 sourcecode/，供 release 产物携带，便于服务器上 npm install + 构建 + 二次开发。
// 被 build-with-icon.cjs（Electron 版）和 build-web.cjs（Web 版）共同调用，保证两边 sourcecode 规则一致。
const fs = require('fs')
const path = require('path')

// @param outDir  release 产物根目录（sourcecode 会建在其下）
// @param flavor  'electron' | 'web'，仅影响构建说明里的首发命令提示
function packSourcecode(outDir, flavor = 'electron') {
  const srcDir = path.join(outDir, 'sourcecode')
  if (fs.existsSync(srcDir)) fs.rmSync(srcDir, { recursive: true, force: true })
  fs.mkdirSync(srcDir, { recursive: true })
  const root = path.join(__dirname, '..')

  // 顶层文件白名单（小文件、配置、文档）
  const files = [
    'electron-main.js', 'electron-preload.js', 'package.json', 'package-lock.json',
    'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json',
    'index.html', 'CLAUDE.md', 'README.md', '.impeccable.md',
    '操作手册.md', '系统设计文档.md',
    'build-exe.bat', '关联MD文件.bat', '取消MD关联.bat'
  ]
  for (const f of files) {
    const src = path.join(root, f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(srcDir, f))
  }

  // 顶层目录白名单（递归拷贝，排除构建产物）
  const dirs = ['src', 'scripts', 'public']
  for (const d of dirs) {
    const src = path.join(root, d)
    if (fs.existsSync(src)) fs.cpSync(src, path.join(srcDir, d), { recursive: true })
  }

  // src-tauri 拷贝时排除 target/（构建产物，体积大）
  const tauriSrc = path.join(root, 'src-tauri')
  if (fs.existsSync(tauriSrc)) {
    fs.cpSync(tauriSrc, path.join(srcDir, 'src-tauri'), {
      recursive: true,
      filter: (s) => !s.includes(path.sep + 'target') && !s.endsWith(path.sep + 'target')
    })
  }

  const buildGuide = `# Hypora 源码模块

本目录包含 Hypora 的完整源码，可在服务器或本地编译与二次开发。

## 环境要求

- Node.js >= 18
- npm >= 9
- （可选，Electron 桌面端）联网下载 Electron 二进制；国内建议配置镜像：
  \`\`\`
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
  \`\`\`
- （可选，Tauri 桌面端）Rust 工具链 + MSVC Build Tools（Windows）

## 快速开始

\`\`\`bash
npm install          # 安装依赖
npm run dev          # 仅前端开发（浏览器，http://localhost:5300）
${flavor === 'web'
    ? 'node scripts/build-web.cjs   # 构建 Web 版静态站点（产物 release/web/）'
    : 'npm run electron:dev          # Electron 桌面端开发模式'}
\`\`\`

## 构建

\`\`\`bash
npm run build        # 仅构建前端到 dist/
${flavor === 'web'
    ? 'node scripts/build-web.cjs   # 打包 Web 版（含 sourcecode），产物 release/web/'
    : 'npm run pack:win     # 一键打包 Windows 便携版（含图标注入），产物 release/Hypora/\nnpm run electron:build # electron-builder 标准打包（nsis + portable）'}
\`\`\`

## AI 助手

- **DeepSeek 云端**：纯文本对话，需 API Key
- **GLM 识图**：GLM-4V-Flash 多模态，支持上传图片做内容提取（默认 Key 已预置，可直接使用，可在配置区覆盖）
- **本地 LLM**：对接 llama-server（127.0.0.1:8899）

切换引擎在 AI 面板 → 配置区。

## 目录结构

- \`src/\` Vue 3 + TypeScript 前端
- \`electron-main.js\` / \`electron-preload.js\` Electron 主进程与预加载
- \`src-tauri/\` Tauri 备选桌面端（Rust）
- \`scripts/\` 打包与验证脚本
\`\`\`
`
  fs.writeFileSync(path.join(srcDir, '构建说明.md'), buildGuide, 'utf-8')
}

module.exports = { packSourcecode }
