<template>
  <header class="titlebar" :class="{ maximized }" data-tauri-drag-region>
    <TrafficLights class="title-left" />
    <div class="title-center" data-tauri-drag-region>
      <span class="brand-mark" data-tauri-drag-region>Hypora</span>
      <span class="doc-name" data-tauri-drag-region>{{ doc.fileName }}</span>
      <span v-if="doc.dirty" class="dirty-dot" title="未保存" data-tauri-drag-region></span>
    </div>
    <div class="title-right">
      <button
        class="pin-btn"
        :class="{ pinned: pinned }"
        :title="pinned ? '取消置顶' : '窗口置顶'"
        @click="togglePin"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 17v5M9 3h6v4l2 3v2H7v-2l2-3V3z" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import TrafficLights from '@/components/TrafficLights.vue'
import { useDocumentStore } from '@/stores/document'
import { tauriAPI } from '@/utils/tauriAPI'

const doc = useDocumentStore()
const maximized = ref(false)
const pinned = ref(false)
let unMax: (() => void) | null = null
let unPin: (() => void) | null = null

async function togglePin() {
  try {
    pinned.value = await tauriAPI.winToggleAlwaysOnTop()
  } catch {
    /* Web 降级忽略 */
  }
}

onMounted(async () => {
  try {
    maximized.value = await tauriAPI.winIsMaximized()
    pinned.value = await tauriAPI.winIsAlwaysOnTop()
  } catch {
    /* 忽略 */
  }
  unMax = tauriAPI.onWinMaximized((v) => (maximized.value = v))
  unPin = tauriAPI.onWinAlwaysOnTop((v) => (pinned.value = v))
})
onBeforeUnmount(() => {
  unMax?.()
  unPin?.()
})
</script>

<style scoped lang="scss">
.titlebar {
  display: flex;
  align-items: center;
  height: var(--hypora-titlebar-h);
  background: var(--hypora-titlebar-bg);
  border-bottom: 1px solid var(--hypora-border);
  flex-shrink: 0;
  user-select: none;
}

.title-left {
  width: 92px;
  flex-shrink: 0;
}

.title-center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-width: 0;
  height: 100%;
}

.brand-mark {
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.4px;
  color: var(--hypora-accent);
}

.doc-name {
  font-size: 12px;
  color: var(--hypora-fg-muted);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dirty-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--hypora-accent);
  flex-shrink: 0;
}

.title-right {
  width: 92px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-right: 10px;
}

.pin-btn {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--hypora-radius-sm);
  color: var(--hypora-fg-muted);
  cursor: pointer;
  transition: all var(--hypora-transition-fast);

  &:hover {
    background: var(--hypora-bg-hover);
    color: var(--hypora-fg);
  }
  &.pinned {
    color: var(--hypora-accent);
    background: var(--hypora-accent-soft);
  }
}
</style>
