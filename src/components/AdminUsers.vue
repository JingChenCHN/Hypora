<template>
  <el-dialog
    :model-value="visible"
    width="640px"
    :append-to-body="true"
    class="admin-dialog"
    @close="emit('close')"
  >
    <template #header>
      <div class="admin-header">
        <span class="admin-title">用户管理</span>
        <span class="admin-sub">授权账户 · 密码明文仅在创建/重置时展示一次</span>
      </div>
    </template>

    <!-- 新增用户 -->
    <div class="admin-create">
      <el-input v-model="newName" class="create-input" placeholder="用户名（2-32 位字母/数字/下划线）" :disabled="busy" />
      <el-input v-model="newNote" class="create-note" placeholder="备注（可选，如用途/邮箱）" :disabled="busy" />
      <button class="admin-btn primary" :disabled="busy || !newName.trim()" @click="handleCreate">
        新增用户
      </button>
    </div>
    <div class="create-hint">密码留空将自动生成 24 位长密码，请通过邮件发给用户。</div>

    <!-- 一次性密码展示 -->
    <div v-if="oneTime" class="one-time">
      <div class="one-time-label">该密码仅此一次展示，关闭后无法再次查看</div>
      <div class="one-time-row">
        <span class="one-time-user">{{ oneTime.username }}</span>
        <code class="one-time-pw">{{ oneTime.password }}</code>
        <button class="admin-btn" @click="copyPassword">复制</button>
        <button class="admin-btn" @click="oneTime = null">我已保存</button>
      </div>
    </div>

    <!-- 用户列表 -->
    <div class="admin-list">
      <div v-if="loading" class="admin-empty">加载中…</div>
      <div v-else-if="users.length === 0" class="admin-empty">暂无用户</div>
      <div v-for="u in users" :key="u.username" class="admin-row" :class="{ 'is-admin': u.role === 'admin' }">
        <div class="user-main">
          <span class="user-name">{{ u.username }}</span>
          <span v-if="u.role === 'admin'" class="user-role">管理员</span>
          <span v-if="u.note" class="user-note">{{ u.note }}</span>
        </div>
        <div class="user-meta">
          <span>建于 {{ formatTime(u.createdAt) }}</span>
          <span>聊天 {{ formatBytes(u.chatBytes) }}</span>
        </div>
        <div class="user-actions">
          <button
            v-if="u.role !== 'admin'"
            class="admin-btn"
            :disabled="busy"
            @click="handleReset(u)"
          >重置密码</button>
          <button
            v-if="u.role !== 'admin'"
            class="admin-btn danger"
            :disabled="busy"
            @click="handleDelete(u)"
          >删除</button>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  adminCreateUser, adminDeleteUser, adminListUsers, adminResetPassword, type AdminUserInfo,
} from '@/utils/authApi'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const users = ref<AdminUserInfo[]>([])
const loading = ref(false)
const busy = ref(false)
const newName = ref('')
const newNote = ref('')
// 创建/重置后的一次性明文（仅在内存中，关闭面板即消失）
const oneTime = ref<{ username: string; password: string } | null>(null)

watch(() => props.visible, (v) => { if (v) load() })

async function load() {
  loading.value = true
  try {
    const r = await adminListUsers()
    users.value = r.users
  } catch (e: any) {
    ElMessage.error(e?.message || '加载用户失败')
  } finally {
    loading.value = false
  }
}

async function handleCreate() {
  const name = newName.value.trim()
  if (!name || busy.value) return
  busy.value = true
  try {
    const r = await adminCreateUser(name, newNote.value.trim())
    oneTime.value = { username: r.username, password: r.password }
    newName.value = ''
    newNote.value = ''
    await load()
    ElMessage.success(`已创建用户 ${r.username}`)
  } catch (e: any) {
    ElMessage.error(e?.message || '创建失败')
  } finally {
    busy.value = false
  }
}

async function handleReset(u: AdminUserInfo) {
  try {
    await ElMessageBox.confirm(
      `重置 ${u.username} 的密码后，该用户当前登录会话将全部失效，需要用新密码重新登录。`,
      '重置密码',
      { confirmButtonText: '重置', cancelButtonText: '取消', type: 'warning' },
    )
  } catch { return }
  busy.value = true
  try {
    const r = await adminResetPassword(u.username)
    oneTime.value = { username: r.username, password: r.password }
    await load()
  } catch (e: any) {
    ElMessage.error(e?.message || '重置失败')
  } finally {
    busy.value = false
  }
}

async function handleDelete(u: AdminUserInfo) {
  try {
    await ElMessageBox.confirm(
      `确定删除用户 ${u.username} 吗？其聊天记录将一并删除，且无法登录。`,
      '删除用户',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
    )
  } catch { return }
  busy.value = true
  try {
    await adminDeleteUser(u.username)
    ElMessage.success(`已删除 ${u.username}`)
    await load()
  } catch (e: any) {
    ElMessage.error(e?.message || '删除失败')
  } finally {
    busy.value = false
  }
}

async function copyPassword() {
  if (!oneTime.value) return
  const text = `账号：${oneTime.value.username}\n密码：${oneTime.value.password}`
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
    } else {
      // HTTP 环境降级：隐藏 textarea + execCommand
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    ElMessage.success('已复制，请通过邮件发给用户')
  } catch {
    ElMessage.warning('复制失败，请手动选中复制')
  }
}

function formatTime(ts: number) {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatBytes(n: number) {
  if (!n) return '0'
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + 'KB'
  return n + 'B'
}
</script>

<style lang="scss" scoped>
.admin-header {
  display: flex;
  align-items: baseline;
  gap: 10px;

  .admin-title {
    font-family: Georgia, 'Songti SC', 'Source Han Serif SC', serif;
    font-size: 16px;
    color: var(--text-primary);
  }

  .admin-sub {
    font-size: 11px;
    letter-spacing: 0.1em;
    color: var(--text-muted);
  }
}

.admin-create {
  display: flex;
  gap: 8px;
  margin-bottom: 6px;

  .create-input { flex: 1.2; }
  .create-note { flex: 1; }
}

.create-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 14px;
}

.one-time {
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  border-radius: 2px;
  padding: 12px 14px;
  margin-bottom: 14px;

  .one-time-label {
    font-size: 11px;
    letter-spacing: 0.15em;
    color: var(--text-muted);
    margin-bottom: 8px;
  }

  .one-time-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;

    .one-time-user {
      font-size: 13px;
      color: var(--text-primary);
    }

    .one-time-pw {
      font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
      font-size: 13px;
      color: var(--text-primary);
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: 2px;
      padding: 4px 8px;
      word-break: break-all;
    }
  }
}

.admin-list {
  border: 1px solid var(--border-color);
  border-radius: 2px;
  max-height: 46vh;
  overflow-y: auto;
}

.admin-empty {
  padding: 28px 0;
  text-align: center;
  font-size: 13px;
  color: var(--text-muted);
}

.admin-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);

  &:last-child { border-bottom: none; }
  &:hover { background: var(--bg-tertiary); }

  .user-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;

    .user-name {
      font-size: 13.5px;
      color: var(--text-primary);
    }

    .user-role {
      font-size: 11px;
      letter-spacing: 0.1em;
      color: var(--text-muted);
      border: 1px solid var(--border-color);
      border-radius: 2px;
      padding: 1px 6px;
    }

    .user-note {
      font-size: 12px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  .user-meta {
    display: flex;
    gap: 12px;
    font-size: 12px;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .user-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }
}

.admin-btn {
  font-size: 12px;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  border-radius: 2px;
  padding: 4px 12px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.2s ease;

  &:hover:not(:disabled) {
    color: var(--accent-color);
    border-color: var(--accent-color);
  }

  &:disabled { opacity: 0.5; cursor: not-allowed; }

  &.primary {
    background: var(--accent-color);
    color: var(--bg-primary);
    border-color: var(--accent-color);

    &:hover:not(:disabled) { opacity: 0.85; color: var(--bg-primary); }
  }

  &.danger:hover:not(:disabled) {
    color: var(--el-color-danger);
    border-color: var(--el-color-danger);
  }
}
</style>
