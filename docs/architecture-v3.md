# Hypora 系统架构设计（成果方案）v3.0

> 最终交付基线：目标架构、决策依据、进程契约、非功能预算、路线图与风险登记。
> 日期：2026-08-05 ｜ 唯一桌面运行时：Tauri 2（Rust 内核 + 系统原生 WebView）

## 0. 执行摘要

Hypora 是内容优先、UI 隐退的所见即所得 Markdown 编辑器，内置双引擎 AI 写作助手（云端 OpenAI 兼容服务 + 本地 llama.cpp）。

架构一句话：以 Rust 为内核、系统 WebView 为渲染载体的轻量桌面壳，承载一个壳无关的 Vue 渲染层；所有跨边界能力经统一适配层以白名单 IPC 下发；AI 以 OpenAI 兼容协议为统一契约、可插拔多 provider。

### 核心决策

| # | 决策 | 收益 |
| --- | --- | --- |
| D1 | 唯一运行时 Tauri，不捆绑浏览器引擎 | 冷启动 ≤1s、安装包 ≤15MB、空载内存 ≤120MB |
| D2 | 渲染层壳无关 + 统一适配层 | 桌面/Web 同源；壳可替换、可测试 |
| D3 | AI 以 OpenAI 兼容协议为统一契约 | 云/本地/未来 provider 零成本接入 |
| D4 | 本地 LLM sidecar 化 | 本地 AI 开箱即用、生命周期受控 |
| D5 | AI 流式下沉 Rust 代理 | 绕开 WebView CORS/混合内容；统一超时/重试/取消 |
| D6 | 主题令牌单一事实源（Yaru） | 5 主题零成本跟随，设计一致性 |
| D7 | frameless + 自绘窗口装饰 | 跨平台一致的品牌窗口体验 |

## 1. 设计原则

- **内核最小信任面**：渲染层无脚本运行时、无任意 IO；一切外部能力经 Rust 命令白名单。
- **壳无关性**：渲染层只依赖适配层接口，不感知内核实现；Web 为自然降级。
- **协议优于实现**：AI、存储、窗口皆以稳定契约（协议/命令/事件）解耦具体实现。
- **性能是一等需求**：为启动/首屏/AI 首字设定量化预算，纳入验收。
- **优雅降级**：能力缺失（WebView2/本地引擎/网络）时功能级降级，不崩溃、不阻塞。

## 2. 非功能需求（NFR，目标值）

| 维度 | 目标 | 备注 |
| --- | --- | --- |
| 冷启动→可交互 | ≤ 1.0s（目标机：Win11/i5/16G） | Rust 内核 + WebView 直挂 + 分包 |
| 安装包体积 | ≤ 15MB（nsis/msi） | 复用系统 WebView2 |
| 空载内存 | ≤ 120MB | — |
| AI 首字（云） | ≤ 2s（网络正常） | 流式 SSE |
| AI 首字（本地） | ≤ 3s（1B 模型 CPU） | sidecar 预热可再降 |
| 数据零丢失 | 关闭/崩溃前落盘 | before-close + 防抖双保险 |
| 便携性 | Win10+/macOS/Linux | Win7 不支持（WebView2 下限） |
| 安全 | 能力白名单 + CSP | 渲染层零 Node |

## 3. 总体架构

```
┌──────────────────────── Rust 内核（Tauri） ────────────────────────┐
│  窗口生命周期(frameless/交通灯/置顶) · FS · IPC 网关 · 事件总线      │
│  sidecar 管理(本地 LLM) · AI 流式代理 · 日志/诊断 · 单实例 · 更新    │
└──────────────▲──────────────────────────────────▼────────────────┘
       invoke  │ 命令（白名单）                    │ 事件（emit/listen）
┌──────────────┴────── 统一适配层（唯一入口）───────────────────────┐
│  tauriAPI：invoke/listen 封装 · 类型契约 · Web fallback           │
└──────────────▲──────────────────────────────────▼────────────────┘
               │            Vue 渲染层（壳无关）
   App ─ Toolbar / Sidebar / Editor / Statusbar / SearchPanel /
         AIPanel / DevPanel / ImageBase64 / TrafficLights
   Pinia(document/ai) · utils(markdown/export/deepseek/devMode)
```

边界：内核↔渲染层仅两条通道——命令（请求/响应，Result）与事件（发布/订阅）。任何新能力必须落于契约表（§5），禁止隐式通道。

## 4. 关键架构决策（ADR 摘要）

- **D1** 唯一运行时 Tauri，不捆绑浏览器引擎。渲染引擎取系统 WebView2/WKWebView/WebKitGTK。代价：引擎版本碎片化；WebView2 缺失需引导安装。缓解：WebView 回归矩阵 + 启动自检引导 + Web 版兜底。
- **D2** 壳无关渲染层 + 统一适配层。渲染层只调 `tauriAPI`；适配层提供 Web fallback。
- **D3** OpenAI 兼容协议为 AI 统一契约。`streamChat` 只依赖 `/v1/chat/completions` SSE；思考链 `reasoning_content` 纳入契约。
- **D4** 本地 LLM sidecar 化。llama-server 受控 sidecar：拉起/端口协商/健康检查/随应用退出。
- **D5** AI 流式下沉 Rust 代理。`ai_stream` 命令（reqwest SSE），事件回推增量，取消经命令下发。
- **D6** 主题令牌单一事实源 `src/themes/index.scss`（Yaru 五主题，accent #E95420，dark aubergine #2C001E）；组件禁硬编码色。
- **D7** frameless + 自绘窗口装饰。`decorations:false`；交通灯/拖动区由渲染层自绘，经 `win_*` 命令控制内核窗口。
- **D8** 存储双轨演进。现状 localStorage `hypora_*` + 源文件写回；目标桌面侧元数据索引落 Rust FS。

## 5. 进程契约（命令 / 事件）

### 5.1 命令（invoke，Result）

| 域 | 命令 | 状态 |
| --- | --- | --- |
| 文件 | `open_file_dialog` / `save_dialog` / `write_file` / `write_binary_file` | ✅ 已实现 |
| 外壳 | `open_external` / `get_status` / `dev_log` / `export_diagnostics` / `show_log_file` | ✅ 已实现 |
| 启动 | `get_argv_md`（双击/参数 .md） | ✅ 已实现 |
| 生命周期 | `save_before_close` | ✅ 已实现 |
| 窗口 | `win_minimize` / `win_toggle_maximize` / `win_close` / `win_is_maximized` / `win_toggle_always_on_top` / `win_is_always_on_top` | ✅ 已实现 |
| AI | `ai_stream`（SSE 代理，事件回推）/ `ai_cancel` | ✅ 已实现 |
| sidecar | `sidecar_start` / `sidecar_stop` / `sidecar_status` | ✅ 已实现 |

### 5.2 事件（emit/listen）

| 事件 | 语义 | 状态 |
| --- | --- | --- |
| `open-file` | 双击/命令行打开 .md | ✅ 已实现 |
| `before-close` | 关闭前触发渲染层落盘 | ✅ 已实现 |
| `win-maximized` / `win-always-on-top` | 窗口状态同步 UI | ✅ 已实现 |
| `ai-chunk` / `ai-done` / `ai-error` | 流式增量/结束/错误 | ✅ 已实现 |

### 5.3 约定

命令 snake_case、事件 kebab/lower；payload 全 JSON 可序列化。错误统一 `Err(String)`；长任务必有取消通道（AbortController ↔ `ai_cancel` / `sidecar_stop`）。

## 6. 核心数据流

- **6.1 编辑管线**：键入 → 块级重渲染（保光标）→ 防抖 htmlToMd → store → 防抖写回源文件 + 缓存。undo/redo 自持历史栈（200）。
- **6.2 AI 管线**：上下文组装 → provider 选择 → `ai_stream` → 增量渲染（气泡）→ 用户确认 → insertTextAtCursor/replaceSelection 回编辑器。
- **6.3 打开管线**：双击/args → `get_argv_md` → emit `open-file` → 渲染层导入。
- **6.4 导出管线**：flushSync + normalizeCodeBlocks → md/HTML/PDF/图片（内核 `write_*` 落盘）。

## 7. 存储设计

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| 设置（主题/provider/key/视图） | localStorage `hypora_*` | 启动前预应用主题防闪屏 |
| 文档缓存 | localStorage（过渡）→ Rust FS 索引（目标） | 大图片溢出容错 |
| 源文件 | 用户路径 .md | 写回为主，缓存为辅 |
| 日志 | `data_dir/logs`（按日） | 渲染层 dev_log 转发内核 |
| 诊断 | 导出 .md 报告 | 应用/系统/最近日志三段 |

## 8. 安全模型

能力白名单（`capabilities/default.json` 最小授权）；CSP `asset:` 本地资源 + AI 端点；渲染层零 Node；`write_file` 路径校验；云端 key 客户端持有为已知信任边界 → 演进 OS keychain；sidecar 仅 bind 127.0.0.1、随机端口协商、随主进程退出。

## 9. 性能架构

启动预算（目标 ≤1.0s）：进程+WebView ≤300ms ｜ JS 首包执行 ≤300ms ｜ 首屏渲染 ≤300ms ｜ 主题预应用 0ms。

分包：Mermaid / Prism / marked 独立 chunk（manualChunks 函数式）；字体 @fontsource 子集（400/700）；预热 ensurePrismLangs；AI 面板常驻但内容懒载；块级 diff 重渲染（非全文）。

## 10. 可靠性与可观测

零丢失：before-close 落盘 + 编辑防抖双保险；单实例防双写。崩溃：uncaught/unhandledrejection → 内核日志；`export_diagnostics` 一键取证。更新：tauri-plugin-updater（P2）。降级：WebView2 缺失引导；本地引擎不可用 → 云引擎/提示；网络不可用 → 离线编辑不受影响。

## 11. 构建与发布

`npm run tauri build` → nsis/msi（≤15MB）；`frontendDist=../dist`、`beforeBuildCommand=npm run build`。图标 macOS26 风格（squircle + Hypora 衬线）SVG→多尺寸。`fileAssociations(.md/.markdown)` 原生关联。发布矩阵：Win 先行；macOS/Linux 跟进。

## 12. 实施路线（带退出准则）

| 阶段 | 内容 | 退出准则 |
| --- | --- | --- |
| P0（✅ 已完成） | 适配层 + 文件/开发/生命周期命令 + 事件 + 打包链路 | 双态可运行、.md 可打开/保存 |
| P1 | `win_*` 窗口命令 + decorations:false + 状态事件 | 交通灯/置顶/全屏/拖窗在 WebView2 回归通过 |
| P2 | FS 文档索引 + updater + CSP 收紧 | 5MB 溢出场景消失；可自动更新 |
| P3 | `ai_stream` Rust 代理 + sidecar | 本地 AI 开箱、移除 `--cors`、取消/超时可控 |

## 13. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| WebView2 缺失（老系统） | 中 | 中 | 启动自检引导；Web 兜底 |
| WebView 引擎碎片化 | 中 | 中 | 回归矩阵（contenteditable/CSS/字体） |
| sidecar 端口/进程残留 | 低 | 中 | 随机端口 + 健康检查 + 随主进程退出 |
| localStorage 容量溢出 | 中 | 中 | 已容错；P2 FS 索引根治 |
| 云端 key 客户端边界 | 高 | 中 | 声明边界；keychain 演进 |
| 本地模型冷启动慢 | 中 | 低 | sidecar 预热；模型选择指引 |

## 14. 附录

### 14.1 目录结构（目标）

```
Hypora/
├── src-tauri/            # Rust 内核：lib.rs(命令+setup) · ai.rs · sidecar.rs
│                          #   · tauri.conf.json · capabilities · icons
├── src/
│   ├── utils/tauriAPI.ts # 统一适配层（唯一跨边界入口）
│   ├── components/       # Editor/AIPanel/Toolbar/TrafficLights/ImageBase64/LottieLoading/…
│   ├── stores/           # document / ai
│   ├── utils/            # markdown / export / deepseek / editorBus / devMode
│   ├── themes/           # 唯一令牌源（Yaru 五主题）+ mixins
│   └── assets/           # reset.scss / ai-assistant.json / aiLoading.ts
└── scripts/generate-icon.cjs
```

### 14.2 术语

sidecar＝随主应用生命周期的本地推理子进程；适配层＝渲染层唯一跨边界入口；Yaru＝Ubuntu 设计语言（橙 #E95420 / 茄紫 #2C001E）。

---

> 本方案为最终交付基线。任何实现偏离须经 ADR 修订；令牌以 `src/themes/index.scss` 为事实源；契约以 §5 为唯一清单。
