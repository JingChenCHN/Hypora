<template>
  <footer class="statusbar">
    <div class="sb-left">
      <span class="sb-item">
        <span class="dot" :class="{ dirty: doc.dirty }"></span>
        {{ doc.path ? doc.fileName : '未命名' }}
      </span>
      <span v-if="doc.savedAt" class="sb-item muted">已保存 {{ timeAgo(doc.savedAt) }}</span>
    </div>
    <div class="sb-center">
      <span class="sb-item">{{ doc.wordCount }} 词</span>
      <span class="sb-item">{{ doc.charCount }} 字</span>
      <span class="sb-item">{{ doc.blockCount }} 块</span>
    </div>
    <div class="sb-right">
      <span class="sb-item">
        <span class="provider-pill" :class="{ local: ai.providerId === 'local' }">
          <span class="status-light" :class="{ on: ai.sidecar.running }"></span>
          {{ ai.providerLabel }}
        </span>
      </span>
      <span class="sb-item muted">v{{ version }}</span>
    </div>
  </footer>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useAIStore } from '@/stores/ai'

const doc = useDocumentStore()
const ai = useAIStore()
const version = ref('0.1.0')

import { tauriAPI } from '@/utils/tauriAPI'
tauriAPI.getStatus().then((s) => (version.value = s.version)).catch(() => {})

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  return new Date(iso).toLocaleTimeString()
}
</script>

<style scoped lang="scss">
.statusbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--hypora-statusbar-h);
  padding: 0 12px;
  background: var(--hypora-bg-elevated);
  border-top: 1px solid var(--hypora-border);
  font-size: 11.5px;
  color: var(--hypora-fg-muted);
  flex-shrink: 0;
  user-select: none;
}
.sb-left,
.sb-center,
.sb-right {
  display: flex;
  align-items: center;
  gap: 14px;
}
.sb-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  &.muted {
    color: var(--hypora-fg-subtle);
  }
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--hypora-fg-subtle);
  &.dirty {
    background: var(--hypora-accent);
  }
}
.provider-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px;
  border-radius: var(--hypora-radius-full);
  background: var(--hypora-accent-soft);
  color: var(--hypora-accent);
  &.local {
    background: var(--hypora-aubergine);
    color: var(--hypora-fg);
  }
}
.status-light {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--hypora-fg-subtle);
  &.on {
    background: var(--hypora-success);
  }
}
</style>
