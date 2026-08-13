<template>
  <el-drawer
    v-model="visible"
    title="开发者模式"
    direction="rtl"
    size="480px"
    :with-header="true"
    class="dev-drawer"
  >
    <div class="dev-panel">
      <!-- 环境信息卡片 -->
      <div class="dev-section">
        <div class="section-title">
          <el-icon><Monitor /></el-icon>
          <span>运行环境</span>
          <el-tag size="small" :type="status?.devMode ? 'success' : 'info'" style="margin-left: auto;">
            {{ status?.devMode ? '开发者模式' : '正常模式' }}
          </el-tag>
        </div>
        <div class="env-grid" v-if="status">
          <div class="env-item">
            <span class="env-label">运行环境</span>
            <span class="env-value">{{ isElectron ? 'Electron 桌面版' : 'Web 浏览器' }}</span>
          </div>
          <template v-if="isElectron && status.versions">
            <div class="env-item">
              <span class="env-label">应用版本</span>
              <span class="env-value">{{ status.versions.app }}</span>
            </div>
            <div class="env-item">
              <span class="env-label">Electron</span>
              <span class="env-value">{{ status.versions.electron }}</span>
            </div>
            <div class="env-item">
              <span class="env-label">Chrome</span>
              <span class="env-value">{{ status.versions.chrome }}</span>
            </div>
            <div class="env-item">
              <span class="env-label">Node.js</span>
              <span class="env-value">{{ status.versions.node }}</span>
            </div>
            <div class="env-item" v-if="status.platform">
              <span class="env-label">操作系统</span>
              <span class="env-value">{{ status.platform.type }} {{ status.platform.release }} ({{ status.platform.arch }})</span>
            </div>
          </template>
        </div>
        <div v-else class="env-loading">加载中...</div>
      </div>

      <!-- 快捷操作 -->
      <div class="dev-section">
        <div class="section-title">
          <el-icon><Tools /></el-icon>
          <span>快捷操作</span>
        </div>
        <div class="action-grid">
          <el-button @click="handleToggleDevTools" :icon="Cpu">
            开发者工具
          </el-button>
          <el-button @click="handleReload(false)" :icon="RefreshRight">
            重新加载
          </el-button>
          <el-button @click="handleReload(true)" :icon="Refresh">
            强制刷新
          </el-button>
          <el-button @click="handleShowLog" :icon="Document" :disabled="!isElectron">
            查看日志文件
          </el-button>
        </div>

        <!-- 开发者模式开关 -->
        <div class="dev-mode-switch">
          <div class="switch-info">
            <div class="switch-title">启动时自动打开开发者工具</div>
            <div class="switch-desc">开启后每次启动应用自动打开 DevTools，便于排查问题</div>
          </div>
          <el-switch
            v-model="autoDevTools"
            @change="handleDevModeChange"
            :disabled="!isElectron"
          />
        </div>
      </div>

      <!-- 反馈问题 -->
      <div class="dev-section">
        <div class="section-title">
          <el-icon><ChatLineSquare /></el-icon>
          <span>反馈问题</span>
        </div>
        <el-input
          v-model="feedbackText"
          type="textarea"
          :rows="4"
          placeholder="请描述你遇到的问题：1.你做了什么操作 2.期望结果 3.实际结果 4.是否能复现"
        />
        <div class="feedback-actions">
          <el-button type="primary" @click="handleExportDiagnostics" :icon="Download">
            导出诊断报告
          </el-button>
          <el-button @click="handleOpenFeedback" :icon="Link">
            提交到 GitHub
          </el-button>
        </div>
        <div class="feedback-tip">
          💡 建议：先导出诊断报告，再把报告文件连同问题描述一并发给我们，能大幅加快问题定位。
        </div>
      </div>

      <!-- 实时日志 -->
      <div class="dev-section">
        <div class="section-title">
          <el-icon><Document /></el-icon>
          <span>实时日志</span>
          <el-tag size="small" style="margin-left: auto;">{{ logs.length }} 条</el-tag>
          <el-button text size="small" @click="handleClearLogs" style="margin-left: 8px;">
            清空
          </el-button>
        </div>
        <div class="log-container" ref="logContainer">
          <div
            v-for="(entry, index) in logs"
            :key="index"
            class="log-entry"
            :class="`log-${entry.level.toLowerCase()}`"
          >
            <span class="log-time">{{ entry.time }}</span>
            <span class="log-level">{{ entry.level }}</span>
            <span class="log-source">[{{ entry.source }}]</span>
            <span class="log-message">{{ entry.message }}</span>
          </div>
          <div v-if="logs.length === 0" class="log-empty">暂无日志</div>
        </div>
      </div>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { ref, onMounted, watch, nextTick } from 'vue'
import {
  Monitor, Tools, Cpu, RefreshRight, Refresh, Document,
  ChatLineSquare, Download, Link
} from '@element-plus/icons-vue'
import {
  isElectron, getDevStatus, toggleDevTools, openFeedback,
  exportDiagnostics, onLogUpdate, clearLogs, devLog, getLogs
} from '@/utils/devMode'

const visible = defineModel<boolean>('visible', { default: false })

const status = ref<Awaited<ReturnType<typeof getDevStatus>>>(null)
const autoDevTools = ref(false)
const feedbackText = ref('')
const logs = ref(getLogs())
const logContainer = ref<HTMLElement>()

let unsubLog: (() => void) | null = null

watch(visible, async (v) => {
  if (v) {
    await loadStatus()
  }
})

watch(logs, () => {
  nextTick(() => {
    if (logContainer.value) {
      logContainer.value.scrollTop = logContainer.value.scrollHeight
    }
  })
}, { deep: true })

async function loadStatus() {
  status.value = await getDevStatus()
  if (status.value) {
    autoDevTools.value = status.value.devMode
  }
}

async function handleToggleDevTools() {
  await toggleDevTools()
}

async function handleReload(ignoreCache: boolean) {
  if (isElectron()) {
    await window.electronAPI!.dev!.reload(ignoreCache)
  } else {
    ignoreCache ? location.reload() : location.reload()
  }
}

async function handleShowLog() {
  if (isElectron()) {
    await window.electronAPI!.dev!.showLogFile()
  }
}

async function handleDevModeChange(val: boolean) {
  if (!isElectron()) return
  await window.electronAPI!.dev!.setDevMode(val)
  devLog.info(`开发者模式已${val ? '开启' : '关闭'}（重启后生效）`)
  ElMessage.success(`已${val ? '开启' : '关闭'}启动自动打开开发者工具，重启应用后生效`)
}

async function handleExportDiagnostics() {
  const ok = await exportDiagnostics(feedbackText.value)
  if (ok) {
    ElMessage.success('诊断报告已导出')
    devLog.info('诊断报告已导出')
  }
}

async function handleOpenFeedback() {
  await openFeedback()
}

function handleClearLogs() {
  clearLogs()
}

onMounted(() => {
  unsubLog = onLogUpdate((newLogs) => {
    logs.value = newLogs
  })
  loadStatus()
})

import { ElMessage } from 'element-plus'
</script>

<style lang="scss" scoped>
.dev-panel {
  padding: 0 16px 16px;
}

.dev-section {
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-color);

  &:last-child {
    border-bottom: none;
  }
}

.section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 12px;
}

.env-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.env-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-radius: 2px;
  font-size: 13px;

  .env-label {
    color: var(--text-muted);
  flex-shrink: 0;
  }

  .env-value {
    color: var(--text-primary);
    text-align: right;
    word-break: break-all;
    margin-left: 12px;
  }
}

.env-loading {
  padding: 16px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.action-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 12px;
}

.dev-mode-switch {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--bg-secondary);
  border-radius: 2px;

  .switch-info {
    flex: 1;

    .switch-title {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .switch-desc {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 2px;
    }
  }
}

.feedback-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;

  .el-button {
    flex: 1;
  }
}

.feedback-tip {
  margin-top: 10px;
  padding: 8px 12px;
  background: var(--highlight-bg);
  border-radius: 2px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.log-container {
  background: var(--code-bg);
  border-radius: 2px;
  padding: 8px;
  max-height: 320px;
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
}

.log-entry {
  display: flex;
  gap: 6px;
  padding: 2px 0;
  word-break: break-all;

  .log-time {
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .log-level {
    flex-shrink: 0;
    font-weight: 600;
    width: 44px;
  }

  .log-source {
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .log-message {
    color: var(--text-primary);
  }

  &.log-error .log-level { color: #f56c6c; }
  &.log-error .log-message { color: #f56c6c; }
  &.log-warn .log-level { color: #e6a23c; }
  &.log-info .log-level { color: var(--accent-color); }
  &.log-debug .log-level { color: #909399; }
}

.log-empty {
  color: var(--text-muted);
  text-align: center;
  padding: 24px 0;
  font-family: inherit;
}
</style>