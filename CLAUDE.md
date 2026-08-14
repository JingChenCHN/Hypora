# Hypora

对标 Typora 的所见即所得 Markdown 编辑器。Vue 3 + TypeScript + Vite 8 + Electron/Tauri + Element Plus。写作工具，内容优先，UI 隐退。

## Design Context

> 权威源：`.impeccable.md`（含完整 token 决策）。改任何 UI 前**先读 `.impeccable.md`**。设计语言以官网落地页（hypora-site，Swiss 冷淡单色）为准，应用与落地页保持**同一套设计语言**。

### Users

Markdown 写作者（技术 / 知识工作者），桌面端专注写作；中途唤出右侧 AI 助手做改写 / 解释 / 翻译 / 扩写 / 总结 / 文档问答，再把结果插回编辑器。

### Brand Personality

**典雅 · 克制 · 精致**。冷淡单色 / Swiss：没有独立 accent，交互色即墨色。情感目标：信赖、宁静、专注、用得舒服——像一张安静的书桌，工具不抢纸面。

### Aesthetic Direction

- **冷淡单色（Cold Monochrome / Swiss）**：无彩色 accent，交互色即墨色（`--text-primary`）。发丝线（1px hair）分隔与描边，大留白、呼吸感。
- **方角**：radius 0–2px，克制地接近直角；不用 6–12px 大圆角。
- **扁平 + 发丝线**：常态卡片 / AI 气泡为平卡（hair 描边、无彩色阴影）；浮层用极淡阴影。
- **衬线点睛**：标题衬线（Georgia/Songti），正文与界面无衬线（易读），代码 JetBrains Mono；micro-label 用 11px / 0.2em / uppercase。
- **全部取 CSS 变量**（`src/themes/index.scss` 的 `--bg-*` / `--text-*` / `--accent-*` / `--border-color`），5 套主题（light/dark/beige/gray/ice）自动跟随。
- **参考**：官网落地页 hypora-site（Swiss 冷淡单色）+ Typora 编辑器。
- **不要**：独立 accent 色（橙/紫/霓虹）、大圆角气泡堆叠、花哨渐变 / 装饰性图标、紧凑信息堆叠、给 AI 面板引入独立 AI 色。

### Design Principles

1.  **内容优先，UI 隐退**——AI 面板是辅助，安静地存在，不抢编辑器焦点。
2.  **冷淡单色，无独立 accent**——交互色即墨色，强调用墨阶而非彩色；所有颜色取 CSS 变量，5 套主题自动跟随。
3.  **发丝线 + 方角**——1px hair 线做分隔描边，radius 0–2px，扁平为主；深度靠底色层级与极淡浮层阴影表达。
4.  **衬线点睛**——仅标题与展示用衬线，正文无衬线易读，不滥用衬线。
5.  **克制的精致**——精致来自间距 / 圆角 / 阴影 / 字体的微妙配比，而非装饰堆砌；动效轻（0.2–0.28s ease）。

### Design Language 一致性

- 应用 UI 与官网落地页（`hypora-site`）共用同一套冷淡单色设计语言：同 token、同方角、同发丝线、同衬线。
- 改动 UI 时对照 `.impeccable.md` 的 token 决策，保证与落地页观感一致，不出现两套视觉。
