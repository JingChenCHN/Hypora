<template>
  <div class="login-gate">
    <!-- 会话探测中:只显示 micro-label,避免编辑器闪现 -->
    <div v-if="!authStore.ready" class="gate-probe">
      <span class="probe-label">正在验证会话</span>
    </div>

    <!-- 未登录:登录表单 -->
    <div v-else class="gate-card">
      <div class="gate-brand">
        <h1 class="gate-title">Hypora</h1>
        <div class="gate-sub">授权访问 · Authenticated Access</div>
      </div>

      <form class="gate-form" @submit.prevent="handleLogin">
        <label class="field">
          <span class="field-label">用户名</span>
          <el-input v-model="username" size="large" placeholder="username" autocomplete="username" :disabled="busy" />
        </label>
        <label class="field">
          <span class="field-label">密码</span>
          <el-input v-model="password" size="large" type="password" placeholder="••••••••" show-password autocomplete="current-password" :disabled="busy" />
        </label>
        <button type="submit" class="gate-btn" :disabled="busy || !username || !password">
          {{ busy ? '登录中…' : '登 录' }}
        </button>
      </form>

      <div class="gate-register">
        <div class="register-label">获取账号</div>
        <p class="register-text">
          本站采用授权制，不开放线上注册。请将申请信息发送至
          <a class="register-mail" :href="`mailto:${REGISTER_MAIL}?subject=${encodeURIComponent('Hypora 账号申请')}`">{{ REGISTER_MAIL }}</a>，
          管理员审核后会通过邮件回复可用账号与初始密码。
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()
const REGISTER_MAIL = 'hemo8212@outlook.com'

const username = ref('')
const password = ref('')
const busy = ref(false)

async function handleLogin() {
  if (busy.value || !username.value || !password.value) return
  busy.value = true
  try {
    await authStore.login(username.value.trim(), password.value)
    password.value = ''
  } catch (e: any) {
    ElMessage.error(e?.message || '登录失败')
  } finally {
    busy.value = false
  }
}
</script>

<style lang="scss" scoped>
.login-gate {
  width: 100%;
  height: 100%;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-primary);
  padding: 24px;
}

.gate-probe {
  .probe-label {
    font-size: 11px;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
}

.gate-card {
  width: 360px;
  max-width: 100%;
  padding: 40px 36px 28px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 2px;
}

.gate-brand {
  text-align: center;
  margin-bottom: 32px;

  .gate-title {
    margin: 0;
    font-family: Georgia, 'Songti SC', 'Source Han Serif SC', 'Noto Serif SC', serif;
    font-weight: 400;
    font-size: 30px;
    letter-spacing: -0.015em;
    color: var(--text-primary);
  }

  .gate-sub {
    margin-top: 10px;
    font-size: 11px;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
}

.gate-form {
  display: flex;
  flex-direction: column;
  gap: 16px;

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

  .gate-btn {
    margin-top: 8px;
    padding: 12px 22px;
    background: var(--accent-color);
    color: var(--bg-primary);
    border: 1px solid var(--accent-color);
    border-radius: 0;
    font-size: 14px;
    letter-spacing: 0.35em;
    cursor: pointer;
    transition: opacity 0.2s ease;

    &:hover:not(:disabled) { opacity: 0.85; }
    &:disabled { opacity: 0.45; cursor: not-allowed; }
  }
}

.gate-register {
  margin-top: 28px;
  padding-top: 18px;
  border-top: 1px solid var(--border-color);

  .register-label {
    font-size: 11px;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 8px;
  }

  .register-text {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.7;
    color: var(--text-secondary);
  }

  .register-mail {
    color: var(--accent-color);
    text-decoration: none;
    border-bottom: 1px solid var(--border-color);
    transition: border-color 0.2s ease;

    &:hover { border-color: var(--accent-color); }
  }
}
</style>
