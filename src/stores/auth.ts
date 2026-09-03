import { ref } from 'vue'
import { defineStore } from 'pinia'
import { authLogin, authLogout, authMe, type SessionUser } from '@/utils/authApi'
import { isElectron } from '@/utils/devMode'

// 是否需要登录门禁:仅网页版(桌面版本地运行、不依赖服务器,行为与现状一致)。
// 注意:Tauri 下 isElectron() 依赖 setupTauriCompat() 合成的 window.electronAPI,
// 但 isTauriEnv() 同步可用,这里直接双查,setup 前后调用都正确。
function isTauriEnv() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function authNeeded() {
  return !isElectron() && !isTauriEnv()
}

export const useAuthStore = defineStore('auth', () => {
  // 当前登录用户;null = 未登录(网页版此时整站被 LoginGate 挡住)
  const me = ref<SessionUser | null>(null)
  // 会话探测中(LoginGate 显示占位,避免编辑器闪现)
  const ready = ref(false)
  // 供其他模块等待会话确认(如 ai.ts 恢复聊天记录)
  let readyResolve: ((u: SessionUser | null) => void) | null = null
  const readyPromise = new Promise<SessionUser | null>((resolve) => { readyResolve = resolve })

  async function init() {
    if (!authNeeded()) {
      ready.value = true
      readyResolve?.(null)
      return
    }
    try {
      const r = await authMe()
      me.value = r.user
    } catch {
      me.value = null
    } finally {
      ready.value = true
      readyResolve?.(me.value)
    }
  }

  async function login(username: string, password: string) {
    const r = await authLogin(username, password)
    me.value = r.user
    return r.user
  }

  async function logout() {
    try { await authLogout() } catch { /* 会话可能已过期,忽略 */ }
    me.value = null
  }

  // 需登录接口返回 401 时调用:门禁浮现,但不清任何内存数据(用户可能正看着生成中的回复)
  function onUnauthorized() {
    if (authNeeded()) me.value = null
  }

  return { me, ready, readyPromise, init, login, logout, onUnauthorized }
})
