<template>
  <el-dialog
    :model-value="visible"
    class="cloud-dialog"
    width="560px"
    :append-to-body="true"
    @update:model-value="(v) => emit('close')"
    @close="emit('close')"
  >
    <template #header>
      <div class="cloud-header">
        <span class="cloud-title">云端文件</span>
        <button class="cloud-btn" @click="load" :disabled="loading">刷新</button>
      </div>
    </template>

    <div v-if="loading" class="cloud-empty">加载中…</div>

    <div v-else-if="files.length === 0" class="cloud-empty">
      还没有云端文件。<br />在「文件 → 云端保存到服务器」保存后，文件会显示在这里。
    </div>

    <div v-else class="cloud-list">
      <div v-for="f in files" :key="f.name" class="cloud-row">
        <div class="cloud-row-main">
          <div class="cloud-fname" :title="f.name">{{ f.name }}</div>
          <div class="cloud-fmeta">{{ fmtSize(f.size) }} · {{ fmtTime(f.mtime) }}</div>
        </div>
        <div class="cloud-row-actions">
          <button class="cloud-link" @click="open(f.name)">打开</button>
          <button class="cloud-link danger" @click="del(f.name)">删除</button>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { cloudList, cloudRead, cloudDelete } from '@/utils/export'
import { useDocumentStore } from '@/stores/document'
import { ElMessage, ElMessageBox } from 'element-plus'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const docStore = useDocumentStore()
const files = ref<{ name: string; size: number; mtime: number }[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    files.value = await cloudList()
  } catch (e: any) {
    ElMessage.error(`加载云端文件失败：${e?.message || e}`)
  } finally {
    loading.value = false
  }
}

watch(() => props.visible, (v) => { if (v) load() })

function fmtSize(n: number): string {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
function fmtTime(ms: number): string {
  if (!ms) return '未知时间'
  const d = new Date(ms)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 打开：读取云端文件内容，在编辑器打开为新文档
async function open(name: string) {
  try {
    const r = await cloudRead(name)
    const title = r.name.replace(/\.md$/i, '') || '云端文档'
    docStore.newDocument(title, r.content)
    emit('close')
    ElMessage.success({ message: `已打开《${title}》`, duration: 1500 })
  } catch (e: any) {
    ElMessage.error(`打开失败：${e?.message || e}`)
  }
}

// 删除：二次确认后删除云端文件
async function del(name: string) {
  try {
    await ElMessageBox.confirm(`确定删除云端文件《${name}》？`, '删除云端文件', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  try {
    const r = await cloudDelete(name)
    if (!r.ok) throw new Error(r.error)
    files.value = files.value.filter((f) => f.name !== name)
    ElMessage.success({ message: '已删除', duration: 1500 })
  } catch (e: any) {
    ElMessage.error(`删除失败：${e?.message || e}`)
  }
}
</script>

<style lang="scss" scoped>
.cloud-dialog {
  border-radius: 2px;
}
.cloud-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
.cloud-title {
  font-family: "Georgia", "Songti SC", serif;
  font-size: 16px;
  color: var(--text-primary);
}
.cloud-btn {
  font-size: 12.5px;
  color: var(--text-muted);
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  border-radius: 2px;
  padding: 2px 10px;
  cursor: pointer;
  font-family: inherit;
  &:hover:not(:disabled) {
    color: var(--accent-color);
    border-color: var(--accent-color);
  }
  &:disabled { opacity: 0.4; cursor: not-allowed; }
}
.cloud-empty {
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.8;
  padding: 32px 0;
}
.cloud-list {
  max-height: 60vh;
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: 2px;
}
.cloud-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
  &:last-child { border-bottom: none; }
  &:hover { background: var(--bg-tertiary); }
}
.cloud-row-main {
  min-width: 0;
}
.cloud-fname {
  font-size: 13.5px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cloud-fmeta {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
}
.cloud-row-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.cloud-link {
  font-size: 12.5px;
  color: var(--text-muted);
  border: none;
  background: none;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 2px;
  font-family: inherit;
  &:hover { color: var(--accent-color); background: var(--bg-tertiary); }
}
</style>