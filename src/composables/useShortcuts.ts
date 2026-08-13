import { onMounted, onUnmounted } from 'vue'
import { useDocumentStore } from '@/stores/document'

type ShortcutHandler = (e: KeyboardEvent) => void

// 全局快捷键（任何焦点下都触发，含输入框内）
const GLOBAL_KEYS = [
  'ctrl+s', 'ctrl+/', 'f11', 'ctrl+f', 'ctrl+h',
  'f9', 'ctrl+shift+=', 'ctrl+shift+-', 'ctrl+shift+0',
  'ctrl+j', 'ctrl+shift+a'
]

export function useShortcuts(handlers: Record<string, ShortcutHandler>) {
  const docStore = useDocumentStore()

  function handleKeydown(e: KeyboardEvent) {
    const isEditable = (e.target as HTMLElement).isContentEditable ||
      (e.target as HTMLInputElement).tagName === 'INPUT' ||
      (e.target as HTMLTextAreaElement).tagName === 'TEXTAREA'

    const key: string[] = []
    if (e.ctrlKey || e.metaKey) key.push('ctrl')
    if (e.shiftKey) key.push('shift')
    if (e.altKey) key.push('alt')
    key.push(e.key.toLowerCase())
    const keyStr = key.join('+')

    if (!handlers[keyStr]) return

    // 编辑类快捷键交由 Editor 组件的 handleKeydown 处理（避免双重触发），
    // 此处仅在非编辑区触发（如工具栏按钮聚焦时）
    if (isEditable && !GLOBAL_KEYS.includes(keyStr)) {
      return
    }

    e.preventDefault()
    handlers[keyStr](e)
  }

  onMounted(() => {
    window.addEventListener('keydown', handleKeydown)
  })

  onUnmounted(() => {
    window.removeEventListener('keydown', handleKeydown)
  })

  return {
    triggerAction(action: string) {
      // 工具栏按钮触发对应动作（直接调用 handler）
      if (handlers[action]) {
        handlers[action](new KeyboardEvent('keydown'))
      }
    }
  }
}