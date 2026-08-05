<template>
  <div class="image-base64" :class="{ open }">
    <div class="modal-mask" @click.self="close"></div>
    <div class="modal">
      <h3>插入图片（Base64 内嵌）</h3>
      <div v-if="preview" class="preview">
        <img :src="preview" alt="预览" />
        <div class="size-hint" :class="{ warn: huge }">
          当前图片 {{ sizeText }}<span v-if="huge"> — 体积较大，建议压缩后再插入</span>
        </div>
      </div>
      <p v-else class="hint">选择图片后将内嵌到文档（适用于截图与本地素材）。</p>
      <div class="actions">
        <button class="ghost-btn" @click="pick">选择图片…</button>
        <button class="accent-btn" :disabled="!dataUrl" @click="confirm">插入</button>
        <button class="ghost-btn" @click="close">取消</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useImageBase64 } from '@/components/imageBase64'

const { pickImage } = useImageBase64()

const open = ref(false)
const dataUrl = ref('')
const fileName = ref('')
const preview = computed(() => dataUrl.value)
const sizeText = computed(() => {
  const bytes = dataUrl.value ? Math.round((dataUrl.value.length * 3) / 4) : 0
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
})
const huge = computed(() => dataUrl.value.length > 1024 * 512) // ~500KB 提示

let resolveFn: ((v: string | null) => void) | null = null

async function pick() {
  const res = await pickImage()
  if (!res) return
  dataUrl.value = res.dataUrl
  fileName.value = res.fileName
}

function confirm() {
  resolveFn?.(dataUrl.value)
  close()
}

function close() {
  open.value = false
  dataUrl.value = ''
  fileName.value = ''
  resolveFn?.(null)
}

async function openDialog(): Promise<string | null> {
  return new Promise((resolve) => {
    resolveFn = resolve
    open.value = true
  })
}

defineExpose({ openDialog })
</script>

<style scoped lang="scss">
.image-base64 {
  display: none;
  &.open {
    display: block;
  }
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: var(--hypora-z-modal);
}
.modal {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 460px;
  max-width: calc(100vw - 48px);
  background: var(--hypora-bg-elevated);
  border: 1px solid var(--hypora-border);
  border-radius: var(--hypora-radius-lg);
  box-shadow: var(--hypora-shadow);
  padding: 20px 24px;
  z-index: calc(var(--hypora-z-modal) + 1);

  h3 {
    font-size: 16px;
    margin-bottom: 14px;
  }
}
.preview {
  img {
    max-width: 100%;
    max-height: 220px;
    border-radius: var(--hypora-radius);
    border: 1px solid var(--hypora-border);
  }
}
.size-hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--hypora-fg-subtle);
  &.warn {
    color: var(--hypora-warning);
  }
}
.hint {
  color: var(--hypora-fg-muted);
  font-size: 13px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}
.ghost-btn {
  @include ghost-button;
}
.accent-btn {
  @include accent-button;
}
</style>
