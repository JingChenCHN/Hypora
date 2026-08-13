# Hypora

对标 Typora 的所见即所得 Markdown 编辑器。Vue 3 + TypeScript + Vite 8 + Electron/Tauri + Element Plus。写作工具，内容优先，UI 隐退。

## Design Context

> 权威源：`.impeccable.md`（含完整 token 决策）。改任何 UI 前**先读 `.impeccable.md`**。

### Users

Markdown 写作者（技术 / 知识工作者），桌面端专注写作；中途唤出右侧 AI 助手做改写 / 解释 / 翻译 / 扩写 / 总结 / 文档问答，再把结果插回编辑器。

### Brand Personality

**典雅 · 克制 · 精致**。对标 Typora 的「内容优先」+ Apple 柔和留白。情感目标：信赖、宁静、专注、用得舒服。

### Aesthetic Direction

- **Apple 柔和留白**：毛玻璃、大圆角气泡卡片（12px）、柔和低阴影、留白多、呼吸感。
- **沿用主 accent，不引入 AI 独立色**：全部取 `src/themes/index.scss` 的 CSS 变量（`--bg-*` / `--text-*` / `--accent-*` / `--border-color`），5 套主题（light/dark/beige/gray/ice）自动跟随。
- **字体**：AI 回复**标题用衬线**（书卷典雅），正文与界面无衬线（易读），代码 JetBrains Mono。
- **参考**：Apple Notes / Messages 气泡 + Typora 编辑器 + Obsidian Claudian。
- **不要**：Linear 锐利几何、紧凑信息堆叠、花哨渐变 / 霓虹、紫色等 AI 独立色、装饰性图标与动效滥用。

### Design Principles

1.  **内容优先，UI 隐退**——AI 面板是辅助，安静地存在，不抢编辑器焦点。
2.  **气泡卡片 + 柔和阴影**——对话以卡片承载，大圆角 12px，低对比阴影，呼吸感。
3.  **沿用主题 token，不引入独立配色**——所有颜色取 CSS 变量，5 套主题自动跟随。
4.  **衬线点睛**——仅 AI 回复标题用衬线，正文无衬线易读，不滥用衬线。
5.  **克制的精致**——精致来自间距 / 圆角 / 阴影 / 字体的微妙配比，而非装饰堆砌；动效轻（0.2–0.28s ease）。