<template>
  <div v-show="visible" class="lottie-loading" :class="`size-${size}`">
    <div v-if="!failed" ref="containerRef" class="lottie-container"></div>
    <div v-else class="css-dots"><span></span><span></span><span></span></div>
    <span v-if="label" class="lottie-label">{{ label }}</span>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as lottieNS from 'lottie-web'
import { devLog } from '@/utils/devMode'

// lottie-web 是老式 UMD/CJS，在 Vite/rolldown 下 `import lottie from` 可能拿不到函数。
const lottie: any = (lottieNS as any).default ?? (lottieNS as any)

const props = withDefaults(
  defineProps<{
    animation: any
    visible?: boolean
    label?: string
    size?: 'small' | 'large'
  }>(),
  { visible: true, label: '', size: 'small' }
)

const containerRef = ref<HTMLElement>()
const failed = ref(false)
let anim: any = null

function play() {
  if (failed.value || anim || !containerRef.value || !props.animation) return
  try {
    if (typeof lottie?.loadAnimation !== 'function') {
      throw new Error(`lottie.loadAnimation 不可用 (typeof=${typeof lottie?.loadAnimation})`)
    }
    // clone 纯对象，避免 lottie-web 直接操作可能被代理的对象
    const data = JSON.parse(JSON.stringify(props.animation))
    anim = lottie.loadAnimation({
      container: containerRef.value,
      renderer: 'svg',
      loop: true,
      autoplay: true,
      animationData: data,
      rendererSettings: { viewBoxOnly: true }
    })
    devLog.info('[AI] lottie 动画已加载')
    // lottie-web 对部分 JSON 问题只 warn 不抛异常，校验是否真的画出 SVG
    nextTick(() => {
      if (!failed.value && containerRef.value && !containerRef.value.querySelector('svg')) {
        failed.value = true
        try { anim?.destroy() } catch {}
        anim = null
        devLog.error('[AI] lottie 未生成 SVG，回退 CSS')
      }
    })
  } catch (e: any) {
    failed.value = true
    devLog.error(`[AI] lottie 加载失败，回退 CSS: ${e?.message || e}`)
  }
}

function stop() {
  try { anim?.destroy() } catch {}
  anim = null
}

onMounted(() => {
  if (props.visible) play()
})
watch(() => props.visible, (v) => (v ? play() : stop()))
// animation 变化时重新加载
watch(() => props.animation, () => {
  stop()
  failed.value = false
  play()
})
onBeforeUnmount(() => stop())
</script>

<style lang="scss" scoped>
.lottie-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: 13px;
}
.lottie-loading.size-small {
  flex-direction: row;
}
.lottie-loading.size-large {
  flex-direction: column;
}
.lottie-container {
  flex-shrink: 0;
}
.lottie-loading.size-small .lottie-container {
  width: 56px;
  height: 22px;
}
.lottie-loading.size-large .lottie-container {
  width: 180px;
  height: 180px;
}
.lottie-label {
  line-height: 1.4;
}
/* CSS 兜底：lottie 加载失败时显示三点呼吸动画 */
.css-dots {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 22px;
  flex-shrink: 0;
}
.css-dots span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-primary);
  animation: ai-dot 1s infinite ease-in-out;
}
.css-dots span:nth-child(2) { animation-delay: 0.15s; }
.css-dots span:nth-child(3) { animation-delay: 0.3s; }
@keyframes ai-dot {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}
</style>
