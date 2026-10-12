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

# 知识库（本地 RAG，Electron 桌面专属）

**完全自研的手写 RAG**（无 LangChain / LlamaIndex），唯一外部依赖是 llama.cpp 的 `llama-server` 二进制（GGUF 嵌入推理）。Web 版无此功能，全链路 `hasKnowledge()` 门控。

## 架构分层

| 层 | 实现 | 位置 |
|---|---|---|
| 推理 | spawn `llama-server --embedding --pooling mean`（CPU），端口池 8910-8919，OpenAI 兼容 `/v1/embeddings`，批 8 条 | `electron-kb.cjs` |
| 分块 | `chunkMarkdown`：标题切段带面包屑、段落打包 900 字、超长按句切、围栏代码块原子不切 | `electron-kb-lib.cjs` |
| 存储 | JSON 分片，一路一文件（sha1 命名），base64 Float32 + L2 归一化 | `electron-kb-lib.cjs` |
| 检索 | 暴力余弦（归一化后退化为点积）+ minScore 过滤 + 多库 `mergeKbHits` 合并 | `electron-kb-lib.cjs` |
| 编排 | 增量指纹（文件 mtime/size + 模型 size/mtime + dim + 版本，任一不符即重建）、staging→publish 原子发布、全局单飞 | `electron-kb.cjs` |

## 多知识库（v2）

- `kb.json` v2：嵌入模型**全局共用**（一个 GGUF + 一个 llama-server），`kbs[]` 各库独立 `enabled/topK/chunkChars/minScore/sources`；索引按库分目录 `index/<kbId>/`；v1 自动迁移为「默认知识库」（幂等）
- 检索：全部启用库一起查——各库按自身 topK/minScore 截取后 `mergeKbHits` 全局合并（防大库淹没小库），命中带 `kbId/kbName`
- 互斥：索引中删库/换模型/移除来源一律拒绝；换模型或维度变化清全部库索引；`chunkChars` 变更仅清该库
- 管理 UI：`KnowledgeManager.vue`（640px 抽屉大栏目），取代 KnowledgeDialog（已删）；入口：Toolbar 文件菜单 / 原生菜单 / AIPanel「管理」，共享 `kbStore.managerOpen`

## 不变量（改动前先确认）

- 聊天安全参数：检索预算 6000ms、冷却 60s、单条截断 1200 字、注入预算 `injectCharBudget`（全局）；`retrieveForChat` 签名与 `ChatMessage.kbNote` 持久化结构不变（向后兼容）
- 索引/分片均为 lib 纯函数，`electron-kb.cjs`（主进程编排）与 `scripts/kb-harness.cjs`（测试）共用

## 测试

- `node scripts/kb-harness.cjs`：纯 Node 状态机测试（服务器跑不了 llama.cpp，GLIBC 太老），覆盖迁移/CRUD/合并/短路等 ~37 例
- `KB_LIVE=1 KB_MODEL=<真实gguf>` 真实端到端双库链路，仅在 Windows 上跑

## 设计取舍与升级路径

- **不上框架**：桌面 app 要零安装/零服务/离线可用，框架的向量存储全接外部 DB（Chroma/FAISS/pgvector）；独立 llama-server 进程绕开 node-llama-cpp 的 Electron ABI/native 编译坑；编排仅 4 步，框架是负担
- **对齐业界**：OpenAI 兼容 embedding API（换模型不改管线）；EmbeddingGemma 官方 prompt 前缀（`task: search result | query:`，其他模型退化纯文本）；L2 归一化 + 点积
- **量级边界**：暴力扫描 1 万 chunk 毫秒级，10 万 chunk 数百毫秒
- **升级路径**（触发才做，存储/检索皆纯函数可单独替换）：量级上来 → sqlite-vec（单文件无服务）或 usearch；查函数名/报错码等精确词不准 → SQLite FTS5 关键词路做混合检索；质量仍不够 → 本地 reranker GGUF

# 本机是生产服务器

本机（`admin`，Linux，位于 `/home/hemo/Hypora`）就是生产服务器，项目即部署源码。开发、构建、部署都在此完成，改完可直接更新线上站点。

## 站点部署

### Web 版在线测试站（本机站点）

> ⚠️ 线上真实站点是 **`/www/wwwroot/hypora-web`**（nginx :8011 服务此目录），**不是** `/www/wwwroot/Hypora/web`（那是早期废弃目录，nginx 未引用）。之前多次「sudo 拷到 /www/wwwroot/Hypora/web」等于部署到了不可见目录——线上看到的始终是老版本。部署一律走 `hypora-web`。

- **线上根路径**：`/www/wwwroot/hypora-web`（属 `root`，需用 `sudo` 写）
- **构建**：`npm run build` → 产物 `dist/`
- **更新流程**：
  ```bash
  # 需 sudo，目标目录属 root 无普通用户写权限
  sudo rm -rf /www/wwwroot/hypora-web/assets /www/wwwroot/hypora-web/index.html
  sudo cp -r /home/hemo/Hypora/dist/. /www/wwwroot/hypora-web/
  ```
- 站点用相对路径（base './'），支持子路径部署；更新时务必清掉旧 `assets` 缓存（与 index.html）再拷贝，避免残留哈希文件 404
- 部署后（浏览器如果缓存仍加载旧版本）测试链接等特性。

### Web 版 AI 同源代理（server.cjs）

- **用途**：网页版 DeepSeek/GLM 云调用经同源 `/api/ai` 转发，规避 CORS + 不让 key 落服务器。每个访客用自己的 key，代理只透传不存储（无站点级密钥）。
- **运行**：pm2 常驻 → **`hypora-web-proxy`**（`pm2 start /www/wwwroot/hypora-web/server.cjs --name hypora-web-proxy`），监听 **:8080**，已 `pm2 save` + `pm2 startup` 开机自启。
- **nginx**：`/etc/nginx/conf.d/hypora.conf` 的 8011 server 块内有 `location /api/ai { proxy_pass http://127.0.0.1:8080; ... proxy_buffering off; }`。
- **改前端代理逻辑**看 `src/utils/deepseek.ts`（`isTauriEnv()` 判断网页版走代理、桌面版直连）；代理文件在 `/www/wwwroot/hypora-web/server.cjs`（仓库根 `server.cjs`）。
- 代理本身在仓库 `server.cjs`，改动后记得 `pm2 restart hypora-web-proxy` 生效。

### 桌面版（Windows EXE）Release

- CI：`.github/workflows/build-release.yml`，推 `v*` tag 或手动 `workflow_dispatch` 触发，产出 NSIS 安装版 + 便携版。
- 与 Web 站点无关，走 GitHub Release。

> 注：仓库里没有「部署脚本」，更新站点即执行上面的 sudo 拷贝步骤。
