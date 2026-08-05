<template>
  <div class="app-root">
    <Titlebar />
    <Toolbar />
    <div class="app-main">
      <Sidebar />
      <div class="editor-wrap">
        <Editor ref="editorRef" />
        <SearchPanel />
      </div>
      <AIPanel />
    </div>
    <Statusbar />

    <!-- 覆盖层 -->
    <DevPanel />
    <Toasts />
    <ImageBase64 ref="imageBase64Ref" />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, provide, ref, shallowRef } from 'vue'
import Titlebar from '@/components/Titlebar.vue'
import Toolbar from '@/components/Toolbar.vue'
import Sidebar from '@/components/Sidebar.vue'
import Editor from '@/components/Editor.vue'
import SearchPanel from '@/components/SearchPanel.vue'
import AIPanel from '@/components/AIPanel.vue'
import Statusbar from '@/components/Statusbar.vue'
import DevPanel from '@/components/DevPanel.vue'
import Toasts from '@/components/Toasts.vue'
import { toast } from '@/components/toasts'
import ImageBase64 from '@/components/ImageBase64.vue'

import { useDocumentStore } from '@/stores/document'
import { useAIStore } from '@/stores/ai'
import { editorState, emitEditorCommand, onEditorCommand } from '@/utils/editorBus'
import { installLogBridge, isDevMode } from '@/utils/devMode'
import { genId } from '@/utils/markdown'

const doc = useDocumentStore()
const ai = useAIStore()

const editorRef = ref<InstanceType<typeof Editor> | null>(null)
const imageBase64Ref = ref<InstanceType<typeof ImageBase64> | null>(null)
provide('editorApi', editorRef)

/* ── 工具栏命令路由 ── */
function activeBlockId(): string {
  return editorState.activeBlockId || (editorRef.value?.activeBlockId as unknown as string) || ''
}

onEditorCommand('convert-block', (payload) => {
  const { type } = payload as { type: string }
  const id = activeBlockId()
  if (!id) {
    doc.createBlock(type as never)
    emitEditorCommand('focus-last')
    return
  }
  const newId = doc.convertBlock(id, type as never)
  if (newId) editorState.activeBlockId = newId
})

onEditorCommand('insert-block', (payload) => {
  const { type, code, tableMd } = payload as { type: string; code?: string; tableMd?: string }
  const id = activeBlockId()
  const newId = doc.createBlock(type as never, id ? doc.blocks.findIndex((b) => b.id === id) + 1 : undefined)
  if (code != null) {
    const b = doc.blocks.find((x) => x.id === newId)
    if (b) b.code = code
  }
  if (tableMd != null) {
    const b = doc.blocks.find((x) => x.id === newId)
    if (b) b.tableMd = tableMd
  }
  doc.applyBlocks(doc.blocks)
})

onEditorCommand('insert-image', (dataUrl) => {
  const id = activeBlockId()
  const newId = doc.createBlock('image', id ? doc.blocks.findIndex((b) => b.id === id) + 1 : undefined)
  const b = doc.blocks.find((x) => x.id === newId)
  if (b) {
    b.src = dataUrl as string
    b.alt = 'image'
  }
  doc.applyBlocks(doc.blocks)
})

onEditorCommand('focus-last', () => editorRef.value?.focusLast())
onEditorCommand('editor-focus', () => editorRef.value?.focusLast())
onEditorCommand('focus-match', (payload) => {
  const { blockId, query } = payload as { blockId: string; query: string }
  editorRef.value?.focusMatch(blockId, query)
})

/* ── 全局快捷键 ── */
function onGlobalKeydown(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey
  if (!mod) return
  const k = e.key.toLowerCase()
  if (k === 's') {
    e.preventDefault()
    void doc.save().then((p) => toast(p ? `已保存 ${doc.fileName}` : '已取消保存', 'success'))
  } else if (k === 'o') {
    e.preventDefault()
    void doc.openViaDialog().then(() => {
      if (doc.path) toast(`已打开 ${doc.fileName}`, 'success')
    })
  } else if (k === 'n') {
    e.preventDefault()
    void doc.newDocument()
  } else if (k === 'j') {
    e.preventDefault()
    emitEditorCommand('toggle-ai')
  }
}

/* ── 生命周期 ── */
onMounted(() => {
  if (isDevMode()) installLogBridge()
  doc.init()
  ai.init()
  window.addEventListener('keydown', onGlobalKeydown)
  // 启动参数 .md（§6.3 打开管线：get_argv_md）
  void import('@/utils/tauriAPI').then(async ({ tauriAPI }) => {
    const argPath = await tauriAPI.getArgvMd().catch(() => null)
    if (argPath) {
      await doc.openFromPath(argPath)
    }
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
})
</script>

<style scoped lang="scss">
.app-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--hypora-bg);
  overflow: hidden;
}

.app-main {
  flex: 1;
  display: flex;
  min-height: 0;
}

.editor-wrap {
  flex: 1;
  display: flex;
  min-width: 0;
  position: relative;
}
</style>
