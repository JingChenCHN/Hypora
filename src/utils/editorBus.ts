/**
 * 编辑器命令总线（§6 解耦：Toolbar/Search/AI ↔ Editor）
 * - editorState：跨组件共享的编辑器状态（光标块、选区文本、视图模式）
 * - onEditorCommand / emitEditorCommand：组件间单向命令
 */
import { reactive } from 'vue'

export type ViewMode = 'edit' | 'preview' | 'split'

export interface CaretInfo {
  blockId: string
  offset: number
  blockCount: number
}

export const editorState = reactive<{
  activeBlockId: string
  selectionText: string
  viewMode: ViewMode
  /** 最近一次命令插入后的目标块（供 AI 面板定位） */
  lastInsertedBlockId: string | null
}>({
  activeBlockId: '',
  selectionText: '',
  viewMode: 'edit',
  lastInsertedBlockId: null,
})

type Handler = (payload?: unknown) => void
const registry = new Map<string, Set<Handler>>()

export function onEditorCommand(name: string, fn: Handler): () => void {
  if (!registry.has(name)) registry.set(name, new Set())
  registry.get(name)!.add(fn)
  return () => registry.get(name)!.delete(fn)
}

export function emitEditorCommand(name: string, payload?: unknown) {
  registry.get(name)?.forEach((fn) => {
    try {
      fn(payload)
    } catch (err) {
      console.error(`[editorBus] 命令执行失败: ${name}`, err)
    }
  })
}

/** 选区文本更新（AIPanel 读取） */
export function updateSelection(): void {
  const sel = window.getSelection()
  const text = sel && !sel.isCollapsed ? sel.toString().trim() : ''
  editorState.selectionText = text
}
