<template>
  <div class="traffic-lights">
    <button
      class="light close"
      :title="'关闭'"
      @click="close"
    >
      <svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 1l6 6M7 1L1 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
    </button>
    <button
      class="light minimize"
      :title="'最小化'"
      @click="minimize"
    >
      <svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 5.5h6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
    </button>
    <button
      class="light maximize"
      :title="maximized ? '还原' : '最大化'"
      @click="toggleMaximize"
    >
      <svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 1h6v6H1z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { tauriAPI } from '@/utils/tauriAPI'

const maximized = ref(false)
let unMax: (() => void) | null = null

async function close() {
  await tauriAPI.winClose()
}
async function minimize() {
  await tauriAPI.winMinimize()
}
async function toggleMaximize() {
  await tauriAPI.winToggleMaximize()
  maximized.value = await tauriAPI.winIsMaximized()
}

onMounted(async () => {
  try {
    maximized.value = await tauriAPI.winIsMaximized()
  } catch {
    /* 忽略 */
  }
  unMax = tauriAPI.onWinMaximized((v) => (maximized.value = v))
})
onBeforeUnmount(() => unMax?.())
</script>

<style scoped lang="scss">
.traffic-lights {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-left: 10px;
  height: 100%;
}

.light {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 1px solid rgba(0, 0, 0, 0.12);
  display: grid;
  place-items: center;
  cursor: default;
  color: rgba(0, 0, 0, 0.55);
  transition: filter var(--hypora-transition-fast);
  opacity: 0.95;

  svg {
    opacity: 0;
    transition: opacity var(--hypora-transition-fast);
  }

  &:hover svg {
    opacity: 1;
  }

  &.close {
    background: #ff5f57;
  }
  &.minimize {
    background: #febc2e;
  }
  &.maximize {
    background: #28c840;
  }
}
</style>
