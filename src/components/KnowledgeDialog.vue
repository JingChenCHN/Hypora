<template>
  <el-dialog v-model="visible" title="知识库管理" width="540px" :close-on-click-modal="false">
    <!-- 检索模型 -->
    <div class="kb-sec-label">检索模型</div>
    <div class="kb-card">
      <div class="kb-row">
        <span class="kb-dot" :class="modelDot"></span>
        <span class="kb-model-name">{{ modelName }}</span>
        <span v-if="p?.modelMissing" class="kb-badge warn">文件缺失</span>
        <span class="kb-spacer"></span>
        <button class="kb-link" @click="kbStore.pickAndSetModel()">{{ p?.config.modelPath ? '更换模型' : '选择模型' }}</button>
      </div>
      <div class="kb-sub">{{ modelSub }}</div>
    </div>

    <!-- 收录文件夹 -->
    <div class="kb-sec-label">收录文件夹</div>
    <div v-if="!p?.sources.length" class="kb-empty">尚未收录文件夹——添加后其中的 Markdown 会被本地索引，供对话时检索</div>
    <div v-for="s in p?.sources || []" :key="s.dir" class="kb-card">
      <div class="kb-row">
        <span class="kb-source-name">{{ baseName(s.dir) }}</span>
        <span v-if="s.missing" class="kb-badge warn">失联</span>
        <span v-else-if="s.staleCount" class="kb-badge">待更新 {{ s.staleCount }}</span>
        <span class="kb-spacer"></span>
        <button class="kb-link" :disabled="kbStore.indexing" @click="kbStore.reindex({ dir: s.dir })">重建</button>
        <button class="kb-link" @click="onRemove(s)">移除</button>
      </div>
      <div class="kb-sub mono">{{ s.dir }}</div>
      <div class="kb-sub">{{ sourceStat(s) }}</div>
    </div>
    <button class="kb-add" @click="kbStore.addSource()">＋ 添加文件夹</button>

    <!-- 索引进度 -->
    <template v-if="kbStore.indexing && kbStore.progress">
      <div class="kb-track"><div class="kb-fill" :style="{ transform: `scaleX(${progressPct / 100})` }"></div></div>
      <div class="kb-readout">{{ progressText }}</div>
    </template>

    <!-- 操作行 -->
    <div class="kb-actions">
      <button class="kb-link" :disabled="kbStore.indexing" @click="kbStore.reindex({ force: false })">全部重新索引</button>
      <template v-if="kbStore.indexing">
        <button class="kb-link" @click="kbStore.cancelIndex()">取消索引</button>
      </template>
      <button class="kb-link" @click="kbStore.openIndexDir()">打开索引目录</button>
      <span class="kb-spacer"></span>
      <span v-if="p?.totals.chunks" class="kb-sub">共 {{ p.totals.chunks.toLocaleString() }} 段 · {{ p.totals.files }} 个文件</span>
    </div>

    <p class="kb-hint">索引与检索全部在本机完成：文件改动后下次对话时自动增量更新；检索片段仅注入对话上下文，文件内容不会上传。</p>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useKbStore } from '@/stores/kb'
import type { KbSourceEntry } from '@/utils/knowledge'

const visible = defineModel<boolean>({ default: false })
const kbStore = useKbStore()
const p = computed(() => kbStore.payload)

// —— 模型行 ——
const modelName = computed(() => {
  const mp = p.value?.config.modelPath
  if (!mp) return '未选择模型'
  return mp.split(/[\\/]/).pop() || mp
})

const modelDot = computed(() => {
  if (kbStore.ready) return 'ok'
  if (p.value && !p.value.modelOk) return 'err'
  return 'off'
})

const modelSub = computed(() => {
  const v = p.value
  if (!v) return '检测中…'
  if (!v.config.modelPath) return '选择本地 GGUF 嵌入模型（如 EmbeddingGemma）'
  const size = v.modelSize ? formatBytes(v.modelSize) : ''
  const dim = v.config.dim ? ` · ${v.config.dim} 维` : ''
  if (v.modelMissing) return [v.modelError || '模型文件不存在', size].filter(Boolean).join(' · ')
  return [size, dim].filter(Boolean).join('') || v.modelPath
})

// —— 来源行 ——
function baseName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() || dir
}

function sourceStat(s: KbSourceEntry): string {
  if (s.missing) return '目录无法访问，已保留索引'
  const parts = [`${s.fileCount} 个文件`, `已索引 ${s.indexedFiles}`, `${s.chunkCount.toLocaleString()} 段`]
  if (s.oversized || s.bytes > 0) parts.push(formatBytes(s.bytes))
  return parts.join(' · ')
}

async function onRemove(s: KbSourceEntry) {
  try {
    await ElMessageBox.confirm(
      `移除「${baseName(s.dir)}」？其中的索引将被删除，文件本身不受影响。`,
      '移除来源',
      { confirmButtonText: '移除', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  kbStore.removeSource(s.dir)
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
  const phase = pr.phase === 'scanning' ? '扫描文件' : pr.phase === 'saving' ? '写入索引' : '嵌入向量'
  const dir = pr.dir ? ' · ' + baseName(pr.dir) : ''
  return `${phase}${dir} · ${pr.done}/${pr.total} · ${pr.chunks.toLocaleString()} 段`
})

function formatBytes(n?: number | null): string {
  if (!n) return '—'
  const gb = n / (1024 * 1024 * 1024)
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  const mb = n / (1024 * 1024)
  if (mb >= 1) return `${Math.round(mb)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

// 弹窗打开时对账一次（可能别处改过配置）
watch(visible, (v) => { if (v) void kbStore.refresh() })
</script>

<style scoped lang="scss">
/* 区块微标签：与 AIPanel .model-card-label 同规格 */
.kb-sec-label {
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin: 14px 0 8px;
  &:first-of-type { margin-top: 0; }
}
/* 平卡：hair 描边、方角、无阴影 */
.kb-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  margin-bottom: 8px;
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
}
.kb-model-name {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary);
  word-break: break-all;
}
.kb-source-name {
  font-size: 12.5px;
  color: var(--text-primary);
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
  &.mono { font-family: var(--font-mono); }
}
.kb-empty {
  font-size: 12px;
  color: var(--text-muted);
  padding: 10px 12px;
  margin-bottom: 8px;
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
  padding: 4px 10px;
  border-radius: 2px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-secondary);
  cursor: pointer;
  font-family: inherit;
  transition: all 0.2s;
  &:hover { color: var(--text-primary); border-color: var(--text-secondary); }
}
/* 进度：2px 方角轨道，墨色填充（与下载条同规格） */
.kb-track {
  height: 2px;
  margin-top: 6px;
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
}
.kb-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 14px;
}
.kb-hint {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
  margin: 10px 0 0;
}
</style>
