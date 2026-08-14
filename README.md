# Hypora — 对标 Typora 的所见即所得 Markdown 编辑器

内容优先、UI 隐退的 Markdown 写作工具。支持 **Electron 桌面版**（Windows）与 **Web 版**（纯静态部署），所见即所得实时编辑，内置双引擎 AI 助手（DeepSeek 文本对话 / GLM 识图 / 本地 LLM）。

## ✨ 核心特性

- 🎯 **所见即所得** - 实时一体化编辑预览，输入 Markdown 语法立即渲染
- 🤖 **AI 助手** - 选中文字即可改写 / 解释 / 翻译 / 扩写 / 总结 / 文档问答，结果插回编辑器；支持 DeepSeek 文本、GLM 识图（图片 OCR/表格还原）、本地 LLM 三种引擎
- 📝 **全语法支持** - 标题、粗体/斜体/删除线/高亮、行内代码、代码块（语法高亮）、有序/无序列表、任务清单、引用、表格、图片、链接、LaTeX 数学公式、Mermaid 流程图、Emoji
- 💾 **本地存储** - 自动保存到浏览器 localStorage / 桌面本地文件，刷新不丢失，支持多文档管理
- 📤 **多格式导出** - 支持导出 Markdown、HTML、PDF、图片，导出产物自带 Hypora 签名
- ⌨️ **丰富快捷键** - 复刻 Typora 快捷键
- 🎨 **五套主题** - 冷淡单色设计语言，内置浅色白、暗色黑、米色护眼、极简灰、冰雪五套主题，全站跟随（含公式/图表/代码配色）
- 📊 **大纲导航** - 自动生成文档大纲，滚动自动跟随高亮
- 🔍 **搜索替换** - 文档内搜索高亮 + 替换，上下按钮滚动定位
- 🖼️ **图片粘贴** - 剪贴板粘贴 / 拖拽上传图片
- 🏗️ **桌面增强** - 无边框窗口、.md 双击关联、窗口置顶、原生保存对话框

## 🛠️ 技术栈

- **框架**: Vue 3 + TypeScript + Vite 8
- **桌面运行时**: Electron 42（Windows NSIS/便携版）
- **UI组件**: Element Plus
- **Markdown解析**: Marked
- **代码高亮**: Prism.js
- **流程图**: Mermaid
- **数学公式**: KaTeX
- **状态管理**: Pinia
- **导出功能**: FileSaver + html2canvas + jsPDF

---

## 🚀 安装指南

### 方式一：Windows 桌面版（推荐）

Windows 便携版 EXE 免安装、开箱即用，含完整桌面能力（.md 双击关联、窗口置顶、原生保存对话框、PDF/图片导出）。

- **有现成安装包**：从 [GitHub Releases](https://github.com/JingChenCHN/Hypora/releases) 下载 `Hypora.exe`（若已发布 v1.0.0 便携版），双击运行即可
- **无安装包 / 想自己打**：在 Windows 环境按「方式三」源码编译，`npm run pack:win` 即生成 EXE（详见下）

运行后可选：用同目录的 **`关联MD文件.bat`** 将 `.md` 关联到 Hypora（双击 .md 自动用 Hypora 打开；不需要时运行 `移除MD关联.bat` 解除）。

### 方式二：Web 版（在线使用 / 部署到服务器）

纯静态构建，无需安装，浏览器打开即用；文件保存走浏览器下载，桌面特性自动降级。

- **在线预览**: 打开已部署的 Web 版地址即可使用
- **本地快速预览**（零依赖）:
  ```bash
  node server.cjs            # 默认 8080
  node server.cjs 3000       # 指定端口
  ```
  浏览器打开 http://localhost:8080

### 方式三：源码自编译

需要 Node.js ≥ 18、npm ≥ 9。

```bash
# 1. 克隆仓库
git clone https://github.com/JingChenCHN/Hypora.git
cd Hypora

# 2. 安装依赖
npm install

# 3a. Web 版（开发预览）
npm run dev                  # 访问 http://localhost:5300
npm run build                # 生产构建 → dist/，可部署到任意静态服务器
npm run preview              # 本地预览生产构建

# 3b. Electron 桌面版（Windows）
npm run electron:build       # electron-builder 打包 → release/（含 NSIS 安装版 + 便携版）
# 或
npm run pack:win             # 一键打包（手动注入图标，Windows 下运行）
# 或（Windows 环境）
build-exe.bat                # 一键构建脚本（自动配置淘宝镜像）
```

> **国内网络提示**：Electron 二进制下载慢时，可设置镜像：
> ```
> set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
> set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
> ```

### 产物说明

| 命令 | 产物 | 目录 |
|---|---|---|
| `npm run build` | Web 版静态文件 | `dist/` |
| `npm run electron:build` | Electron 安装版 + 便携版 | `release/` |
| `npm run pack:win` | Windows 一键打包 | `release/` |
| `node scripts/build-web.cjs` | Web 版完整发布包（含 `sourcecode/`） | `release/` |

---

## 🌐 Web 版部署（Nginx）

将 `dist/` 目录部署到任意静态托管即可，已用相对路径，支持子路径：

```nginx
server {
    listen 80;
    server_name your-domain.com;
    root /path/to/dist;
    index index.html;

    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";  # 静态资源长缓存
        try_files $uri =404;
    }

    location / {
        try_files $uri $uri/ /index.html;  # SPA 回退
    }
}
```

---

## 📖 使用说明

### AI 助手

- **唤出**: 工具栏右侧 AI 按钮，或按 `Ctrl+J`
- **引擎切换**: 面板配置区可选 DeepSeek / GLM 识图 / 本地 LLM
- **选中操作**: 选中编辑器文字，点「改写 / 解释 / 翻译 / 扩写 / 总结」；或点「带入文档」让 AI 阅读全文回答
- **识图**: GLM 模式下点 📎 上传图片（最多 5 张），AI 提取其中文字 / 表格 / 图表并输出结构化 Markdown
- **配置**: API Key / 模型 / 思考模式可在面板配置区设置，持久化到本地

### 基本操作

- **新建文档**: 工具栏「文件」→「新建文档」，或侧边栏「新建文档」
- **打开本地文件**: 工具栏「文件」→「打开本地文件」（桌面版走原生对话框，可 Ctrl+S 写回原文件）
- **保存/导出**: 工具栏「文件」选择导出格式，或 `Ctrl+S` 保存到本地
- **切换源码模式**: `Ctrl+/`
- **全屏模式**: `F11`，鼠标移到顶部显示工具栏

### 快捷键（对标 Typora）

| 快捷键 | 功能 |
|---|---|
| `Ctrl + S` | 保存文档 |
| `Ctrl + B` | 加粗 |
| `Ctrl + I` | 斜体 |
| `Ctrl + U` | 下划线 |
| `Alt + Shift + 5` / `Ctrl + Shift + S` | 删除线 |
| `Ctrl + Shift + H` | 高亮 |
| `` Ctrl + ` `` | 行内代码 |
| `Ctrl + Shift + K` | 代码块 |
| `Ctrl + Shift + M` | 数学公式块 |
| `Ctrl + K` | 插入链接 |
| `Ctrl + Shift + I` | 插入图片 |
| `Ctrl + 1~6` | 标题 1–6 级 |
| `Ctrl + 0` | 普通段落 |
| `Ctrl + ]` / `Ctrl + [` | 标题级别 升/降 |
| `Ctrl + Shift + T` | 插入表格 |
| `Ctrl + Shift + Q` | 引用块 |
| `Ctrl + Shift + U` | 无序列表 |
| `Ctrl + Shift + O` | 有序列表 |
| `Ctrl + Shift + X` | 任务列表 |
| `Ctrl + \` | 清除格式 |
| `Ctrl + /` | 切换源码模式 |
| `Ctrl + F` | 查找 |
| `Ctrl + H` | 查找替换 |
| `Ctrl + J` | 唤出 AI 助手 |
| `F9` | 侧边栏 |
| `F11` | 全屏模式 |
| `Ctrl + Shift + = / - / 0` | 放大 / 缩小 / 重置缩放 |
| `F12` | 开发者面板 |

### Markdown 语法支持

- 输入 `# 空格` 自动转为标题
- 输入 `*` 或 `- 空格` 自动转为无序列表
- 输入 `1. 空格` 自动转为有序列表
- 输入 `> 空格` 自动转为引用块
- 输入 ``` `` ``` 回车生成代码块，支持多语言语法高亮
- 输入 `---` 回车生成分割线
- 输入 `[ ] 空格` 生成任务清单
- 直接粘贴或拖拽图片自动插入

---

## 🏗️ 项目架构

```plaintext
hypora/
├── src/
│   ├── assets/             # 静态资源
│   │   └── reset.scss      # 全局样式重置
│   ├── components/         # Vue组件
│   │   ├── Editor.vue      # 核心编辑器组件
│   │   ├── Toolbar.vue     # 顶部工具栏
│   │   ├── Sidebar.vue     # 侧边栏（大纲/文档列表）
│   │   ├── AIPanel.vue     # AI 助手面板
│   │   ├── SearchPanel.vue # 搜索替换面板
│   │   ├── Statusbar.vue   # 底部状态栏
│   │   └── ...             # 右键菜单 / 开发者面板等
│   ├── composables/        # 组合式函数（useShortcuts.ts）
│   ├── config/             # 编辑器配置
│   ├── stores/             # Pinia 状态管理（document.ts / ai.ts）
│   ├── themes/             # 主题变量与 Markdown 样式（index.scss）
│   ├── utils/              # markdown.ts / export.ts / deepseek.ts 等
│   ├── App.vue             # 根组件
│   ├── main.ts             # 入口文件
│   └── env.d.ts            # 类型声明
├── electron-main.js        # Electron 主进程
├── electron-preload.js     # Electron 预加载脚本
├── index.html              # HTML 模板
├── vite.config.ts          # Vite 配置
└── package.json            # 依赖配置
```

---

## 📄 开源协议

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！
