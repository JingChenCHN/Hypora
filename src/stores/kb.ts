// 知识库 Pinia store：状态镜像（主进程推送驱动）+ 管理操作 + 聊天检索安全边界。
// 聊天安全性第一：retrieveForChat 任何失败（未就绪/超时/出错）一律静默降级为无注入，
// 绝不阻塞或报错打断对话；故障后 60s 冷却，期间零 IPC 零 spawn。
// setup 体无副作用：bind() 由 App.vue 显式调用（aiStore.init 之后），保证
// useKbStore() 在 AI 面板从未挂载时也能被 ai.ts 懒初始化。
// v2 多库：模型全局共用；kbs[] 各自开关/参数；managerOpen 驱动知识库管理抽屉。

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import {
  hasKnowledge, kbApi,
  type KbStatus, type KbConfigPayload, type KbProgress, type KbHit, type KbQueryResult, type KbItemPatch,
} from '@/utils/knowledge'

// 检索预算：服务冷启动 + 嵌入 + 检索的上限（嵌入服务 45s 自身超时在此之上）
const RETRIEVE_BUDGET_MS = 6000
// 检索失败后的冷却：期间直接跳过检索，不让故障知识库拖慢每一条消息
const RETRIEVAL_COOLDOWN_MS = 60_000
// 注入块单段上限（与主进程 PER_HIT_CHARS 一致的默认）
const PER_HIT_CHARS = 1200

const EMPTY_RETRIEVAL = { block: '', hits: 0, sources: [] as string[] }

export const useKbStore = defineStore('kb', () => {
  const status = ref<KbStatus | null>(null)
  const payload = ref<KbConfigPayload | null>(null)
  const progress = ref<KbProgress | null>(null)
  // 知识库管理抽屉（大栏目）：跨组件开关——AIPanel「管理」、Toolbar 菜单、原生菜单都能打开
  const managerOpen = ref(false)
  let bound = false
  let retrievalBlockedUntil = 0

  const autoInject = computed(() => payload.value?.autoInject ?? false)
  const modelOk = computed(() => payload.value?.model.ok ?? false)
  const chunkTotal = computed(() => payload.value?.totals.chunks ?? 0)
  // 参与检索的库（启用且已有索引内容）
  const activeKbs = computed(() => (payload.value?.kbs || []).filter((k) => k.enabled && k.stats.chunks > 0))

  // 检索就绪 = 桌面端 + 模型有效 + 总开关开启 + 至少一个启用库有索引。空集合时主进程查询零开销短路。
  const ready = computed(() => hasKnowledge() && modelOk.value && autoInject.value && activeKbs.value.length > 0)

  const indexing = computed(() => payload.value?.indexing || progress.value?.phase === 'scanning' || progress.value?.phase === 'embedding')
  const dot = computed<'ok' | 'err' | 'off'>(() => {
    if (!hasKnowledge()) return 'off'
    if (ready.value) return 'ok'
    if (status.value?.phase === 'failed') return 'err'
    return 'off'
  })
  // 聚合状态行（kb-strip 一行说清全局）：优先级 索引中 > 模型 > 总开关 > 库内容
  const statusText = computed(() => {
    const p = payload.value
    if (!hasKnowledge()) return ''
    if (indexing.value && progress.value) {
      const { done, total } = progress.value
      return `索引中 ${done}/${total || '?'}`
    }
    if (!p) return '检测中…'
    if (!p.model.ok) return p.model.error || '未配置检索模型'
    if (!p.autoInject) return '自动引用已关闭'
    if (!activeKbs.value.length) return p.staleTotal ? '待索引' : '尚无索引'
    const n = activeKbs.value.length
    return `就绪 · ${p.totals.chunks.toLocaleString()} 片 · ${n} 库`
  })

  function applyStatus(s: KbStatus | null) {
    if (s) status.value = s
  }

  async function refresh() {
    payload.value = await kbApi.config()
  }

  // 绑定主进程推送并首次对账（幂等；Ctrl+R 重载后由 App 重新调用）
  function bind() {
    if (!hasKnowledge() || bound) return
    bound = true
    kbApi.onStatus(applyStatus)
    kbApi.onProgress((p) => {
      progress.value = p
      // 一轮索引结束（无论成败）刷新统计：来源卡 / 总量即时翻转
      if (p.phase === 'done' || p.phase === 'error' || p.phase === 'cancelled') void refresh()
    })
    void refresh()
  }

  function applyResult(r: { ok: boolean; error?: string; config?: KbConfigPayload } | null, fallback = '操作失败') {
    if (r && !r.ok) {
      ElMessage.warning(r.error || fallback)
      return false
    }
    if (r?.config) payload.value = r.config
    else void refresh()
    return true
  }

  async function setAutoInject(v: boolean) {
    if (payload.value) payload.value.autoInject = v   // 乐观更新，开关不闪
    const next = await kbApi.setConfig({ autoInject: v })
    if (next) payload.value = next
  }

  async function pickAndSetModel() {
    const picked = await kbApi.pickModel()
    if (!picked || picked.canceled) return
    if (picked.error) {
      ElMessage.warning(picked.error)
      return
    }
    applyResult(await kbApi.setModel(picked.path!), '模型设置失败')
  }

  // 视觉投影器（可选）：选择 → 设置；null = 清除。失败不改本地状态。
  async function pickAndSetMmproj() {
    const picked = await kbApi.pickMmproj()
    if (!picked || picked.canceled) return
    if (picked.error) {
      ElMessage.warning(picked.error)
      return
    }
    applyResult(await kbApi.setMmproj(picked.path!), '视觉投影器设置失败')
  }

  async function clearMmproj() {
    applyResult(await kbApi.setMmproj(null), '清除失败')
  }

  // ============ 知识库 CRUD ============
  async function createKb(name?: string) {
    const r = await kbApi.create(name)
    if (applyResult(r, '创建失败')) void refresh()
  }

  async function renameKb(kbId: string, name: string) {
    applyResult(await kbApi.rename(kbId, name), '重命名失败')
  }

  async function deleteKb(kbId: string) {
    applyResult(await kbApi.remove(kbId), '删除失败')
  }

  async function setKb(kbId: string, patch: KbItemPatch) {
    // enabled 乐观更新：开关即时翻转，主进程确认后以快照为准
    if (patch.enabled !== undefined && payload.value) {
      const item = payload.value.kbs.find((k) => k.id === kbId)
      if (item) item.enabled = patch.enabled
    }
    const r = await kbApi.setKb(kbId, patch)
    if (r && !r.ok) {
      ElMessage.warning(r.error || '设置失败')
    }
    if (r?.config) payload.value = r.config
    else void refresh()
  }

  // ============ 来源与索引 ============
  async function addSource(kbId: string) {
    const r = await kbApi.addSource(kbId)
    if (!r || r.canceled) return
    if (r.error) {
      ElMessage.warning(r.error)
      return
    }
    if (r.config) payload.value = r.config
    else void refresh()
    // 新来源尚无索引：只对该库增量建一遍（其他库分片指纹未变，秒过）
    void kbApi.reindex({ kbId })
  }

  async function removeSource(kbId: string, dir: string) {
    applyResult(await kbApi.removeSource(kbId, dir), '移除失败')
  }

  async function reindex(opts?: { kbId?: string; force?: boolean }) {
    const r = await kbApi.reindex(opts)
    if (r && !r.started) ElMessage.warning(r.error || '索引未启动：请先配置有效的检索模型')
  }

  async function cancelIndex() {
    await kbApi.cancelIndex()
  }

  async function openIndexDir(kbId?: string) {
    const r = await kbApi.openIndexDir(kbId)
    if (r && r.error) ElMessage.warning(r.error)
  }

  // ============ 聊天检索安全边界 ============
  // 返回注入块与统计；任何失败静默返回空（聊天照常，只是没有知识库上下文）。
  // signal：随对话生成的 AbortController 联动，用户点「停止」时立刻让路（不进冷却）。
  async function retrieveForChat(prompt: string, selection?: string, signal?: AbortSignal): Promise<{ block: string; hits: number; sources: string[] }> {
    if (!ready.value || Date.now() < retrievalBlockedUntil) return EMPTY_RETRIEVAL
    const q = [prompt, (selection || '').slice(0, 600)].filter((s) => s && s.trim()).join('\n').slice(0, 1200)
    if (!q.trim()) return EMPTY_RETRIEVAL
    try {
      // 6s 预算竞速：超时不取消底层查询（后台继续，暖服务让下一条受益），仅本次降级
      const timeoutP = new Promise<null>((resolve) => setTimeout(() => resolve(null), RETRIEVE_BUDGET_MS))
      const abortP = signal
        ? new Promise<null>((resolve) => {
            if (signal.aborted) { resolve(null); return }
            signal.addEventListener('abort', () => resolve(null), { once: true })
          })
        : null
      const race = [kbApi.query(q), timeoutP] as Promise<KbQueryResult | null>[]
      if (abortP) race.push(abortP)
      const r = await Promise.race(race)
      if (!r) {
        // 超时 → 冷却；用户主动中止 → 不冷却（非知识库故障）
        if (!signal?.aborted) retrievalBlockedUntil = Date.now() + RETRIEVAL_COOLDOWN_MS
        return EMPTY_RETRIEVAL
      }
      const hits = r.hits || []
      if (!hits.length) return EMPTY_RETRIEVAL   // 正常空结果（无相关内容），不进冷却
      return { block: buildBlock(hits), hits: hits.length, sources: [...new Set(hits.map((h) => h.title))].slice(0, 3) }
    } catch {
      // 服务不可用/查询出错：冷却 60s，静默降级
      retrievalBlockedUntil = Date.now() + RETRIEVAL_COOLDOWN_MS
      return EMPTY_RETRIEVAL
    }
  }

  // 检索结果 → 注入块（合并进 system 消息；明确「优先依据 + 无关忽略」补偿与问题的距离）
  function buildBlock(hits: KbHit[]): string {
    const budget = payload.value?.injectCharBudget || 6000
    const lines = ['--- 知识库检索（参考资料：回答时优先依据以下内容；与问题无关请忽略，不要虚构资料外的事实）---']
    let used = 0
    hits.forEach((h, i) => {
      // 图片命中：无正文，只标注文件名与路径（与主进程 formatKbBlock 同款）
      if (h.kind === 'image') {
        const head = `[${i + 1}] [图片] 《${h.title || '图片'}》（${h.path}）`
        const cost = head.length + 2
        if (used + cost > budget) return
        used += cost
        lines.push(head)
        return
      }
      const head = `[${i + 1}] 《${h.title || '文档'}》${h.heading ? ' · ' + h.heading : ''}`
      const body = (h.text || '').slice(0, PER_HIT_CHARS)
      const cost = head.length + body.length + 2
      if (used + cost > budget) return
      used += cost
      lines.push(head, body)
    })
    return lines.length > 1 ? lines.join('\n') : ''
  }

  return {
    status, payload, progress, managerOpen,
    autoInject, modelOk, chunkTotal, activeKbs, ready, indexing, dot, statusText,
    bind, refresh, setAutoInject, pickAndSetModel, pickAndSetMmproj, clearMmproj,
    createKb, renameKb, deleteKb, setKb,
    addSource, removeSource, reindex, cancelIndex, openIndexDir,
    retrieveForChat,
  }
})
