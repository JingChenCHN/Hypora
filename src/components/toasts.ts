/**
 * 轻量 Toast 通知（§10 可观测辅助 / 用户反馈）
 */
import { reactive } from 'vue'

export interface ToastItem {
  id: number
  msg: string
  type: 'info' | 'success' | 'error'
}

export const toasts = reactive<ToastItem[]>([])
let seq = 0

export function toast(msg: string, type: 'info' | 'success' | 'error' = 'info', duration = 3200) {
  const id = ++seq
  toasts.push({ id, msg, type })
  setTimeout(() => dismiss(id), duration)
}

export function dismiss(id: number) {
  const i = toasts.findIndex((t) => t.id === id)
  if (i >= 0) toasts.splice(i, 1)
}

export function toastIcon(type: string) {
  return type === 'success' ? '✅' : type === 'error' ? '⚠️' : 'ℹ️'
}
