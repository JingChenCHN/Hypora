<template>
  <div class="toasts">
    <transition-group name="toast">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.type">
        <span class="toast-icon">{{ toastIcon(t.type) }}</span>
        <span class="toast-msg">{{ t.msg }}</span>
        <button class="toast-close" @click="dismiss(t.id)">✕</button>
      </div>
    </transition-group>
  </div>
</template>

<script setup lang="ts">
import { toasts, dismiss, toastIcon } from '@/components/toasts'
</script>

<style scoped lang="scss">
.toasts {
  position: fixed;
  top: calc(var(--hypora-titlebar-h) + var(--hypora-toolbar-h) + 8px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  z-index: var(--hypora-z-toast);
  pointer-events: none;
}
.toast {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-radius: var(--hypora-radius);
  background: var(--hypora-bg-elevated);
  border: 1px solid var(--hypora-border);
  box-shadow: var(--hypora-shadow);
  font-size: 13px;
  pointer-events: auto;
  max-width: 480px;
  &.success {
    border-color: var(--hypora-success);
  }
  &.error {
    border-color: var(--hypora-danger);
  }
}
.toast-icon {
  flex-shrink: 0;
}
.toast-msg {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toast-close {
  cursor: pointer;
  color: var(--hypora-fg-subtle);
  font-size: 12px;
}
.toast-enter-active,
.toast-leave-active {
  transition: all 0.25s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
