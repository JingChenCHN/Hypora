<template>
  <div class="traffic-lights">
    <button class="tl tl-close" title="关闭" @click="close">
      <svg class="glyph" viewBox="0 0 12 12"><path d="M3 3 L9 9 M9 3 L3 9" /></svg>
    </button>
    <button class="tl tl-min" title="最小化" @click="minimize">
      <svg class="glyph" viewBox="0 0 12 12"><path d="M2.5 6 L9.5 6" /></svg>
    </button>
    <button class="tl tl-max" :title="isMax ? '还原' : '最大化'" @click="toggleMax">
      <svg v-if="isMax" class="glyph" viewBox="0 0 12 12"><path d="M2.5 5.5 L2.5 2.5 L5.5 2.5 M9.5 6.5 L9.5 9.5 L6.5 9.5" /></svg>
      <svg v-else class="glyph" viewBox="0 0 12 12"><path d="M6 2.5 L6 9.5 M2.5 6 L9.5 6" /></svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

const isMax = ref(false)

const close = () => window.electronAPI?.winClose?.()
const minimize = () => window.electronAPI?.winMinimize?.()
const toggleMax = () => window.electronAPI?.winMaximizeToggle?.()

onMounted(async () => {
  isMax.value = !!(await (window.electronAPI?.winIsMaximized?.()))
  window.electronAPI?.onMaximizedChange?.((v: boolean) => {
    isMax.value = v
  })
})
</script>

<style lang="scss" scoped>
.traffic-lights {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 0 10px 0 14px;
  -webkit-app-region: no-drag;
  flex-shrink: 0;
}
.tl {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  color: var(--text-muted);
}
.glyph {
  width: 12px;
  height: 12px;
  opacity: 0;
  transition: opacity 0.12s ease;
}
.glyph path {
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  fill: none;
}
.traffic-lights:hover .glyph {
  opacity: 1;
}
/* 冷淡单色：无彩色 accent。关闭用墨色表达（最重的操作），最小化/最大化用面加深 */
.tl-close:hover {
  background: var(--text-primary);
  border-color: var(--text-primary);
  color: var(--bg-primary);
}
.tl-min:hover,
.tl-max:hover {
  background: var(--bg-tertiary);
  border-color: var(--text-muted);
  color: var(--text-primary);
}
</style>
