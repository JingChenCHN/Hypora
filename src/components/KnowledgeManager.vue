<template>
  <!-- 知识库全屏管理页（类 ima）：检索模型/服务启停 + 多知识库 CRUD + 索引进度 -->
  <Teleport to="body">
    <Transition name="kbp-fade">
      <div v-if="visible" class="kbp-page">
        <header class="kbp-header">
          <div class="kbp-title-wrap">
            <span class="kbp-title">知识库</span>
            <span class="kbp-sub">本地检索 · 对话时自动注入启用的库</span>
          </div>
          <button class="kbp-close" @click="close">完成</button>
        </header>

        <div class="kbp-body">
          <!-- —— 检索模型（全局共用）+ 嵌入服务 —— -->
          <div class="kb-sec-label">检索模型</div>
          <div class="kb-card">
            <div class="kb-row">
              <span class="kb-dot" :class="modelDot"></span>
              <span class="kb-mono">{{ modelName }}</span>
              <span v-if="p && !p.model.ok" class="kb-badge warn">文件缺失</span>
              <span class="kb-spacer"></span>
              <button class="kb-link" @click="kbStore.pickAndSetModel()">{{ p?.model.path ? '更换模型' : '选择模型' }}</button>
            </div>
            <div class="kb-sub">{{ modelSub }}</div>

            <!-- 嵌入服务：手动启停 + 开机自动启动 -->
            <div class="kb-row kb-service">
              <span class="kb-dot kb-dot-lg" :class="kbStore.serviceDot"></span>
              <span class="kb-service-text">{{ kbStore.serviceText }}</span>
              <span v-if="servicePhase === 'failed'" class="kb-badge warn">查看日志</span>
              <span class="kb-spacer"></span>
              <span class="kb-micro">自动启动</span>
              <el-switch
                :model-value="p?.autoStart ?? false"
                size="small"
                @change="(v: string | number | boolean) => kbStore.setAutoStart(Boolean(v))"
              />
              <button
                v-if="servicePhase === 'running' || servicePhase === 'starting'"
                class="kb-link"
                @click="kbStore.stopService()"
              >停止服务</button>
              <button v-else class="kb-link" :disabled="!p?.model.ok" @click="kbStore.startService()">启动服务</button>
            </div>

            <!-- 视觉投影器（可选）：配置后来源文件夹内图片一并索引；探针失败降级显示原因 -->
            <div class="kb-row kb-mmproj">
              <span class="kb-dot" :class="mmprojDot"></span>
              <span class="kb-mmproj-label">视觉投影器</span>
              <template v-if="mmprojName">
                <span class="kb-mono">{{ mmprojName }}</span>
                <span class="kb-sub">{{ formatBytes(p?.model.mmproj?.size) }}</span>
                <span v-if="p?.model.mmproj?.missing" class="kb-badge warn">文件缺失</span>
                <el-tooltip v-else-if="imageOk === false && mmprojImageError" :content="mmprojImageError" placement="top">
                  <span class="kb-badge warn">图片不可用</span>
                </el-tooltip>
                <span class="kb-spacer"></span>
                <button class="kb-link" :disabled="kbStore.indexing" @click="kbStore.pickAndSetMmproj()">更换</button>
                <button class="kb-link" :disabled="kbStore.indexing" @click="onClearMmproj">清除</button>
              </template>
              <template v-else>
                <span class="kb-sub">未配置——选择 GGUF 视觉投影器后，文件夹内图片将一并索引</span>
              </template>
            </div>
          </div>

          <!-- —— 知识库列表 —— -->
          <div class="kb-sec-label">知识库</div>
          <div v-if="!p?.kbs.length" class="kb-empty">尚无知识库——新建后收录文件夹，其中的 Markdown（及配置投影器后的图片）会被本地索引</div>
          <div v-for="kb in p?.kbs || []" :key="kb.id" class="kb-card kb-kb">
            <div class="kb-row">
              <span class="kb-kb-name" :class="{ off: !kb.enabled }">{{ kb.name }}</span>
              <span v-if="!kb.enabled" class="kb-badge">已停用</span>
              <span class="kb-spacer"></span>
              <el-popover placement="bottom-end" :width="248" trigger="click" @show="beginEdit(kb)">
                <template #reference>
                  <button class="kb-link" :disabled="kbStore.indexing">参数</button>
                </template>
                <div class="kb-params">
                  <label class="kb-params-row">
                    <span>检索条数 topK</span>
                    <el-input-number v-model="edit.topK" :min="1" :max="12" size="small" />
                  </label>
                  <label class="kb-params-row">
                    <span>分块字数</span>
                    <el-input-number v-model="edit.chunkChars" :min="300" :max="2000" :step="100" size="small" />
                  </label>
                  <label class="kb-params-row">
                    <span>相似度门槛</span>
                    <el-input-number v-model="edit.minScore" :min="0" :max="1" :step="0.05" size="small" />
                  </label>
                  <button class="kb-link kb-params-save" @click="saveParams(kb)">保存</button>
                </div>
              </el-popover>
              <button class="kb-link" :disabled="kbStore.indexing" @click="onRename(kb)">重命名</button>
              <button class="kb-link" :disabled="kbStore.indexing" @click="onDelete(kb)">删除</button>
              <el-switch
                :model-value="kb.enabled"
                size="small"
                :disabled="kbStore.indexing"
                @change="(v: string | number | boolean) => kbStore.setKb(kb.id, { enabled: Boolean(v) })"
              />
            </div>
            <div class="kb-sub">{{ kbStat(kb) }}</div>

            <!-- 来源子列表 -->
            <div v-if="kb.sources.length" class="kb-sources">
              <div v-for="s in kb.sources" :key="s.dir" class="kb-source">
                <span class="kb-source-name">{{ baseName(s.dir) }}</span>
                <span v-if="s.missing" class="kb-badge warn">失联</span>
                <span v-else-if="s.staleCount" class="kb-badge">待更新 {{ s.staleCount }}</span>
                <span class="kb-source-meta">{{ srcStat(s) }}</span>
                <span class="kb-spacer"></span>
                <button class="kb-link" :disabled="kbStore.indexing" @click="kbStore.reindex({ kbId: kb.id, force: true })">重建</button>
                <button class="kb-link" :disabled="kbStore.indexing" @click="onRemoveSource(kb, s)">移除</button>
              </div>
            </div>
            <div v-else class="kb-sub">尚未收录文件夹</div>
            <button class="kb-add" :disabled="kbStore.indexing" @click="kbStore.addSource(kb.id)">＋ 添加文件夹</button>
          </div>
          <button class="kb-add" :disabled="kbStore.indexing" @click="onCreate">＋ 新建知识库</button>

          <!-- —— 索引进度 —— -->
          <template v-if="kbStore.indexing && kbStore.progress">
            <div class="kb-track"><div class="kb-fill" :style="{ transform: `scaleX(${progressPct / 100})` }"></div></div>
            <div class="kb-readout">{{ progressText }}</div>
          </template>

          <!-- —— 操作行 —— -->
          <div class="kb-actions">
            <button class="kb-link" :disabled="kbStore.indexing" @click="kbStore.reindex({})">全部重新索引</button>
            <template v-if="kbStore.indexing">
              <button class="kb-link" @click="kbStore.cancelIndex()">取消索引</button>
            </template>
            <button class="kb-link" @click="kbStore.openIndexDir()">打开索引目录</button>
            <span class="kb-spacer"></span>
            <span v-if="p?.totals.chunks" class="kb-sub">共 {{ p.totals.chunks.toLocaleString() }} 段 · {{ p.totals.files }} 个文件<template v-if="p.totals.images"> · {{ p.totals.images }} 图片</template></span>
          </div>

          <p class="kb-hint">索引与检索全部在本机完成：文件改动后下次对话时自动增量更新；检索片段仅注入对话上下文，文件内容不会上传。配置视觉投影器后，来源文件夹中的图片（png/jpg/webp/gif/bmp）也会被索引，命中时以「[图片] 文件名」注入对话。</p>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, reactive, watch, onMounted, onBeforeUnmount } from 'vue'
import { ElMessageBox } from 'element-plus'
import { useKbStore } from '@/stores/kb'
import type { KbItem, KbSourceEntry } from '@/utils/knowledge'

const kbStore = useKbStore()
const p = computed(() => kbStore.payload)

// 页面开关代理到 store（AIPanel / Toolbar / 原生菜单都能打开同一页面）
const visible = computed({
  get: () => kbStore.managerOpen,
  set: (v: boolean) => { kbStore.managerOpen = v },
})
function close() { kbStore.managerOpen = false }

// 打开时对账一次（别处可能改过配置）；Escape 关页
watch(visible, (v) => { if (v) void kbStore.refresh() })
function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && kbStore.managerOpen) close() }
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

// —— 嵌入服务行 ——
const servicePhase = computed(() => kbStore.status?.phase ?? p.value?.status?.phase ?? 'stopped')

// —— 模型行 ——
const modelName = computed(() => {
  const mp = p.value?.model.path
  if (!mp) return '未选择模型'
  return mp.split(/[\\/]/).pop() || mp
})

const modelDot = computed(() => {
  if (kbStore.ready) return 'ok'
  if (p.value && !p.value.model.ok) return 'err'
  return 'off'
})

const modelSub = computed(() => {
  const v = p.value
  if (!v) return '检测中…'
  if (!v.model.path) return '选择本地 GGUF 嵌入模型（如 EmbeddingGemma）'
  const size = v.model.size ? formatBytes(v.model.size) : ''
  const dim = v.model.dim ? ` · ${v.model.dim} 维` : ''
  if (!v.model.ok) return [v.model.error || '模型文件不存在', size].filter(Boolean).join(' · ')
  return [size, dim].filter(Boolean).join('') || v.model.path
})

// —— 视觉投影器行 ——
const mmprojName = computed(() => {
  const mp = p.value?.model.mmproj?.path
  if (!mp) return ''
  return mp.split(/[\\/]/).pop() || mp
})

const mmprojDot = computed(() => {
  const mm = p.value?.model.mmproj
  if (mm?.configured && (mm.missing || mm.imageOk === false)) return 'err'
  if (mm?.active) return 'ok'
  return 'off'
})

const imageOk = computed(() => p.value?.model.mmproj?.imageOk ?? null)

const mmprojImageError = computed(() => p.value?.model.mmproj?.imageError || '')

// 清除前确认：图片分片会在下次索引时清掉，文本分片不受影响
async function onClearMmproj() {
  try {
    await ElMessageBox.confirm(
      '清除视觉投影器？来源文件夹中的图片将不再被索引（文本索引不受影响）。',
      '清除视觉投影器',
      { confirmButtonText: '清除', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  await kbStore.clearMmproj()
}

// —— 单库参数弹层（主进程夹紧 topK 1-12 / chunkChars 300-2000 / minScore 0-1） ——
const edit = reactive({ topK: 5, chunkChars: 900, minScore: 0.3 })
function beginEdit(kb: KbItem) {
  edit.topK = kb.topK
  edit.chunkChars = kb.chunkChars
  edit.minScore = kb.minScore
}
function saveParams(kb: KbItem) {
  void kbStore.setKb(kb.id, {
    topK: Number(edit.topK) || kb.topK,
    chunkChars: Number(edit.chunkChars) || kb.chunkChars,
    minScore: Number.isFinite(edit.minScore) ? edit.minScore : kb.minScore,
  })
}

// —— 库行 ——
function kbStat(kb: KbItem): string {
  const parts = [`${kb.stats.files} 个文件`, `已索引 ${kb.stats.files - kb.stats.stale}`, `${kb.stats.chunks.toLocaleString()} 段`]
  if (kb.stats.images) parts.push(`${kb.stats.images} 图片`)
  if (kb.stats.stale) parts.push(`${kb.stats.stale} 待更新`)
  return parts.join(' · ')
}

function srcStat(s: KbSourceEntry): string {
  const parts = [`${s.fileCount} 文件`, `${s.chunkCount.toLocaleString()} 段`]
  if (s.imageCount) parts.push(`${s.imageCount} 图片`)
  return parts.join(' · ')
}

async function onCreate() {
  try {
    const { value } = await ElMessageBox.prompt('为新知识库起个名字（可留空使用默认名）', '新建知识库', {
      confirmButtonText: '创建',
      cancelButtonText: '取消',
      inputPlaceholder: `知识库 ${(p.value?.kbs.length || 0) + 1}`,
      inputValidator: (v: string) => !v || !v.trim() || v.trim().length <= 40 || '名称不超过 40 字',
    })
    await kbStore.createKb(value)
  } catch { /* 取消 */ }
}

async function onRename(kb: KbItem) {
  try {
    const { value } = await ElMessageBox.prompt('新的名称', '重命名知识库', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      inputValue: kb.name,
      inputValidator: (v: string) => (v && v.trim() ? v.trim().length <= 40 || '名称不超过 40 字' : '名称不能为空'),
    })
    await kbStore.renameKb(kb.id, value)
  } catch { /* 取消 */ }
}

async function onDelete(kb: KbItem) {
  try {
    await ElMessageBox.confirm(
      `删除「${kb.name}」？该库的索引将一并清除，来源文件不受影响。`,
      '删除知识库',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  await kbStore.deleteKb(kb.id)
}

async function onRemoveSource(kb: KbItem, s: KbSourceEntry) {
  try {
    await ElMessageBox.confirm(
      `从「${kb.name}」移除「${baseName(s.dir)}」？该库中对应的索引将被删除，文件本身不受影响。`,
      '移除来源',
      { confirmButtonText: '移除', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  await kbStore.removeSource(kb.id, s.dir)
}

// —— 进度 ——
const progressPct = computed(() => {
  const pr = kbStore.progress
  if (!pr || !pr.total) return 0
  return Math.min(100, Math.round((pr.done / pr.total) * 100))
})

const progressText = computed(() => {
  const pr = kbStore.progress
  if (!pr) return ''
  const parts: string[] = []
  if (pr.kbName) parts.push(pr.kbName)
  if (pr.file) parts.push(pr.file)
  else if (pr.phase === 'scanning') parts.push('扫描文件…')
  parts.push(`${pr.done}/${pr.total}`, `${pr.chunks.toLocaleString()} 段`)
  return parts.join(' · ')
})

function baseName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() || dir
}

function formatBytes(n?: number | null): string {
  if (!n) return '—'
  const gb = n / (1024 * 1024 * 1024)
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  const mb = n / (1024 * 1024)
  if (mb >= 1) return `${Math.round(mb)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}
</script>

<style scoped lang="scss">
/* ===== 全屏页壳：盖 Toolbar/AIPanel，低于 SearchPanel/MediaViewer ===== */
.kbp-page {
  position: fixed;
  inset: 0;
  z-index: 500;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
}
.kbp-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  height: 56px;
  padding: 0 28px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
}
.kbp-title-wrap {
  display: flex;
  align-items: baseline;
  gap: 10px;

  .kbp-title {
    font-family: var(--font-serif);
    font-size: 16px;
    color: var(--text-primary);
  }

  .kbp-sub {
    font-size: 11px;
    letter-spacing: 0.1em;
    color: var(--text-muted);
  }
}
.kbp-close {
  margin-left: auto;
  font-family: inherit;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 2px;
  padding: 4px 14px;
  cursor: pointer;
  transition: all 0.2s;
  &:hover { color: var(--text-primary); border-color: var(--text-secondary); }
}
.kbp-body {
  flex: 1;
  overflow-y: auto;
  width: 100%;
  max-width: 860px;
  margin: 0 auto;
  padding: 26px 40px 48px;
}
.kbp-fade-enter-active,
.kbp-fade-leave-active { transition: opacity 0.2s ease; }
.kbp-fade-enter-from,
.kbp-fade-leave-to { opacity: 0; }

/* ===== 区块与卡片（沿用抽屉版规格：micro-label + 平卡 + hair 线） ===== */
.kb-sec-label {
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin: 22px 0 10px;
  &:first-of-type { margin-top: 0; }
}
.kb-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  margin-bottom: 10px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 2px;
}
.kb-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.kb-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--border-color);
  &.ok { background: var(--el-color-success); }
  &.err { background: var(--el-color-danger); }
  &.off { background: var(--border-color); }
  &.kb-dot-lg { width: 8px; height: 8px; }
}
.kb-mono {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary);
  word-break: break-all;
}
/* 嵌入服务行：engine-row 同构（大号 dot + 状态文本 + 启停） */
.kb-service {
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--border-color);
}
.kb-service-text {
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.kb-micro {
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.kb-kb-name {
  font-size: 13.5px;
  color: var(--text-primary);
  &.off { color: var(--text-muted); }
}
.kb-badge {
  font-size: 10px;
  letter-spacing: 0.16em;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  padding: 0 4px;
  border-radius: 2px;
  &.warn { color: var(--el-color-danger); border-color: var(--el-color-danger); }
}
.kb-spacer { flex: 1; }
.kb-sub {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  word-break: break-all;
}
/* 视觉投影器行：可选配置，弱化存在（内部 hair 线分隔） */
.kb-mmproj {
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--border-color);
}
.kb-mmproj-label {
  font-size: 12px;
  color: var(--text-secondary);
  flex-shrink: 0;
}
/* 来源子列表：缩进 hair 左线 + 统计弱化 */
.kb-sources {
  margin: 6px 0 2px;
  padding-left: 12px;
  border-left: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.kb-source {
  display: flex;
  align-items: center;
  gap: 6px;
}
.kb-source-name {
  font-size: 12.5px;
  color: var(--text-secondary);
}
.kb-source-meta {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
}
.kb-empty {
  font-size: 12px;
  color: var(--text-muted);
  padding: 12px 14px;
  margin-bottom: 10px;
  border: 1px dashed var(--border-color);
  border-radius: 2px;
  line-height: 1.6;
}
.kb-link {
  border: none;
  background: none;
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
  color: var(--text-muted);
  padding: 2px 4px;
  border-radius: 2px;
  transition: all 0.2s;
  flex-shrink: 0;
  &:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-tertiary); }
  &:disabled { opacity: 0.4; cursor: default; }
}
.kb-add {
  align-self: flex-start;
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 2px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-secondary);
  cursor: pointer;
  font-family: inherit;
  transition: all 0.2s;
  margin-bottom: 10px;
  &:hover:not(:disabled) { color: var(--text-primary); border-color: var(--text-secondary); }
  &:disabled { opacity: 0.4; cursor: default; }
}
/* 参数弹层 */
.kb-params {
  display: flex;
  flex-direction: column;
  gap: 10px;

  .kb-params-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .kb-params-save {
    align-self: flex-end;
  }
}
/* 进度：2px 方角轨道，墨色填充，scaleX 变换（避免 width 布局动画） */
.kb-track {
  height: 2px;
  margin-top: 16px;
  background: var(--border-color);
  overflow: hidden;
}
.kb-fill {
  height: 100%;
  background: var(--text-primary);
  transform-origin: left;
  transition: transform 0.2s linear;
}
.kb-readout {
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  margin-top: 4px;
  word-break: break-all;
}
.kb-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 16px;
}
.kb-hint {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
  margin: 12px 0 0;
}
</style>
