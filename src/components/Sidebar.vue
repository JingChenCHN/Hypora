<template>
  <div class="sidebar" :class="{ 'sidebar-hidden': !docStore.sidebarVisible }">
    <div class="sidebar-header">
      <el-tabs v-model="activeTab" class="sidebar-tabs">
        <el-tab-pane label="大纲" name="outline" />
        <el-tab-pane label="文档" name="documents" />
      </el-tabs>
    </div>

    <div class="sidebar-content">
      <!-- 大纲目录 -->
      <div v-show="activeTab === 'outline'" class="outline-panel">
        <div v-if="outline.length === 0" class="empty-state">
          <el-empty description="暂无大纲，使用#创建标题" :image-size="80" />
        </div>
        <template v-else>
          <div class="outline-toolbar">
            <el-tooltip content="全部展开" placement="top">
              <button class="otl-btn" @click="expandAll"><el-icon><Expand /></el-icon></button>
            </el-tooltip>
            <el-tooltip content="全部折叠" placement="top">
              <button class="otl-btn" @click="collapseAll"><el-icon><Fold /></el-icon></button>
            </el-tooltip>
          </div>
          <ul class="outline-list">
            <li
              v-for="(item, index) in visibleOutline"
              :key="item.id + index"
              :style="{ paddingLeft: `${(item.level - 1) * 12 + 12}px` }"
              :class="{ 'active': activeHeading === item.id }"
              @click="scrollToHeading(item.id)"
            >
              <span
                v-if="item.hasChildren"
                class="outline-caret"
                :class="{ open: !collapsedIds.has(item.id) }"
                @click.stop="toggleCollapse(item.id)"
              >▸</span>
              <span v-else class="outline-caret placeholder">▸</span>
              <span class="outline-text">{{ item.text }}</span>
            </li>
          </ul>
        </template>
      </div>

      <!-- 文档列表 -->
      <div v-show="activeTab === 'documents'" class="documents-panel">
        <div class="doc-actions">
          <el-button type="primary" size="small" @click="docStore.newDocument()" class="new-doc-btn">
            <el-icon><Plus /></el-icon> 新建文档
          </el-button>
        </div>
        <div class="doc-list">
          <div
            v-for="doc in docStore.documents"
            :key="doc.id"
            class="doc-item"
            :class="{ 'active': doc.id === docStore.activeDocId, 'unsaved': !doc.isSaved }"
            @click="docStore.switchDocument(doc.id)"
          >
            <div class="doc-info" @dblclick="startRename(doc)">
              <el-icon class="doc-icon"><Document /></el-icon>
              <div class="doc-meta">
                <div class="doc-title">
                  <el-icon v-if="!doc.isSaved" class="unsaved-dot"><WarningFilled /></el-icon>
                  {{ doc.title }}
                  <span
                    v-if="docStore.unpersistedIds.has(doc.id)"
                    class="no-cache-badge"
                    title="浏览器缓存空间不足，此文档未写入离线缓存（仅本页内存）"
                  >未缓存</span>
                </div>
                <div class="doc-time">{{ formatTime(doc.updateTime) }}</div>
              </div>
            </div>
            <el-dropdown trigger="click" @command="(cmd) => handleDocCommand(cmd, doc.id)" @click.stop>
              <el-button text size="small" class="doc-more">
                <el-icon><MoreFilled /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="rename"><el-icon><Edit /></el-icon> 重命名</el-dropdown-item>
                  <el-dropdown-item command="delete" divided><el-icon><Delete /></el-icon> 删除</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useDocumentStore } from '@/stores/document'
import type { OutlineItem } from '@/utils/markdown'
import { Plus, Document, MoreFilled, Edit, Delete, WarningFilled, Expand, Fold } from '@element-plus/icons-vue'
import { ElMessageBox, ElMessage } from 'element-plus'

const props = defineProps<{
  outline: OutlineItem[]
  activeHeading: string
}>()

const docStore = useDocumentStore()
const activeTab = ref('outline')

// ===== 大纲层级折叠 =====
// collapsedIds 收集被折叠标题的 id；可见列表 = 跳过所有折叠标题的更深层级后代
interface VisibleOutlineItem extends OutlineItem { hasChildren: boolean }
const collapsedIds = ref(new Set<string>())

const visibleOutline = computed<VisibleOutlineItem[]>(() => {
  const list = props.outline
  const out: VisibleOutlineItem[] = []
  let skipAbove: number | null = null // 折叠点层级：比它深的标题都被藏住
  for (let i = 0; i < list.length; i++) {
    const it = list[i]
    if (skipAbove !== null && it.level > skipAbove) continue
    skipAbove = null
    const hasChildren = i + 1 < list.length && list[i + 1].level > it.level
    out.push({ ...it, hasChildren })
    if (hasChildren && collapsedIds.value.has(it.id)) skipAbove = it.level
  }
  return out
})

function toggleCollapse(id: string) {
  const next = new Set(collapsedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsedIds.value = next
}

function expandAll() {
  collapsedIds.value = new Set()
}

function collapseAll() {
  const next = new Set<string>()
  const list = props.outline
  for (let i = 0; i < list.length; i++) {
    if (i + 1 < list.length && list[i + 1].level > list[i].level) next.add(list[i].id)
  }
  collapsedIds.value = next
}

// 切换文档时重置折叠状态（标题 id 属于当前文档）
watch(() => docStore.activeDocId, () => {
  collapsedIds.value = new Set()
})

// 滚动高亮进入被折叠的子树时，自动展开其祖先链（只展开、不收起）
watch(() => props.activeHeading, (id) => {
  if (!id || collapsedIds.value.size === 0) return
  const list = props.outline
  const idx = list.findIndex((h) => h.id === id)
  if (idx <= 0) return
  const ancestors: string[] = []
  let level = list[idx].level
  for (let i = idx - 1; i >= 0; i--) {
    if (list[i].level < level) {
      ancestors.push(list[i].id)
      level = list[i].level
      if (level === 1) break
    }
  }
  const hidden = ancestors.filter((a) => collapsedIds.value.has(a))
  if (hidden.length) {
    const next = new Set(collapsedIds.value)
    hidden.forEach((a) => next.delete(a))
    collapsedIds.value = next
  }
})

// 滚动到指定标题
function scrollToHeading(id: string) {
  const el = document.getElementById(id)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

// 格式化时间
function formatTime(timestamp: number) {
  const date = new Date(timestamp)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()

  if (isToday) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

// 开始重命名
function startRename(doc: { id: string, title: string }) {
  ElMessageBox.prompt('请输入新的文档名称', '重命名文档', {
    confirmButtonText: '确定',
    cancelButtonText: '取消',
    inputValue: doc.title,
    inputValidator: (value) => {
      if (!value || !value.trim()) {
        return '文档名称不能为空'
      }
      return true
    }
  }).then(({ value }) => {
    docStore.renameDocument(doc.id, value.trim())
    ElMessage.success('重命名成功')
  }).catch(() => {})
}

// 处理文档操作
function handleDocCommand(command: string, id: string) {
  if (command === 'rename') {
    const doc = docStore.documents.find(d => d.id === id)
    if (doc) startRename(doc)
  } else if (command === 'delete') {
    ElMessageBox.confirm('确定要删除该文档吗？删除后无法恢复。', '删除文档', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    }).then(() => {
      docStore.deleteDocument(id)
      ElMessage.success('删除成功')
    }).catch(() => {})
  }
}
</script>

<style lang="scss" scoped>
.sidebar {
  width: 260px;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  transition: width 0.3s ease, transform 0.3s ease;
  overflow: hidden;

  &.sidebar-hidden {
    width: 0;
    border-right: none;
  }

  .sidebar-header {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-color);

    :deep(.el-tabs__nav-wrap::after) {
      background-color: var(--border-color);
    }

    :deep(.el-tabs__item) {
      color: var(--text-secondary);
      font-size: 14px;
      padding: 0 12px;
      height: 32px;
      line-height: 32px;

      &.is-active {
        color: var(--accent-color);
      }
    }

    :deep(.el-tabs__active-bar) {
      background-color: var(--accent-color);
    }
  }

  .sidebar-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .outline-panel {
    .outline-toolbar {
      display: flex;
      justify-content: flex-end;
      gap: 2px;
      padding: 6px 12px 0;

      .otl-btn {
        display: flex;
        align-items: center;
        padding: 3px 5px;
        border: none;
        background: none;
        color: var(--text-muted);
        font-size: 14px;
        cursor: pointer;
        border-radius: 2px;
        transition: all 0.2s;

        &:hover {
          color: var(--accent-color);
          background: var(--bg-tertiary);
        }
      }
    }

    .outline-list {
      padding: 8px 0;

      li {
        display: flex;
        align-items: center;
        padding-top: 6px;
        padding-right: 12px;
        padding-bottom: 6px;
        cursor: pointer;
        font-size: 14px;
        color: var(--text-secondary);
        border-left: 2px solid transparent;
        transition: all 0.2s;

        &:hover {
          background: var(--bg-tertiary);
          color: var(--text-primary);
        }

        &.active {
          background: var(--bg-tertiary);
          color: var(--accent-color);
          border-left-color: var(--accent-color);
        }

        .outline-caret {
          flex-shrink: 0;
          width: 15px;
          height: 15px;
          margin-right: 4px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 10px;
          line-height: 1;
          color: var(--text-muted);
          border-radius: 2px;
          transition: transform 0.2s ease;
          user-select: none;

          &:not(.placeholder) {
            cursor: pointer;

            &:hover {
              color: var(--text-primary);
              background: var(--bg-secondary);
            }
          }

          &.open { transform: rotate(90deg); }
          &.placeholder { visibility: hidden; }
        }

        .outline-text {
          flex: 1;
          min-width: 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      }
    }
  }

  .documents-panel {
    padding: 12px;

    .doc-actions {
      margin-bottom: 12px;

      .new-doc-btn {
        width: 100%;
      }
    }

    .doc-list {
      .doc-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 10px;
        border-radius: 2px;
        cursor: pointer;
        margin-bottom: 4px;
        transition: background 0.2s;

        &:hover {
          background: var(--bg-tertiary);

          .doc-more {
            opacity: 1;
          }
        }

        &.active {
          background: var(--bg-tertiary);
          color: var(--accent-color);

          .doc-title {
            color: var(--accent-color);
          }
        }

        &.unsaved {
          .unsaved-dot {
            font-size: 8px;
            color: var(--el-color-warning);
            margin-right: 4px;
          }
        }

        .doc-info {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 1;
          min-width: 0;

          .doc-icon {
            font-size: 18px;
            color: var(--text-muted);
            flex-shrink: 0;
          }

          .doc-meta {
            flex: 1;
            min-width: 0;

            .doc-title {
              font-size: 14px;
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
              color: var(--text-primary);
              display: flex;
              align-items: center;

              .no-cache-badge {
                flex-shrink: 0;
                margin-left: 6px;
                font-size: 11px;
                color: var(--el-color-warning);
                border: 1px solid color-mix(in srgb, var(--el-color-warning) 40%, transparent);
                border-radius: 2px;
                padding: 0 5px;
                line-height: 16px;
              }
            }

            .doc-time {
              font-size: 12px;
              color: var(--text-muted);
              margin-top: 2px;
            }
          }
        }

        .doc-more {
          opacity: 0;
          transition: opacity 0.2s;
          padding: 4px;
          color: var(--text-muted);
        }
      }
    }
  }

  .empty-state {
    padding: 40px 0;
  }
}
</style>