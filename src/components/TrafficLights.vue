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
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: filter 0.15s ease;
}
.glyph {
  width: 12px;
  height: 12px;
  opacity: 0;
  transition: opacity 0.12s ease;
}
.glyph path {
  stroke: rgba(0, 0, 0, 0.55);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  fill: none;
}
.traffic-lights:hover .glyph {
  opacity: 1;
}
.tl-close { background: #ff5f57; }
.tl-min { background: #ffbd2e; }
.tl-max { background: #28c941; }
.tl:hover { filter: brightness(0.92); }
</style>
