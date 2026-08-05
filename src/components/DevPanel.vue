<template>
  <div v-if="visible" class="dev-panel">
    <div class="dev-head">
      <span class="dev-title">🧪 开发者模式</span>
      <button class="dev-close" @click="close">✕</button>
    </div>

    <div class="dev-section">
      <div class="info-grid">
        <div class="info-row"><span>模式</span><b>{{ status.app.tauri ? '桌面（Tauri）' : 'Web 降级' }}</b></div>
        <div class="info-row"><span>版本</span><b>{{ status.app.version }}</b></div>
        <div class="info-row"><span>平台</span><b>{{ status.app.platform }} / {{ status.app.arch }}</b></div>
        <div class="info-row"><span>文档</span><b>{{ status.doc.fileName }} · {{ status.doc.blocks }} 块 · {{ status.doc.chars }} 字</b></div>
      </div>
      <div class="dev-actions">
        <button class="mini-btn" @click="exportDiag">导出诊断报告</button>
        <button class="mini-btn" @click="showLog">打开日志文件</button>
        <button class="mini-btn" @click="refresh">刷新状态</button>
      </div>
    </div>

    <div class="dev-section log-section">
      <div class="log-title">渲染层日志（最近 100 条）</div>
      <div class="log-list">
        <div v-if="logs.length === 0" class="log-empty">尚无日志</div>
        <div v-for="(l, i) in logs" :key="i" class="log-line" :class="l.level">
          <span class="log-level">[{{ l.level }}]</span>
          <span class="log-msg">{{ l.message }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { collectDiagnostics, reportToMarkdown, captureLog, isDevMode } from '@/utils/devMode'
import { tauriAPI } from '@/utils/tauriAPI'
import { useDocumentStore } from '@/stores/document'
import { onEditorCommand } from '@/utils/editorBus'
import { toast } from '@/components/toasts'

const doc = useDocumentStore()
const visible = ref(isDevMode())
const logs = ref<Array<{ level: string; message: string }>>([])
const status = ref({
  app: { tauri: false, version: '', platform: '', arch: '', devMode: false },
  doc: { fileName: '', blocks: 0, chars: 0, dirty: false },
})

async function refresh() {
  const r = await collectDiagnostics({
    fileName: doc.fileName,
    blocks: doc.blockCount,
    chars: doc.charCount,
    dirty: doc.dirty,
  })
  status.value.app = r.app
  status.value.doc = r.doc
  logs.value = r.logs.slice(-100).reverse()
}

async function exportDiag() {
  const report = reportToMarkdown(await collectDiagnostics({
    fileName: doc.fileName,
    blocks: doc.blockCount,
    chars: doc.charCount,
    dirty: doc.dirty,
  }))
  const target = await tauriAPI.saveFileDialog('hypora-diagnostics.md', report)
  if (target) {
    await tauriAPI.writeFile(target, report)
    toast('诊断报告已导出', 'success')
  }
}

async function showLog() {
  await tauriAPI.showLogFile()
}

function close() {
  visible.value = false
}

// 捕获 console → 面板 + 内核（§10 崩溃取证）
const origLog = console.log
const origError = console.error
const origWarn = console.warn

function installCapture() {
  const push = (level: string, args: unknown[]) => {
    const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    logs.value.unshift({ level, message: msg })
    captureLog(level, msg)
    if (logs.value.length > 100) logs.value.pop()
  }
  console.log = (...a) => { push('log', a); origLog(...a) }
  console.warn = (...a) => { push('warn', a); origWarn(...a) }
  console.error = (...a) => { push('error', a); origError(...a) }
}

onMounted(() => {
  installCapture()
  void refresh()
})
onBeforeUnmount(() => {
  console.log = origLog
  console.error = origError
  console.warn = origWarn
})

onEditorCommand('toggle-dev', (v: unknown) => (visible.value = Boolean(v ?? !visible.value)))
</script>

<style scoped lang="scss">
.dev-panel {
  position: fixed;
  right: 0;
  bottom: var(--hypora-statusbar-h);
  width: 360px;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  background: var(--hypora-bg-elevated);
  border: 1px solid var(--hypora-border);
  border-radius: var(--hypora-radius) 0 0 0;
  border-right: none;
  box-shadow: var(--hypora-shadow);
  z-index: var(--hypora-z-popover);
}
.dev-head {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--hypora-border);
  .dev-title {
    flex: 1;
    font-size: 13px;
    font-weight: 600;
  }
}
.dev-close {
  cursor: pointer;
  color: var(--hypora-fg-muted);
}
.dev-section {
  padding: 10px 12px;
  border-bottom: 1px solid var(--hypora-border);
}
.info-grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.info-row {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  span {
    color: var(--hypora-fg-subtle);
  }
}
.dev-actions {
  display: flex;
  gap: 6px;
  margin-top: 10px;
}
.mini-btn {
  padding: 3px 10px;
  border: 1px solid var(--hypora-border);
  border-radius: var(--hypora-radius-sm);
  font-size: 11.5px;
  cursor: pointer;
  color: var(--hypora-fg);
  &:hover {
    background: var(--hypora-bg-hover);
  }
}
.log-section {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.log-title {
  font-size: 11px;
  color: var(--hypora-fg-subtle);
  margin-bottom: 6px;
}
.log-list {
  flex: 1;
  overflow-y: auto;
  font-family: var(--hypora-font-mono);
  font-size: 11px;
  @include subtle-scrollbar;
}
.log-line {
  display: flex;
  gap: 6px;
  padding: 2px 0;
  border-bottom: 1px solid var(--hypora-bg-inset);
  &.error .log-level {
    color: var(--hypora-danger);
  }
  &.warn .log-level {
    color: var(--hypora-warning);
  }
}
.log-level {
  color: var(--hypora-fg-subtle);
  flex-shrink: 0;
}
.log-msg {
  word-break: break-all;
  color: var(--hypora-fg-muted);
}
.log-empty {
  color: var(--hypora-fg-subtle);
  font-size: 11px;
  padding: 12px;
  text-align: center;
}
</style>
