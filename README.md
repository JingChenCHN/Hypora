# Hypora - Web端在线Markdown编辑器

对标Typora的Web端Markdown编辑器，实现所见即所得的实时一体化编辑体验，无左右分栏。

## ✨ 核心特性

- 🎯 **所见即所得** - 实时一体化编辑预览，输入Markdown语法立即渲染
- 📝 **全语法支持** - 标题、粗体/斜体/删除线/高亮、行内代码、代码块(语法高亮)、有序/无序列表、任务清单、引用、分割线、表格、图片、链接、LaTeX数学公式、Mermaid流程图、Emoji
- 💾 **本地存储** - 自动保存到浏览器localStorage，刷新不丢失，支持多文档管理
- 📤 **多格式导出** - 支持导出Markdown、HTML、PDF、图片
- ⌨️ **丰富快捷键** - 复刻Typora快捷键，Ctrl+B加粗、Ctrl+#标题、Ctrl+S保存等
- 🎨 **多主题切换** - 内置浅色白、暗色黑、米色护眼、极简灰、冰雪五套主题
- 📊 **大纲导航** - 自动生成文档大纲，滚动自动跟随高亮
- 🔍 **搜索替换** - 支持文档内搜索和替换功能
- 🖼️ **图片粘贴** - 支持剪贴板粘贴图片、拖拽上传图片
- 🌙 **暗色模式** - 全局暗色模式适配，代码块、表格、公式同步变色
- 📱 **响应式适配** - 支持PC端浏览器，简单移动端适配
- 🔌 **离线可用** - 纯前端实现，无需后端，开箱即用

## 🛠️ 技术栈

- **框架**: Vue 3 + TypeScript + Vite
- **UI组件**: Element Plus
- **Markdown解析**: Marked
- **代码高亮**: Prism.js
- **流程图**: Mermaid
- **状态管理**: Pinia
- **导出功能**: FileSaver + html2canvas + jsPDF

## 🚀 快速开始

### 安装依赖

```bash
npm install
```

### 启动开发服务器

```bash
npm run dev
```

访问 [http://localhost:5300](http://localhost:5300) 即可使用

### 构建生产版本

```bash
npm run build
```

构建产物在`dist`目录，可直接部署到任意静态文件服务器

### 预览生产构建

```bash
npm run preview
```

## 📖 使用说明

### 基本操作

- **新建文档**: 点击工具栏「文件」→「新建文档」，或侧边栏「新建文档」按钮
- **打开本地文件**: 点击工具栏「文件」→「打开本地文件」，选择本地.md文件
- **保存/导出**: 点击工具栏「文件」选择导出格式，或按Ctrl+S手动保存到本地存储
- **切换源码模式**: 点击工具栏「源码模式」按钮，或按Ctrl+/ 切换
- **全屏模式**: 按F11进入全屏编辑模式，鼠标移到顶部显示工具栏

### 快捷键（对标 Typora）

快捷键

功能

Ctrl + S

保存文档

Ctrl + B

加粗

Ctrl + I

斜体

Ctrl + U

下划线

Alt + Shift + 5 / Ctrl + Shift + S

删除线

Ctrl + Shift + H

高亮

Ctrl + \`

行内代码

Ctrl + Shift + K

代码块

Ctrl + Shift + M

数学公式块

Ctrl + K

插入链接

Ctrl + Shift + I

插入图片

Ctrl + 1~6

标题1-6级

Ctrl + 0

普通段落

Ctrl + \] / Ctrl + \[

标题级别 升/降

Ctrl + Shift + T

插入表格

Ctrl + Shift + Q

引用块

Ctrl + Shift + U

无序列表

Ctrl + Shift + O

有序列表

Ctrl + Shift + X

任务列表

Ctrl + \\

清除格式

Ctrl + /

切换源码模式

Ctrl + F

查找

Ctrl + H

查找替换

F9

侧边栏

F11

全屏模式

Ctrl + Shift + = / - / 0

放大/缩小/重置缩放

F12

开发者面板

### Markdown语法支持

- 输入`# 空格`自动转为标题
- 输入`*` 或`- 空格`自动转为无序列表
- 输入`1. 空格`自动转为有序列表
- 输入`> 空格`自动转为引用块
- 输入\`\`\`\`\`回车生成代码块，支持多语言语法高亮
- 输入`---`回车生成分割线
- 输入`[ ] 空格`生成任务清单
- 直接粘贴或拖拽图片自动插入

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
│   │   ├── Statusbar.vue   # 底部状态栏
│   │   └── SearchPanel.vue # 搜索替换面板
│   ├── composables/        # 组合式函数
│   │   └── useShortcuts.ts # 快捷键处理
│   ├── config/             # 配置文件
│   │   └── editor.ts       # 编辑器配置
│   ├── stores/             # Pinia状态管理
│   │   └── document.ts     # 文档状态管理
│   ├── themes/             # 主题样式
│   │   └── index.scss      # 主题变量和Markdown样式
│   ├── utils/              # 工具函数
│   │   ├── markdown.ts     # Markdown解析渲染核心
│   │   └── export.ts       # 导出功能
│   ├── App.vue             # 根组件
│   ├── main.ts             # 入口文件
│   └── env.d.ts            # 类型声明
├── index.html              # HTML模板
├── vite.config.ts          # Vite配置
├── tsconfig.json           # TypeScript配置
└── package.json            # 依赖配置
```

## 🚢 部署方案

### 纯静态部署（推荐）

构建后的`dist`目录可直接部署到任意静态托管服务：

- Nginx
- Vercel/Netlify
- GitHub Pages/Gitee Pages
- 阿里云OSS/腾讯云COS

### Nginx配置示例

```nginx
server {
    listen 80;
    server_name your-domain.com;
    root /path/to/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

### 带云端后端方案（可选）

如果需要云端文档同步功能，可配套后端：

1.  后端技术栈：Node.js + Express + MySQL/PostgreSQL
2.  需要实现的接口： - 用户认证（注册/登录） - 文档CRUD接口 - 图片上传接口 - 文档分享接口
3.  前端修改： - 增加登录注册页面 - 修改文档存储逻辑，改为请求后端接口 - 增加协作邀请、分享功能

## 🔮 扩展优化方案

### 计划支持功能

- [ ] 多人实时协作（基于Yjs/WebRTC）
- [ ] 云同步功能（跨设备同步文档）
- [ ] 自定义插件系统
- [ ] 更多主题支持
- [ ] 字体/字号/行高自定义设置
- [ ] 文档历史版本回溯
- [ ] 导出Word格式
- [ ] 支持Vditor等编辑器内核切换
- [ ] PWA支持，离线可安装

### 性能优化方向

- 大文档懒加载
- 虚拟滚动优化
- Web Worker处理Markdown解析，避免阻塞主线程
- 图片懒加载和压缩

## 📄 开源协议

MIT License

## 🤝 贡献

欢迎提交Issue和Pull Request！