<template>
  <div class="lottie-loading" :style="{ width: size + 'px', height: size + 'px' }" v-html="spinner"></div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { thinkingSpinnerSVG } from '@/assets/aiLoading'

const props = withDefaults(defineProps<{ size?: number }>(), { size: 28 })
const spinner = computed(() => thinkingSpinnerSVG(props.size))
</script>

<style scoped lang="scss">
.lottie-loading {
  :deep(.hypora-spinner) {
    animation: hypora-spin 0.9s linear infinite;
  }
}

@keyframes hypora-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
