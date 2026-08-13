<template>
  <teleport to="body">
    <div v-if="visible" class="ctx-menu" :style="{ left: x + 'px', top: y + 'px' }" @click.stop @contextmenu.prevent>
      <template v-for="(group, gi) in menuGroups" :key="gi">
        <div v-if="group.separator" class="ctx-sep"></div>
        <template v-else>
          <button
            v-for="item in group.items"
            :key="item.action"
            class="ctx-item"
            :disabled="item.disabled"
            @mousedown.prevent
            @click="onAction(item.action)"
          >
            <span class="ctx-label">{{ item.label }}</span>
            <span class="ctx-shortcut">{{ item.shortcut }}</span>
          </button>
        </template>
      </template>
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, computed } from 'vue'

const props = defineProps<{ visible: boolean; x: number; y: number; mode?: 'default' | 'table' }>()
const emit = defineEmits<{ (e: 'action', action: string): void; (e: 'close'): void }>()

interface Item { label: string; shortcut?: string; action: string; disabled?: boolean }
interface Group { separator?: boolean; items?: Item[] }

const defaultGroups: Group[] = [
  { items: [
    { label: '撤销', shortcut: 'Ctrl+Z', action: 'undo' },
    { label: '重做', shortcut: 'Ctrl+Y', action: 'redo' },
  ]},
  { separator: true },
  { items: [
    { label: '剪切', shortcut: 'Ctrl+X', action: 'cut' },
    { label: '复制', shortcut: 'Ctrl+C', action: 'copy' },
    { label: '粘贴', shortcut: 'Ctrl+V', action: 'paste' },
    { label: '全选', shortcut: 'Ctrl+A', action: 'selectAll' },
  ]},
  { separator: true },
  { items: [
    { label: '加粗', shortcut: 'Ctrl+B', action: 'bold' },
    { label: '斜体', shortcut: 'Ctrl+I', action: 'italic' },
    { label: '删除线', shortcut: 'Ctrl+Shift+S', action: 'strikethrough' },
    { label: '行内代码', shortcut: 'Ctrl+`', action: 'code' },
    { label: '高亮', shortcut: 'Ctrl+Shift+H', action: 'highlight' },
  ]},
  { separator: true },
  { items: [
    { label: '标题 1', shortcut: 'Ctrl+1', action: 'h1' },
    { label: '标题 2', shortcut: 'Ctrl+2', action: 'h2' },
    { label: '标题 3', shortcut: 'Ctrl+3', action: 'h3' },
    { label: '标题 4', shortcut: 'Ctrl+4', action: 'h4' },
    { label: '标题 5', shortcut: 'Ctrl+5', action: 'h5' },
    { label: '标题 6', shortcut: 'Ctrl+6', action: 'h6' },
    { label: '段落', shortcut: 'Ctrl+0', action: 'paragraph' },
  ]},
  { separator: true },
  { items: [
    { label: '引用块', shortcut: 'Ctrl+Shift+Q', action: 'quote' },
    { label: '无序列表', shortcut: 'Ctrl+Shift+U', action: 'ul' },
    { label: '有序列表', shortcut: 'Ctrl+Shift+O', action: 'ol' },
    { label: '任务列表', shortcut: 'Ctrl+Shift+X', action: 'task' },
    { label: '代码块', shortcut: 'Ctrl+Shift+K', action: 'codeBlock' },
    { label: '表格', shortcut: 'Ctrl+Shift+T', action: 'table' },
    { label: '分割线', action: 'hr' },
    { label: '数学公式', shortcut: 'Ctrl+Shift+M', action: 'math' },
    { label: '链接', shortcut: 'Ctrl+K', action: 'link' },
    { label: '图片', shortcut: 'Ctrl+Shift+I', action: 'image' },
  ]},
  { separator: true },
  { items: [
    { label: '查找替换', shortcut: 'Ctrl+F', action: 'search' },
    { label: '切换源码模式', shortcut: 'Ctrl+/', action: 'sourceMode' },
  ]},
]

// 表格上下文菜单（右键在 td/th 内时显示）
const tableGroups: Group[] = [
  { items: [
    { label: '撤销', shortcut: 'Ctrl+Z', action: 'undo' },
    { label: '重做', shortcut: 'Ctrl+Y', action: 'redo' },
  ]},
  { separator: true },
  { items: [
    { label: '剪切', shortcut: 'Ctrl+X', action: 'cut' },
    { label: '复制', shortcut: 'Ctrl+C', action: 'copy' },
    { label: '粘贴', shortcut: 'Ctrl+V', action: 'paste' },
  ]},
  { separator: true },
  { items: [
    { label: '在上方插入行', action: 'insertRowAbove' },
    { label: '在下方插入行', action: 'insertRowBelow' },
    { label: '在左侧插入列', action: 'insertColumnLeft' },
    { label: '在右侧插入列', action: 'insertColumnRight' },
  ]},
  { separator: true },
  { items: [
    { label: '删除行', action: 'deleteRow' },
    { label: '删除列', action: 'deleteColumn' },
    { label: '删除表格', action: 'deleteTable' },
  ]},
  { separator: true },
  { items: [
    { label: '左对齐', action: 'alignLeft' },
    { label: '居中对齐', action: 'alignCenter' },
    { label: '右对齐', action: 'alignRight' },
  ]},
]

// 根据右键位置选择菜单内容（表格内 → 表格菜单）
const menuGroups = computed(() => props.mode === 'table' ? tableGroups : defaultGroups)

function onAction(action: string) {
  emit('action', action)
  emit('close')
}

function onWindowClick() {
  if (props.visible) emit('close')
}
function onEsc(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.visible) emit('close')
}

onMounted(() => {
  window.addEventListener('click', onWindowClick)
  window.addEventListener('keydown', onEsc)
})
onBeforeUnmount(() => {
  window.removeEventListener('click', onWindowClick)
  window.removeEventListener('keydown', onEsc)
})
</script>

<style lang="scss" scoped>
.ctx-menu {
  position: fixed;
  z-index: 9999;
  min-width: 220px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 2px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
  padding: 6px 0;
  max-height: 70vh;
  overflow-y: auto;
  user-select: none;
}
.ctx-sep {
  height: 1px;
  background: var(--border-color);
  margin: 4px 8px;
}
.ctx-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 6px 14px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
  transition: background 0.12s;
  &:hover:not(:disabled) { background: var(--bg-secondary); }
  &:disabled { color: var(--text-muted); cursor: default; }
  .ctx-shortcut {
    color: var(--text-muted);
    font-size: 11px;
    margin-left: 24px;
  }
}
</style>