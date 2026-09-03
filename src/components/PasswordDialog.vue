<template>
  <el-dialog
    :model-value="visible"
    width="400px"
    :append-to-body="true"
    class="pw-dialog"
    @close="emit('close')"
  >
    <template #header>
      <span class="pw-title">修改密码</span>
    </template>

    <form class="pw-form" @submit.prevent="handleSubmit">
      <label class="field">
        <span class="field-label">当前密码</span>
        <el-input v-model="oldPw" type="password" show-password autocomplete="current-password" :disabled="busy" />
      </label>
      <label class="field">
        <span class="field-label">新密码（至少 8 位）</span>
        <el-input v-model="newPw" type="password" show-password autocomplete="new-password" :disabled="busy" />
      </label>
      <label class="field">
        <span class="field-label">确认新密码</span>
        <el-input v-model="confirmPw" type="password" show-password autocomplete="new-password" :disabled="busy" />
      </label>
      <button type="submit" class="pw-btn" :disabled="busy || !oldPw || !newPw || !confirmPw">
        {{ busy ? '提交中…' : '确认修改' }}
      </button>
    </form>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { authChangePassword } from '@/utils/authApi'
import { useAuthStore } from '@/stores/auth'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const authStore = useAuthStore()
const oldPw = ref('')
const newPw = ref('')
const confirmPw = ref('')
const busy = ref(false)

watch(() => props.visible, (v) => { if (v) { oldPw.value = ''; newPw.value = ''; confirmPw.value = '' } })

async function handleSubmit() {
  if (busy.value) return
  if (newPw.value.length < 8) {
    ElMessage.warning('新密码至少 8 位')
    return
  }
  if (newPw.value !== confirmPw.value) {
    ElMessage.warning('两次输入的新密码不一致')
    return
  }
  busy.value = true
  try {
    await authChangePassword(oldPw.value, newPw.value)
    ElMessage.success('密码已修改，当前登录保持有效')
    emit('close')
  } catch (e: any) {
    ElMessage.error(e?.message || '修改失败')
  } finally {
    busy.value = false
  }
}
</script>

<style lang="scss" scoped>
.pw-title {
  font-family: Georgia, 'Songti SC', 'Source Han Serif SC', serif;
  font-size: 16px;
  color: var(--text-primary);
}

.pw-form {
  display: flex;
  flex-direction: column;
  gap: 14px;

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;

    .field-label {
      font-size: 11px;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: var(--text-muted);
    }
  }

  .pw-btn {
    margin-top: 6px;
    padding: 10px 22px;
    background: var(--accent-color);
    color: var(--bg-primary);
    border: 1px solid var(--accent-color);
    border-radius: 0;
    font-size: 13px;
    letter-spacing: 0.2em;
    cursor: pointer;
    transition: opacity 0.2s ease;

    &:hover:not(:disabled) { opacity: 0.85; }
    &:disabled { opacity: 0.45; cursor: not-allowed; }
  }
}
</style>
