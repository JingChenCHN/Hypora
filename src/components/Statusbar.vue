<template>
  <div class="statusbar">
    <div class="statusbar-left">
      <!-- 侧边栏折叠/展开（Typora 左下角 <） -->
      <span
        class="status-icon-btn"
        :title="docStore.sidebarVisible ? '折叠侧边栏 (F9)' : '展开侧边栏 (F9)'"
        @click="docStore.toggleSidebar()"
      >
        <el-icon><ArrowLeft v-if="docStore.sidebarVisible" /><ArrowRight v-else /></el-icon>
      </span>
      <!-- 源码模式（Typora 左下角 </>，激活呈方框态即退出入口） -->
      <span
        class="status-icon-btn source-toggle"
        :class="{ 'is-active': docStore.isSourceMode }"
        :title="docStore.isSourceMode ? '退出源码模式 (Ctrl+/)' : '源码模式 (Ctrl+/)'"
        @click="docStore.toggleSourceMode()"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="16 18 22 12 16 6"></polyline>
          <line x1="13.5" y1="5" x2="10.5" y2="19"></line>
          <polyline points="8 6 2 12 8 18"></polyline>
        </svg>
      </span>
    </div>

    <div class="statusbar-right">
      <span class="status-item">{{ stats.words }} 词</span>
      <!-- 账号区：仅网页登录后渲染；桌面版 me 恒空不显示 -->
      <template v-if="authStore.me">
        <span class="status-divider"></span>
        <span class="status-item account-name" :title="`已登录：${authStore.me.username}`">
          <el-icon><User /></el-icon> {{ authStore.me.username }}
        </span>
        <span
          v-if="authStore.me.role === 'admin'"
          class="status-icon-btn"
          title="用户管理"
          @click="emit('toggleAdmin')"
        >
          <el-icon><UserFilled /></el-icon>
        </span>
        <span class="status-icon-btn" title="修改密码" @click="emit('togglePassword')">
          <el-icon><Lock /></el-icon>
        </span>
        <span class="status-icon-btn" title="退出登录" @click="handleLogout">
          <el-icon><SwitchButton /></el-icon>
        </span>
      </template>
      <span class="status-divider"></span>
      <span class="status-icon-btn dev-entry" title="开发者模式 (F12)" @click="emit('toggleDev')">
        <el-icon><Tools /></el-icon>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useDocumentStore } from '@/stores/document'
import { useAuthStore } from '@/stores/auth'
import { Tools, ArrowLeft, ArrowRight, User, UserFilled, Lock, SwitchButton } from '@element-plus/icons-vue'

defineProps<{
  stats: {
    characters: number
    words: number
    lines: number
  }
}>()

const emit = defineEmits<{
  (e: 'toggleDev'): void
  (e: 'toggleAdmin'): void
  (e: 'togglePassword'): void
}>()

const docStore = useDocumentStore()
const authStore = useAuthStore()

// 退出登录：整页 reload，清掉内存里的一切用户态（文档/对话），避免共享浏览器串号
async function handleLogout() {
  await authStore.logout()
  window.location.reload()
}
</script>

<style lang="scss" scoped>
// Typora 式底部功能区：只在文本区下方，与编辑区同底融合（无分隔线），极简三件套
.statusbar {
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 12px;
  background: var(--bg-primary);
  font-size: 12px;
  color: var(--text-muted);
  user-select: none;

  .statusbar-left, .statusbar-right {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .status-item {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 4px;

    &.account-name {
      color: var(--text-secondary);
      max-width: 160px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
  }

  .status-icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 2px;
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.2s;
    flex-shrink: 0;

    .el-icon {
      font-size: 14px;
    }

    svg {
      display: block;
    }

    &:hover {
      background: var(--bg-tertiary);
      color: var(--accent-color);
    }

    // 源码模式激活态：方框态（Typora 式），发丝线描边 + 墨色
    &.source-toggle.is-active {
      background: var(--bg-tertiary);
      box-shadow: inset 0 0 0 1px var(--border-color);
      color: var(--accent-color);

      &:hover {
        box-shadow: inset 0 0 0 1px var(--text-muted);
      }
    }
  }
}
</style>
