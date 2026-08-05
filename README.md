# Hypora

内容优先、UI 隐退的 **所见即所得 Markdown 编辑器**，内置 **双引擎 AI 写作助手**（云端 OpenAI 兼容服务 + 本地 llama.cpp）。

以 Rust 为内核、系统 WebView 为渲染载体的轻量桌面壳（**Tauri 2**），承载一个壳无关的 Vue 渲染层；所有跨边界能力经统一适配层以白名单 IPC 下发；AI 以 OpenAI 兼容协议为统一契约、可插拔多 provider。

> 依据《Hypora 系统架构设计 v3.0》实现（本仓库根目录 `docs/architecture-v3.md`）。

## ✨ 特性

- **所见即所得块级编辑**：键入 → 块级重渲染（保光标）→ 防抖 htmlToMd → 源文件写回
- **双引擎 AI**：云端 OpenAI 兼容（DeepSeek / OpenAI / 智谱 / 自定义）+ 本地 llama.cpp sidecar
- **思考链（reasoning_content）**：DeepSeek-R1 等模型流式展示思考过程
- **AI 流式下沉 Rust 代理**：绕开 WebView CORS / 混合内容约束，统一超时/重试/取消
- **5 主题**：Yaru 设计语言（accent `#E95420` / aubergine `#2C001E`），含高对比模式，令牌单一事实源
- **frameless + 自绘窗口装饰**：跨平台一致的品牌窗口体验（交通灯/拖动/置顶）
- **数据零丢失**：before-close 落盘 + 编辑防抖双保险，单实例防双写
- **能力白名单 + CSP**：渲染层零 Node，外部 IO 全经 Rust 内核白名单命令
- **导出**：Markdown / HTML / PDF / 图片（SVG）

## 🧱 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面壳 | Tauri 2（Rust 内核 + 系统 WebView2 / WKWebView / WebKitGTK） |
| 渲染层 | Vue 3 `<script setup>` + TypeScript + Pinia |
| 样式 | SCSS（`@use` + mixin 注入） |
| Markdown | marked（解析）+ Turndown（HTML→MD）+ PrismJS（高亮） |
| 图表 | Mermaid（动态 import 分包） |
| AI | OpenAI 兼容 `/v1/chat/completions` SSE，Rust reqwest 代理 |

## 📁 目录结构

```
Hypora/
├── src-tauri/            # Rust 内核
│   ├── src/lib.rs        # 命令白名单 · 窗口 · 生命周期 · 事件
│   ├── src/ai.rs         # AI 流式 SSE 代理（含单测）
│   ├── src/sidecar.rs    # 本地 llama.cpp sidecar 管理
│   ├── capabilities/     # 能力白名单（最小授权）
│   └── tauri.conf.json
├── src/
│   ├── utils/tauriAPI.ts # 统一适配层（渲染层唯一跨边界入口）
│   ├── components/       # Editor / AIPanel / Toolbar / TrafficLights / …
│   ├── stores/           # document（编辑管线）/ ai（AI 对话）
│   ├── utils/            # markdown / export / deepseek / editorBus / devMode
│   ├── themes/           # 主题令牌单一事实源（Yaru 五主题）
│   └── assets/           # reset.scss / ai-assistant.json / aiLoading.ts
└── scripts/generate-icon.cjs  # 图标生成（无外部依赖）
```

## 🚀 开始使用

### 环境要求

- Node.js ≥ 20，pnpm 或 npm
- Rust stable（≥ 1.77）+ [Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)
  - Linux: `webkit2gtk-4.1`, `gtk3`, `libsoup3` 等
  - Windows: WebView2 Runtime（Win10/11 自带）

### 安装与开发

```bash
npm install
npm run dev          # 浏览器预览（Web 降级模式）
npm run dev:tauri    # 桌面应用（Tauri dev）
```

### 构建与发布

```bash
npm run build:tauri  # 产出 nsis/msi（Win）/ dmg（macOS）/ deb・AppImage（Linux）
```

> 生产包复用系统 WebView，安装包 ≤15MB；本机若为极低内存（<2GB），请使用开发服务器验证前端，Rust 完整 `cargo build` 建议在 ≥4GB 内存环境执行。

## 🤖 AI 配置

打开右侧 **AI 面板 → 引擎配置**：

| 提供商 | 说明 |
| --- | --- |
| DeepSeek | `deepseek-chat` / `deepseek-reasoner`（支持思考链） |
| OpenAI | 任意 OpenAI 兼容模型 |
| 智谱 GLM | `glm-4-flash` 等 |
| 自定义 | 任意 OpenAI 兼容端点（baseUrl + model + key） |
| 本地引擎 | llama.cpp `llama-server` sidecar（见下） |

**本地引擎（sidecar）**：将 `llama-server` 放入 PATH（或设 `HYPORA_LLAMA_PATH`），把 `.gguf` 模型放入 app data `models/` 目录，在面板中点击「启动引擎」。内核负责拉起、随机端口协商、健康检查，并随主进程退出（无孤儿进程）。

> 提示：云端 API Key 保存在本机 localStorage（`hypora_*`），属已知信任边界；后续版本演进至 OS keychain。

## ⌨️ 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl/⌘ + S` | 保存 |
| `Ctrl/⌘ + O` | 打开 |
| `Ctrl/⌘ + N` | 新建 |
| `Ctrl/⌘ + F` | 查找 / 替换 |
| `Ctrl/⌘ + J` | 开关 AI 面板 |
| `Ctrl/⌘ + Z` / `Ctrl/⌘ + Shift+Z` | 撤销 / 重做 |
| `Ctrl/⌘ + B` / `I` | 加粗 / 斜体 |

## 🗂 架构文档

详见 [`docs/architecture-v3.md`](docs/architecture-v3.md)：目标架构、决策依据（D1–D8）、进程契约（命令/事件清单）、非功能预算、路线图与风险登记。

## 📦 发布计划

- [x] P0：适配层 + 文件/开发/生命周期命令 + 事件 + 打包链路（.md 可打开/保存）
- [ ] P1：窗口命令 + frameless 自绘装饰 + 状态事件（已实现，待 WebView2 回归）
- [ ] P2：FS 文档索引 + 自动更新 + CSP 收紧
- [ ] P3：AI 流式 Rust 代理（已实现）+ sidecar 化本地引擎（已实现）

## 🛡 安全模型

- **能力白名单**：`capabilities/default.json` 最小授权，新命令默认拒绝
- **CSP**：`asset:` 本地资源 + AI 端点；渲染层零 Node
- **路径校验**：`write_file` 拒绝写入系统目录
- **sidecar 隔离**：仅 bind `127.0.0.1`，随机端口，随主进程退出

## 📄 License

MIT
