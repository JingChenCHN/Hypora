<template>
  <el-dialog
    :model-value="visible"
    width="560px"
    :append-to-body="true"
    class="backup-dialog"
    @close="emit('close')"
  >
    <template #header>
      <div class="backup-header">
        <span class="backup-title">离线缓存</span>
        <span class="backup-sub">仅存于本浏览器 · 不上传</span>
      </div>
    </template>

    <el-tabs v-model="tab" class="cache-tabs">
      <!-- 页签一：localStorage 落盘的全部文档 -->
      <el-tab-pane label="缓存文档" name="cache">
        <el-input
          v-model="keyword"
          class="cache-filter"
          placeholder="按标题或内容关键词过滤（如 0907、PRD）"
          clearable
        />
        <div v-if="cached.length === 0" class="backup-empty">
          <el-empty description="缓存为空" :image-size="80" />
        </div>
        <div v-else-if="filteredCached.length === 0" class="backup-empty">
          <el-empty description="无匹配条目" :image-size="80" />
        </div>
        <div v-else class="backup-list">
          <div v-for="d in filteredCached" :key="'c-' + d.id" class="backup-row">
            <div class="row-main">
              <div class="row-title">
                {{ d.title }}
                <span v-if="!inList(d.id)" class="row-badge">不在列表</span>
                <span v-else-if="differs(d)" class="row-badge warn">与当前编辑不一致</span>
              </div>
              <div class="row-meta">
                <span>缓存于 {{ formatTime(d.updateTime) }}</span>
                <span>{{ formatChars(d.content) }}</span>
              </div>
            </div>
            <div class="row-actions">
              <button class="backup-btn primary" :disabled="busy" @click="handleOpenCached(d)">
                {{ inList(d.id) ? '打开' : '恢复打开' }}
              </button>
              <button class="backup-btn" :disabled="busy" @click="handleCopyCached(d)">打开为副本</button>
            </div>
          </div>
        </div>
        <div class="backup-footer">
          <span>「与当前编辑不一致」= 缓存版本落后于未保存的编辑（自动保存关闭或未触发落盘）</span>
        </div>
      </el-tab-pane>

      <!-- 页签二：已删备份 -->
      <el-tab-pane :label="`已删备份${docs.length ? ' (' + docs.length + ')' : ''}`" name="backup">
        <div v-if="docs.length === 0" class="backup-empty">
          <el-empty description="备份为空 — 删除的文档会自动移入此处" :image-size="80" />
        </div>

        <template v-else>
          <div class="backup-list">
            <div v-for="d in docs" :key="d.id" class="backup-row">
              <div class="row-main">
                <div class="row-title">{{ d.title }}</div>
                <div class="row-meta">
                  <span>删除于 {{ formatTime(d.deletedAt) }}</span>
                  <span>{{ formatChars(d.content) }}</span>
                </div>
              </div>
              <div class="row-actions">
                <button class="backup-btn primary" :disabled="busy" @click="handleRestore(d)">恢复打开</button>
                <button class="backup-btn danger" :disabled="busy" @click="handlePurge(d)">彻底删除</button>
              </div>
            </div>
          </div>
          <div class="backup-footer">
            <span>最多保留 30 份，超出自动淘汰最旧</span>
            <button class="backup-btn danger" :disabled="busy" @click="handleClear">清空备份</button>
          </div>
        </template>
      </el-tab-pane>
    </el-tabs>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useDocumentStore } from '@/stores/document'

interface BackupDoc {
  id: string
  title: string
  content: string
  deletedAt: number
}

interface CacheDoc {
  id: string
  title: string
  content: string
  updateTime: number
}

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const docStore = useDocumentStore()
const tab = ref<'cache' | 'backup'>('cache')
const docs = ref<BackupDoc[]>([])
const cached = ref<CacheDoc[]>([])
const keyword = ref('')
const busy = ref(false)

watch(() => props.visible, (v) => { if (v) { keyword.value = ''; load() } })

function load() {
  cached.value = docStore.getCachedDocs() as CacheDoc[]
  docs.value = docStore.getBackupDocs() as BackupDoc[]
}

// 关键词过滤：标题或内容命中即列出
const filteredCached = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return cached.value
  return cached.value.filter(d =>
    (d.title || '').toLowerCase().includes(k) || (d.content || '').toLowerCase().includes(k)
  )
})

function inList(id: string) {
  return docStore.documents.some(d => d.id === id)
}

function differs(d: CacheDoc) {
  const live = docStore.documents.find(x => x.id === d.id)
  return !!live && live.content !== d.content
}

function handleOpenCached(d: CacheDoc) {
  if (busy.value) return
  busy.value = true
  try {
    if (inList(d.id)) {
      docStore.switchDocument(d.id)
      ElMessage.success(`已打开「${d.title}」`)
    } else if (docStore.restoreFromCache(d.id)) {
      ElMessage.success(`已从缓存恢复「${d.title}」`)
    } else {
      ElMessage.error('缓存条目不存在')
      load()
      return
    }
    emit('close')
  } finally {
    busy.value = false
  }
}

function handleCopyCached(d: CacheDoc) {
  if (busy.value) return
  busy.value = true
  try {
    docStore.newDocument(`${d.title} 副本`, d.content)
    ElMessage.success(`已创建「${d.title} 副本」（缓存版本）`)
    emit('close')
  } finally {
    busy.value = false
  }
}

function handleRestore(d: BackupDoc) {
  if (busy.value) return
  busy.value = true
  try {
    if (docStore.restoreFromBackup(d.id)) {
      ElMessage.success(`已恢复「${d.title}」`)
      load()
      emit('close')
    } else {
      ElMessage.error('恢复失败：备份条目不存在')
      load()
    }
  } finally {
    busy.value = false
  }
}

async function handlePurge(d: BackupDoc) {
  try {
    await ElMessageBox.confirm(
      `彻底删除备份「${d.title}」？删除后无法再恢复。`,
      '彻底删除',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
    )
  } catch { return }
  docStore.purgeBackup(d.id)
  load()
  ElMessage.success('已彻底删除')
}

async function handleClear() {
  try {
    await ElMessageBox.confirm(
      `清空全部 ${docs.value.length} 份备份？删除后无法再恢复。`,
      '清空备份',
      { confirmButtonText: '清空', cancelButtonText: '取消', type: 'warning' },
    )
  } catch { return }
  docStore.clearBackup()
  load()
  ElMessage.success('备份已清空')
}

function formatTime(ts: number) {
  if (!ts) return '—'
  const date = new Date(ts)
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return date.toDateString() === now.toDateString() ? `今天 ${time}` : `${day} ${time}`
}

function formatChars(content: string) {
  const n = (content || '').length
  if (n >= 10000) return (n / 10000).toFixed(1) + ' 万字符'
  return n + ' 字符'
}
</script>

<style lang="scss" scoped>
.backup-header {
  display: flex;
  align-items: baseline;
  gap: 10px;

  .backup-title {
    font-family: var(--font-serif);
    font-size: 16px;
    color: var(--text-primary);
  }

  .backup-sub {
    font-size: 11px;
    letter-spacing: 0.1em;
    color: var(--text-muted);
  }
}

.backup-empty {
  padding: 12px 0;
}

.cache-filter {
  margin-bottom: 10px;
}

.backup-list {
  border: 1px solid var(--border-color);
  border-radius: 2px;
  max-height: 46vh;
  overflow-y: auto;
}

.backup-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);

  &:last-child { border-bottom: none; }
  &:hover { background: var(--bg-tertiary); }

  .row-main {
    flex: 1;
    min-width: 0;

    .row-title {
      font-size: 13.5px;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;

      .row-badge {
        margin-left: 8px;
        font-size: 11px;
        color: var(--text-muted);
        border: 1px solid var(--border-color);
        border-radius: 2px;
        padding: 0 6px;
        vertical-align: 1px;

        &.warn {
          color: var(--el-color-warning);
          border-color: color-mix(in srgb, var(--el-color-warning) 40%, transparent);
        }
      }
    }

    .row-meta {
      display: flex;
      gap: 12px;
      margin-top: 3px;
      font-size: 12px;
      color: var(--text-muted);
    }
  }

  .row-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }
}

.backup-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-muted);
}

.backup-btn {
  font-size: 12px;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  border-radius: 2px;
  padding: 4px 12px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.2s ease;

  &:hover:not(:disabled) {
    color: var(--accent-color);
    border-color: var(--accent-color);
  }

  &:disabled { opacity: 0.5; cursor: not-allowed; }

  &.primary {
    background: var(--accent-color);
    color: var(--bg-primary);
    border-color: var(--accent-color);

    &:hover:not(:disabled) { opacity: 0.85; color: var(--bg-primary); }
  }

  &.danger:hover:not(:disabled) {
    color: var(--el-color-danger);
    border-color: var(--el-color-danger);
  }
}
</style>
