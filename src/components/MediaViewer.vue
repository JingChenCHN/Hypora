<template>
  <Teleport to="body">
    <Transition name="viewer-fade">
      <div v-if="visible" class="media-viewer" @click.self="close" @wheel.prevent="onWheel" @keydown.esc="close" tabindex="-1" ref="maskRef">
        <img
          ref="imgRef"
          class="viewer-img"
          :src="src"
          :alt="name || ''"
          draggable="false"
          :style="imgStyle"
          @click.self="close"
          @mousedown.prevent="startDrag"
        />

        <!-- 顶部信息 -->
        <div class="viewer-name">{{ name }}</div>

        <!-- 底部工具条：缩放 / 旋转 / 复位 / 关闭（媒体画布恒定深底浅字） -->
        <div class="viewer-toolbar" @mousedown.stop>
          <button class="vbtn" title="缩小" @click="zoomBy(1 / 1.25)">－</button>
          <span class="vscale" @dblclick="resetTransform">{{ Math.round(scale * 100) }}%</span>
          <button class="vbtn" title="放大" @click="zoomBy(1.25)">＋</button>
          <span class="vsep"></span>
          <button class="vbtn" title="向左旋转 90°" @click="rotateBy(-90)">⟲</button>
          <button class="vbtn" title="向右旋转 90°" @click="rotateBy(90)">⟳</button>
          <button class="vbtn" title="重置 (1:1)" @click="resetTransform">1:1</button>
          <span class="vsep"></span>
          <button class="vbtn" title="关闭 (Esc)" @click="close">✕</button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps<{
  visible: boolean
  src: string
  name?: string
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const SCALE_MIN = 0.1
const SCALE_MAX = 10

const scale = ref(1)
const rotation = ref(0)
const tx = ref(0)
const ty = ref(0)
const maskRef = ref<HTMLElement>()
const imgRef = ref<HTMLImageElement>()
let dragging = false
let startX = 0
let startY = 0

const imgStyle = computed(() => ({
  transform: `translate(${tx.value}px, ${ty.value}px) rotate(${rotation.value}deg) scale(${scale.value})`,
  cursor: dragging ? 'grabbing' : 'grab',
  transition: dragging ? 'none' : 'transform 0.2s ease'
}))

function close() { emit('close') }

function zoomBy(factor: number) {
  scale.value = Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale.value * factor))
  if (scale.value === 1 && rotation.value === 0) { tx.value = 0; ty.value = 0 }
}

function rotateBy(deg: number) {
  rotation.value = (rotation.value + deg) % 360
}

function resetTransform() {
  scale.value = 1
  rotation.value = 0
  tx.value = 0
  ty.value = 0
}

function onWheel(e: WheelEvent) {
  zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12)
}

function startDrag(e: MouseEvent) {
  dragging = true
  startX = e.clientX - tx.value
  startY = e.clientY - ty.value
  window.addEventListener('mousemove', onDrag)
  window.addEventListener('mouseup', endDrag)
}

function onDrag(e: MouseEvent) {
  if (!dragging) return
  tx.value = e.clientX - startX
  ty.value = e.clientY - startY
}

function endDrag() {
  dragging = false
  window.removeEventListener('mousemove', onDrag)
  window.removeEventListener('mouseup', endDrag)
}

function onKeydown(e: KeyboardEvent) {
  if (!props.visible) return
  if (e.key === 'Escape') close()
  else if (e.key === '+' || e.key === '=') zoomBy(1.25)
  else if (e.key === '-') zoomBy(1 / 1.25)
  else if (e.key === '0') resetTransform()
}

// 打开时复位并聚焦（接收 Esc）
watch(() => props.visible, (v) => {
  if (v) {
    resetTransform()
    nextTick(() => maskRef.value?.focus())
  }
})

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  endDrag()
})
</script>

<style lang="scss" scoped>
/* 媒体画布例外：图片预览恒定深底浅字（观片场景，不随主题翻转） */
.media-viewer {
  position: fixed;
  inset: 0;
  z-index: 3000;
  background: rgba(0, 0, 0, 0.78);
  display: flex;
  align-items: center;
  justify-content: center;
  outline: none;
  user-select: none;

  .viewer-img {
    max-width: 92vw;
    max-height: 88vh;
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5);
    will-change: transform;
  }

  .viewer-name {
    position: absolute;
    top: 16px;
    left: 20px;
    max-width: 50vw;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 12px;
    letter-spacing: 0.05em;
    color: rgba(255, 255, 255, 0.65);
  }

  .viewer-toolbar {
    position: absolute;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 10px;
    background: rgba(0, 0, 0, 0.55);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 2px;
    backdrop-filter: blur(6px);

    .vbtn {
      min-width: 30px;
      height: 28px;
      padding: 0 8px;
      background: transparent;
      border: none;
      border-radius: 2px;
      color: rgba(255, 255, 255, 0.9);
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
      transition: background 0.2s ease;

      &:hover { background: rgba(255, 255, 255, 0.14); }
    }

    .vscale {
      min-width: 52px;
      text-align: center;
      font-size: 12px;
      color: rgba(255, 255, 255, 0.75);
      cursor: default;
      font-variant-numeric: tabular-nums;
    }

    .vsep {
      width: 1px;
      height: 16px;
      background: rgba(255, 255, 255, 0.18);
      margin: 0 4px;
    }
  }
}

.viewer-fade-enter-active, .viewer-fade-leave-active {
  transition: opacity 0.2s ease;
}
.viewer-fade-enter-from, .viewer-fade-leave-to {
  opacity: 0;
}
</style>
