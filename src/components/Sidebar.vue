<template>
  <aside class="sidebar" :class="{ collapsed }">
    <div class="side-head">
      <span class="side-title">文档</span>
      <button class="side-btn" title="新建（Ctrl+N）" @click="newDoc">＋</button>
      <button class="side-btn" title="打开（Ctrl+O）" @click="open">📂</button>
      <button class="side-btn collapse" :title="collapsed ? '展开' : '收起'" @click="collapsed = !collapsed">
        {{ collapsed ? '»' : '«' }}
      </button>
    </div>

    <template v-if="!collapsed">
      <div class="recent-list">
        <div v-if="recent.length === 0" class="side-empty">
          暂无最近文件<br />
          <span class="hint">点击「打开」选择 .md 文件</span>
        </div>
        <button
          v-for="f in recent"
          :key="f"
          class="recent-item"
          :class="{ active: f === doc.path }"
          :title="f"
          @click="openRecent(f)"
        >
          <span class="file-icon">📄</span>
          <span class="file-name">{{ f.split(/[\\/]/).pop() }}</span>
          <span class="file-path">{{ f }}</span>
        </button>
      </div>

      <div class="side-foot">
        <div class="stats">
          <div class="stat"><b>{{ doc.wordCount }}</b> 词</div>
          <div class="stat"><b>{{ doc.charCount }}</b> 字</div>
        </div>
      </div>
    </template>
  </aside>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { settings } from '@/utils/tauriAPI'
import { toast } from '@/components/toasts'

const doc = useDocumentStore()
const collapsed = ref(false)
const recent = ref<string[]>(settings.get<string[]>('recent_files', []))

async function pushRecent(path: string) {
  if (!path) return
  const list = recent.value.filter((p) => p !== path)
  list.unshift(path)
  recent.value = list.slice(0, 20)
  settings.set('recent_files', list)
}

async function newDoc() {
  await doc.newDocument()
}

async function open() {
  await doc.openViaDialog()
  if (doc.path) {
    await pushRecent(doc.path)
    toast(`已打开 ${doc.fileName}`)
  }
}

async function openRecent(path: string) {
  try {
    const content = await doc.openFromPath(path)
    void content
    await pushRecent(path)
  } catch (err) {
    toast(`打开失败：${String(err)}`, 'error')
  }
}
</script>

<style scoped lang="scss">
.sidebar {
  width: 210px;
  min-width: 210px;
  display: flex;
  flex-direction: column;
  background: var(--hypora-bg-elevated);
  border-right: 1px solid var(--hypora-border);
  transition: width var(--hypora-transition), min-width var(--hypora-transition);

  &.collapsed {
    width: 40px;
    min-width: 40px;
  }
}

.side-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 8px;
  border-bottom: 1px solid var(--hypora-border);

  .side-title {
    flex: 1;
    font-size: 12px;
    font-weight: 600;
    color: var(--hypora-fg-subtle);
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }
}

.side-btn {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: var(--hypora-radius-sm);
  font-size: 13px;
  color: var(--hypora-fg-muted);
  cursor: pointer;

  &:hover {
    background: var(--hypora-bg-hover);
    color: var(--hypora-fg);
  }
}

.recent-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
  @include subtle-scrollbar;
}

.recent-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border-radius: var(--hypora-radius-sm);
  cursor: pointer;
  text-align: left;

  &:hover {
    background: var(--hypora-bg-hover);
  }
  &.active {
    background: var(--hypora-accent-soft);
    color: var(--hypora-accent);
  }

  .file-name {
    font-size: 12.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-path {
    font-size: 10px;
    color: var(--hypora-fg-subtle);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 110px;
  }
}

.side-empty {
  padding: 24px 12px;
  font-size: 12px;
  color: var(--hypora-fg-muted);
  text-align: center;
  line-height: 1.8;
  .hint {
    color: var(--hypora-fg-subtle);
    font-size: 11px;
  }
}

.side-foot {
  border-top: 1px solid var(--hypora-border);
  padding: 10px;
}
.stats {
  display: flex;
  gap: 12px;
  .stat {
    font-size: 11px;
    color: var(--hypora-fg-subtle);
    b {
      color: var(--hypora-fg);
    }
  }
}
</style>
