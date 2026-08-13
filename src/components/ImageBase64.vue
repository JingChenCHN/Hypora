<template>
  <el-dialog v-model="visible" title="图片转 Base64" width="540px" :close-on-click-modal="false">
    <!-- 上传区 -->
    <div class="ib64-upload" @click="pick" @dragover.prevent @drop.prevent="onDrop">
      <template v-if="!originalUrl">
        <el-icon :size="32"><Picture /></el-icon>
        <p>点击 / 拖拽 / 粘贴图片</p>
      </template>
      <img v-else :src="originalUrl" class="ib64-preview" />
    </div>
    <input ref="fileRef" type="file" accept="image/*" hidden @change="onFile" />

    <!-- 目标尺寸设置 -->
    <div class="ib64-settings">
      <div class="row">
        <span class="lbl">目标宽</span>
        <el-input-number v-model="targetW" :min="1" :max="8192" size="small" controls-position="right" @change="onSize('w')" />
        <span class="lbl">高</span>
        <el-input-number v-model="targetH" :min="1" :max="8192" size="small" controls-position="right" @change="onSize('h')" />
        <el-checkbox v-model="keepRatio" size="small" style="margin-left:4px">保持比例</el-checkbox>
      </div>
      <div class="row">
        <span class="lbl">格式</span>
        <el-select v-model="format" size="small" style="width:110px">
          <el-option label="PNG" value="image/png" />
          <el-option label="JPEG" value="image/jpeg" />
          <el-option label="WebP" value="image/webp" />
        </el-select>
        <template v-if="format !== 'image/png'">
          <span class="lbl">质量</span>
          <el-slider v-model="quality" :min="0.1" :max="1" :step="0.05" style="width:120px" />
          <span class="q">{{ quality.toFixed(2) }}</span>
        </template>
      </div>
      <div class="row presets">
        <button v-for="p in presets" :key="p.label" class="preset-btn" @click="applyPreset(p)">{{ p.label }}</button>
      </div>
    </div>

    <!-- 结果 -->
    <div class="ib64-result">
      <el-input v-model="base64" type="textarea" :rows="4" readonly placeholder="设置尺寸后点「生成」…" />
      <div class="ib64-actions">
        <span class="dim" v-if="naturalW">{{ naturalW }}×{{ naturalH }} → {{ targetW }}×{{ targetH }}</span>
        <span class="size" v-if="base64">≈ {{ sizeKb }} KB</span>
        <span style="flex:1"></span>
        <el-button size="small" :disabled="!base64" @click="copy">复制</el-button>
        <el-button size="small" type="primary" :disabled="!originalUrl" @click="convert">生成</el-button>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'
import { Picture } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'

const visible = defineModel<boolean>({ default: false })

const fileRef = ref<HTMLInputElement>()
const originalUrl = ref('')
const imgEl = ref<HTMLImageElement | null>(null)
const naturalW = ref(0)
const naturalH = ref(0)
const targetW = ref(0)
const targetH = ref(0)
const keepRatio = ref(true)
const format = ref('image/png')
const quality = ref(0.9)
const base64 = ref('')

// 预设分辨率（w/h 为 0=原始，负数=缩放比例）
const presets = [
  { label: '原始', w: 0, h: 0 },
  { label: '1920×1080', w: 1920, h: 1080 },
  { label: '1280×720', w: 1280, h: 720 },
  { label: '1024 宽', w: 1024, h: 0 },
  { label: '512 宽', w: 512, h: 0 },
  { label: '50%', w: -0.5, h: -0.5 }
]

const sizeKb = computed(() => {
  if (!base64.value) return 0
  const b64 = base64.value.slice(base64.value.indexOf(',') + 1)
  return Math.round((b64.length * 3 / 4) / 1024)
})

function pick() { fileRef.value?.click() }

function loadFile(file: File) {
  if (!file.type.startsWith('image/')) { ElMessage.warning('请选择图片文件'); return }
  const url = URL.createObjectURL(file)
  const img = new Image()
  img.onload = () => {
    imgEl.value = img
    naturalW.value = img.naturalWidth
    naturalH.value = img.naturalHeight
    targetW.value = img.naturalWidth
    targetH.value = img.naturalHeight
    originalUrl.value = url
    base64.value = ''
  }
  img.onerror = () => ElMessage.error('图片加载失败')
  img.src = url
}

function onFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) loadFile(f)
  if (fileRef.value) fileRef.value.value = ''
}

function onDrop(e: DragEvent) {
  const f = e.dataTransfer?.files?.[0]
  if (f) loadFile(f)
}

// 对话框打开时支持粘贴图片
function onPaste(e: ClipboardEvent) {
  if (!visible.value) return
  const item = Array.from(e.clipboardData?.items || []).find(i => i.type.startsWith('image/'))
  const f = item?.getAsFile()
  if (f) loadFile(f)
}
window.addEventListener('paste', onPaste)
onBeforeUnmount(() => window.removeEventListener('paste', onPaste))

// 保持比例联动
function onSize(which: 'w' | 'h') {
  if (!keepRatio.value || !naturalW.value) return
  const ratio = naturalH.value / naturalW.value
  if (which === 'w') targetH.value = Math.round(targetW.value * ratio)
  else targetW.value = Math.round(targetH.value / ratio)
}

function applyPreset(p: { label: string; w: number; h: number }) {
  if (!naturalW.value) { ElMessage.warning('请先选择图片'); return }
  if (p.w === 0 && p.h === 0) { targetW.value = naturalW.value; targetH.value = naturalH.value; return }
  if (p.w < 0) {
    targetW.value = Math.round(naturalW.value * -p.w)
    targetH.value = Math.round(naturalH.value * -p.h)
    return
  }
  if (p.w && p.h) { targetW.value = p.w; targetH.value = p.h; return }
  if (p.w) { targetW.value = p.w; targetH.value = Math.round(p.w * naturalH.value / naturalW.value); return }
  if (p.h) { targetH.value = p.h; targetW.value = Math.round(p.h * naturalW.value / naturalH.value) }
}

// canvas 缩放到目标尺寸并输出 base64
function convert() {
  if (!imgEl.value) { ElMessage.warning('请先选择图片'); return }
  const w = targetW.value || naturalW.value
  const h = targetH.value || naturalH.value
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  // JPEG 无透明通道，铺白底
  if (format.value === 'image/jpeg') {
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(imgEl.value, 0, 0, w, h)
  base64.value = canvas.toDataURL(format.value, quality.value)
  ElMessage.success('已生成 Base64')
}

async function copy() {
  try {
    await navigator.clipboard.writeText(base64.value)
    ElMessage.success('已复制到剪贴板')
  } catch {
    ElMessage.error('复制失败')
  }
}
</script>

<style scoped lang="scss">
.ib64-upload {
  border: 1px dashed var(--border-color);
  border-radius: 2px;
  min-height: 120px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--text-muted);
  cursor: pointer;
  margin-bottom: 12px;
  overflow: hidden;
  &:hover { border-color: var(--accent-color); }
}
.ib64-preview { max-height: 160px; max-width: 100%; object-fit: contain; }
.ib64-settings { display: flex; flex-direction: column; gap: 10px; margin-bottom: 12px; }
.ib64-settings .row { display: flex; align-items: center; gap: 8px; }
.ib64-settings .lbl { font-size: 13px; color: var(--text-secondary); flex-shrink: 0; }
.ib64-settings .q { font-size: 12px; color: var(--text-muted); }
.ib64-settings .presets { flex-wrap: wrap; gap: 6px; }
.ib64-settings .preset-btn {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 2px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-secondary);
  cursor: pointer;
  font-family: inherit;
  &:hover { color: var(--accent-color); border-color: var(--accent-color); }
}
.ib64-result .size, .ib64-result .dim { font-size: 12px; color: var(--text-muted); }
.ib64-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
</style>
