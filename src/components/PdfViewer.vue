<template>
  <div
    ref="containerRef"
    class="pdf-viewer"
    :aria-label="title || 'PDF 预览'"
    @wheel.ctrl.prevent="onCtrlWheel"
  >
    <!-- 文档名：micro-label（11px / 0.16em / uppercase / muted），收在顶部留白里，不抢纸面 -->
    <div v-if="title" class="pdf-doc-name">{{ title }}</div>

    <!-- 页面：占位即布局。未渲染页由 .pdf-page 显式尺寸撑起（虚拟化），canvas 就位后填满 -->
    <div
      v-for="n in readyPages"
      :key="n"
      class="pdf-page"
      :data-page="n"
      :style="pageStyle(n)"
    >
      <canvas></canvas>
    </div>

    <!-- 非就绪状态（空 / 载入中 / 出错）：居中静音文案 -->
    <div v-if="status !== 'ready'" class="pdf-status">{{ statusText }}</div>

    <!-- 底部悬浮工具条：sticky 流内悬浮（absolute 在滚动容器内会随内容滚走） -->
    <div v-if="status === 'ready'" class="pdf-toolbar" @mousedown.stop>
      <button class="vbtn" title="缩小 (Ctrl+滚轮)" @click="zoomStep(-1)">－</button>
      <span class="vscale" title="点击重置为 100%" @click="setZoom(100)">{{ Math.round(effScale * 100) }}%</span>
      <button class="vbtn" title="放大 (Ctrl+滚轮)" @click="zoomStep(1)">＋</button>
      <button class="vbtn vfit" :class="{ on: internalFit }" title="适应窗口宽度" @click="setFitWidth">适宽</button>
      <span class="vsep"></span>
      <button class="vbtn" title="向左旋转 90°" @click="rotate(-90)">⟲</button>
      <button class="vbtn" title="向右旋转 90°" @click="rotate(90)">⟳</button>
      <span class="vsep"></span>
      <span class="vpage">{{ currentPage || '—' }} / {{ totalPages }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

const props = defineProps<{
  base64: string
  zoom: number
  fitWidth: boolean
  title?: string
}>()

const emit = defineEmits<{
  (e: 'loaded', totalPages: number): void
  (e: 'page-change', page: number): void
  (e: 'zoom-change', payload: { zoom: number; fitWidth: boolean }): void
  (e: 'error', message: string): void
}>()

defineExpose({ goToPage, setZoom, setFitWidth, rotate })

// ===== 常量 =====
const ZOOM_MIN = 25
const ZOOM_MAX = 400
const ZOOM_STEP = 10
// 滚动容器左右 padding 24×2 + 页卡 1px 描边 ×2：适宽基准宽度，避免触发横向滚动
const PAGE_INSET = 50
const PRERENDER_MARGIN = '600px 0px' // 预渲染缓冲区（上下各 600px）

// Worker 源走 Vite 的 ?url 静态资源地址（pdfjs-dist 按需 async chunk，不进首屏）
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

// ===== 状态 =====
type ViewerStatus = 'empty' | 'loading' | 'ready' | 'error'
const status = ref<ViewerStatus>('empty')
const errorMsg = ref('')
const totalPages = ref(0)
const currentPage = ref(0)
const rotationOffset = ref(0) // 0/90/180/270，叠加在页面自身 rotate 之上

const containerRef = ref<HTMLElement>()
const containerWidth = ref(0)
const internalZoom = ref(clampZoom(props.zoom)) // 25–400，步进 10
const internalFit = ref(props.fitWidth)
const fitScale = ref(1)
const effScale = computed(() => (internalFit.value ? fitScale.value : internalZoom.value / 100))
const readyPages = computed(() => (status.value === 'ready' ? totalPages.value : 0))

const statusText = computed(() => {
  if (status.value === 'loading') return '正在载入 PDF'
  if (status.value === 'error') return errorMsg.value
  if (status.value === 'empty') return '未选择 PDF 文档'
  return ''
})

// ===== pdf.js 句柄（非响应式，避免被代理拖慢） =====
let pdfDoc: PDFDocumentProxy | null = null
let loadingTask: PDFDocumentLoadingTask | null = null
const pageDims = new Map<number, { width: number; height: number }>() // 每页 scale=1 尺寸（含页面自身 rotate）
const pageProxies = new Map<number, PDFPageProxy>()
const renderTasks = new Map<number, RenderTask>()
const renderedPages = new Set<number>() // 已画出内容的页：缩放/旋转时仅需重绘这批
const visibleRatios = new Map<number, number>() // 交叉比：最高者为当前页
const pageChains = new Map<number, Promise<void>>() // 逐页串行，避免并发 render 同一 canvas
let io: IntersectionObserver | null = null
let ro: ResizeObserver | null = null
let rerenderTimer: number | null = null
let rafId = 0
let loadSeq = 0 // 加载序号：换文档 / 卸载后丢弃过期结果
const pendingRenders = new Set<number>()

// ===== 载入 =====
function base64ToUint8(b64: string): Uint8Array {
  // 兼容 data URL 前缀与换行空白
  const raw = b64.replace(/^data:[^;]*;base64,/, '').replace(/\s+/g, '')
  const bin = atob(raw)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function toErrorMessage(err: unknown): string {
  const e = err as { name?: string; message?: string }
  if (e?.name === 'PasswordException') return '该 PDF 已加密，暂不支持打开'
  if (e?.name === 'InvalidPDFException' || err instanceof pdfjsLib.InvalidPDFException) return 'PDF 文件已损坏或格式无效'
  return 'PDF 打开失败：' + (e?.message || '未知错误')
}

async function load() {
  teardownDoc()
  if (!props.base64) {
    status.value = 'empty'
    totalPages.value = 0
    currentPage.value = 0
    return
  }
  status.value = 'loading'
  errorMsg.value = ''
  const seq = ++loadSeq
  try {
    // 每次传全新 Uint8Array 副本：pdf.js 会 transfer ArrayBuffer，复用会拿到已 detach 的缓冲区
    const data = base64ToUint8(props.base64)
    const task = pdfjsLib.getDocument({ data })
    loadingTask = task
    const doc = await task.promise
    if (seq !== loadSeq) { void doc.destroy(); return }
    pdfDoc = doc
    totalPages.value = doc.numPages
    // 先遍历缓存每页 scale=1 尺寸：占位布局与适宽计算不依赖逐页渲染
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      if (seq !== loadSeq) return
      const vp = page.getViewport({ scale: 1 })
      pageDims.set(n, { width: vp.width, height: vp.height })
    }
    status.value = 'ready'
    rotationOffset.value = 0
    currentPage.value = 0
    recomputeFitScale()
    await nextTick()
    if (seq !== loadSeq) return
    containerRef.value?.scrollTo({ top: 0 })
    setupObservers()
    emit('loaded', doc.numPages)
  } catch (err) {
    if (seq !== loadSeq) return
    status.value = 'error'
    errorMsg.value = toErrorMessage(err)
    emit('error', errorMsg.value)
  }
}

// ===== 布局 =====
// 页卡显式尺寸：scale=1 尺寸 × effScale，旋转 90/270 时宽高互换（占位虚拟化的全部来源）
function pageStyle(n: number): Record<string, string> {
  const d = pageDims.get(n)
  if (!d || status.value !== 'ready') return {}
  const s = effScale.value
  let w = d.width * s
  let h = d.height * s
  if (((rotationOffset.value % 180) + 180) % 180 !== 0) {
    const t = w
    w = h
    h = t
  }
  return { width: `${w}px`, height: `${h}px` }
}

function recomputeFitScale() {
  const d = pageDims.get(1)
  const avail = containerWidth.value - PAGE_INSET
  if (!d || avail <= 0) return
  const baseW = ((rotationOffset.value % 180) + 180) % 180 !== 0 ? d.height : d.width
  if (baseW > 0) fitScale.value = Math.max(0.05, avail / baseW)
}

// ===== 观察器：当前页 + 懒渲染共用一个 IntersectionObserver =====
function setupObservers() {
  const el = containerRef.value
  if (!el) return
  teardownObservers()
  containerWidth.value = el.clientWidth
  ro = new ResizeObserver(() => {
    if (el.clientWidth === containerWidth.value) return
    containerWidth.value = el.clientWidth
    if (!internalFit.value) return
    recomputeFitScale()
    scheduleRerender(120)
  })
  ro.observe(el)
  io = new IntersectionObserver(onIntersect, {
    root: el,
    rootMargin: PRERENDER_MARGIN,
    threshold: [0, 0.25, 0.5, 0.75, 1]
  })
  el.querySelectorAll<HTMLElement>('.pdf-page').forEach(p => io!.observe(p))
}

function onIntersect(entries: IntersectionObserverEntry[]) {
  for (const en of entries) {
    const n = Number((en.target as HTMLElement).dataset.page)
    if (!n) continue
    visibleRatios.set(n, en.isIntersecting ? en.intersectionRatio : 0)
    if (en.isIntersecting) scheduleRender(n)
    else discardPage(n)
  }
  // 交叉比最高者为当前页
  let best = 0
  let bestRatio = 0
  visibleRatios.forEach((r, n) => {
    if (r > bestRatio) { bestRatio = r; best = n }
  })
  if (best && best !== currentPage.value) {
    currentPage.value = best
    emit('page-change', best)
  }
}

function scheduleRender(n: number) {
  pendingRenders.add(n)
  if (rafId) return
  rafId = requestAnimationFrame(() => {
    rafId = 0
    const list = [...pendingRenders]
    pendingRenders.clear()
    for (const p of list) renderPage(p)
  })
}

// 离开缓冲区：取消任务、清画布释放位图、移出已渲染集合（重进时按当前比例重绘）
function discardPage(n: number) {
  const task = renderTasks.get(n)
  if (task) { renderTasks.delete(n); task.cancel() }
  renderedPages.delete(n)
  visibleRatios.delete(n)
  const canvas = findCanvas(n)
  if (canvas) { canvas.width = 0; canvas.height = 0 }
}

// ===== 渲染 =====
function findCanvas(n: number): HTMLCanvasElement | null {
  return containerRef.value?.querySelector<HTMLCanvasElement>(`.pdf-page[data-page="${n}"] canvas`) ?? null
}

// 同页串行化：IO 阈值多次触发 / 缩放重绘可能撞上在途渲染，排队逐个执行
function renderPage(n: number) {
  const prev = pageChains.get(n) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(() => doRenderPage(n))
  pageChains.set(n, next)
}

async function doRenderPage(n: number) {
  const doc = pdfDoc
  if (!doc || status.value !== 'ready') return
  // 排队等待期间可能已被丢弃（滚出缓冲区 / 换文档）
  if (!visibleRatios.has(n) && !renderedPages.has(n)) return
  const canvas = findCanvas(n)
  const d = pageDims.get(n)
  if (!canvas || !d) return

  // 上一轮渲染未完成则先取消并等其收尾，避免并发写同一 canvas
  const prevTask = renderTasks.get(n)
  if (prevTask) {
    renderTasks.delete(n)
    prevTask.cancel()
    try { await prevTask.promise } catch { /* 取消是常规流程 */ }
    if (pdfDoc !== doc || status.value !== 'ready') return
    if (!visibleRatios.has(n) && !renderedPages.has(n)) return
  }

  try {
    let page = pageProxies.get(n)
    if (!page) { page = await doc.getPage(n); pageProxies.set(n, page) }
    if (pdfDoc !== doc || status.value !== 'ready') return

    const viewport = page.getViewport({
      scale: effScale.value,
      rotation: ((page.rotate + rotationOffset.value) % 360 + 360) % 360
    })
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // 物理像素 = viewport × dpr，CSS 尺寸由 .pdf-page 精确约束（canvas 100%）
    canvas.width = Math.max(1, Math.floor(viewport.width * dpr))
    canvas.height = Math.max(1, Math.floor(viewport.height * dpr))
    const task = page.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
    })
    renderTasks.set(n, task)
    await task.promise
    renderedPages.add(n)
  } catch { /* 取消 / 换文档中断属常规流程，静默 */ }
  finally {
    const task = renderTasks.get(n)
    if (task) renderTasks.delete(n)
  }
}

// effScale / 旋转变化：防抖后 cancel + 清画布 + 重绘已渲染页（未渲染页进入视口按新比例首绘）
function scheduleRerender(delay: number) {
  if (rerenderTimer !== null) clearTimeout(rerenderTimer)
  rerenderTimer = window.setTimeout(() => {
    rerenderTimer = null
    if (status.value !== 'ready') return
    for (const n of [...renderedPages]) renderPage(n)
  }, delay)
}

// ===== 缩放 / 旋转（对外契约） =====
function clampZoom(z: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z / ZOOM_STEP) * ZOOM_STEP))
}

function setZoom(z: number) {
  const next = clampZoom(z)
  const changed = next !== internalZoom.value || internalFit.value
  internalFit.value = false
  internalZoom.value = next
  if (changed) emit('zoom-change', { zoom: internalZoom.value, fitWidth: false })
}

function setFitWidth() {
  if (internalFit.value) return
  internalFit.value = true
  recomputeFitScale()
  emit('zoom-change', { zoom: internalZoom.value, fitWidth: true })
}

// dir：±1 档，每档 ZOOM_STEP%；适宽时从 100% 起步
function zoomStep(dir: number) {
  setZoom((internalFit.value ? 100 : internalZoom.value) + dir * ZOOM_STEP)
}

function rotate(deg: number) {
  rotationOffset.value = (((rotationOffset.value + deg) % 360) + 360) % 360
  recomputeFitScale()
  scheduleRerender(150)
}

function goToPage(n: number) {
  const el = containerRef.value?.querySelector<HTMLElement>(`.pdf-page[data-page="${n}"]`)
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function onCtrlWheel(e: WheelEvent) {
  zoomStep(e.deltaY < 0 ? 1 : -1)
}

// ===== 外部状态同步（props → internal，不回发 zoom-change） =====
watch(() => props.zoom, (v) => {
  const next = clampZoom(v)
  if (next !== internalZoom.value) internalZoom.value = next
})
watch(() => props.fitWidth, (v) => {
  if (v === internalFit.value) return
  internalFit.value = v
  if (v) recomputeFitScale()
  scheduleRerender(150)
})
watch(effScale, () => scheduleRerender(150))
watch(() => props.base64, () => { void load() })

onMounted(() => { if (props.base64) void load() })

// ===== 清理 =====
function teardownObservers() {
  io?.disconnect()
  io = null
  ro?.disconnect()
  ro = null
  visibleRatios.clear()
}

function teardownDoc() {
  if (rerenderTimer !== null) { clearTimeout(rerenderTimer); rerenderTimer = null }
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
  pendingRenders.clear()
  renderTasks.forEach(t => t.cancel())
  renderTasks.clear()
  renderedPages.clear()
  pageProxies.clear()
  pageDims.clear()
  pageChains.clear()
  if (loadingTask) { void loadingTask.destroy(); loadingTask = null }
  if (pdfDoc) { void pdfDoc.destroy(); pdfDoc = null }
}

onBeforeUnmount(() => {
  loadSeq++
  teardownDoc()
  teardownObservers()
})
</script>

<style lang="scss" scoped>
.pdf-viewer {
  position: relative;
  height: 100%;
  overflow-y: auto;
  background: var(--bg-secondary);
  /* 底部 20px：悬浮工具条为 sticky 流内元素，自身占位，无需额外预留 */
  padding: 24px 24px 20px;

  .pdf-doc-name {
    position: absolute;
    top: 8px;
    left: 28px;
    max-width: 60%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-muted);
    user-select: none;
    pointer-events: none;
  }

  .pdf-page {
    margin: 0 auto 16px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    box-shadow: var(--shadow);
    border-radius: 2px;

    &:nth-last-child(1 of .pdf-page) {
      margin-bottom: 0;
    }

    canvas {
      display: block;
      width: 100%;
      height: 100%;
    }
  }

  .pdf-status {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-muted);
    user-select: none;
    pointer-events: none;
  }

  /* 悬浮工具条：sticky 钉在滚动视口底部，颜色全取主题变量 */
  .pdf-toolbar {
    position: sticky;
    bottom: 20px;
    z-index: 5;
    width: fit-content;
    margin: 12px auto 0;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 10px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 2px;
    box-shadow: var(--shadow-overlay);

    .vbtn {
      min-width: 30px;
      height: 28px;
      padding: 0 8px;
      background: transparent;
      border: none;
      border-radius: 2px;
      color: var(--text-secondary);
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
      transition: background 0.2s ease, color 0.2s ease;

      &:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }

      &.on {
        background: var(--text-primary);
        color: var(--bg-primary);
      }
    }

    /* 适宽是文字按钮，字号收小与 glyph 按钮同高 */
    .vfit {
      font-size: 12px;
      letter-spacing: 0.05em;
    }

    .vscale {
      min-width: 52px;
      text-align: center;
      font-size: 12px;
      color: var(--text-secondary);
      cursor: default;
      font-variant-numeric: tabular-nums;
      user-select: none;
    }

    .vpage {
      font-size: 12px;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
      user-select: none;
    }

    .vsep {
      width: 1px;
      height: 16px;
      background: var(--border-color);
      margin: 0 4px;
    }
  }
}
</style>
