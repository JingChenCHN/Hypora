<template>
  <div class="statusbar">
    <div class="statusbar-left">
      <span class="status-item" v-if="!docStore.activeDocument?.isSaved">
        <el-icon><WarningFilled /></el-icon> 未保存
      </span>
      <span class="status-item" v-else>
        <el-icon><CircleCheckFilled /></el-icon> 已保存
      </span>
      <span class="status-divider"></span>
      <span class="status-item">自动保存: {{ docStore.autoSave ? '开' : '关' }}</span>
      <span class="status-divider"></span>
      <span class="status-item dev-entry" @click="emit('toggleDev')" title="开发者模式 (F12)">
        <el-icon><Tools /></el-icon> 开发者
      </span>
    </div>

    <div class="statusbar-right">
      <span class="status-item">{{ stats.characters }} 字符</span>
      <span class="status-divider"></span>
      <span class="status-item">{{ stats.words }} 词</span>
      <span class="status-divider"></span>
      <span class="status-item">{{ stats.lines }} 行</span>
      <span class="status-divider"></span>
      <span class="status-item">Markdown</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useDocumentStore } from '@/stores/document'
import { WarningFilled, CircleCheckFilled, Tools } from '@element-plus/icons-vue'

defineProps<{
  stats: {
    characters: number
    words: number
    lines: number
  }
}>()

const emit = defineEmits<{
  (e: 'toggleDev'): void
}>()

const docStore = useDocumentStore()
</script>

<style lang="scss" scoped>
.statusbar {
  height: 28px;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  font-size: 12px;
  color: var(--text-muted);

  .statusbar-left, .statusbar-right {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .status-item {
    display: flex;
    align-items: center;
    gap: 4px;

    &.dev-entry {
      cursor: pointer;
      padding: 2px 8px;
      border-radius: 3px;
      transition: all 0.2s;

      &:hover {
        background: var(--bg-tertiary);
        color: var(--accent-color);
      }
    }

    .el-icon {
      font-size: 14px;

      &.warning {
        color: #e6a23c;
      }

      &.success {
        color: #67c23a;
      }
    }
  }

  .status-divider {
    width: 1px;
    height: 14px;
    background: var(--border-color);
  }
}
</style>