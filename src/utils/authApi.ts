// 认证 / 用户管理 / 聊天记录接口薄封装
// 全部走同源 /api/*(nginx → server.cjs),fetch 默认 same-origin 自动携带 Cookie。
// 约定:任何需登录接口收到 401 时由调用方把 authStore.me 置空,门禁自动浮现。

export interface SessionUser {
  username: string
  role: 'admin' | 'user'
}

export interface AdminUserInfo extends SessionUser {
  note: string
  createdAt: number
  chatBytes: number
  chatUpdatedAt: number
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  let data: any = null
  try { data = await res.json() } catch { /* 非 JSON 响应(如代理异常页) */ }
  if (!res.ok) {
    const msg = (data && data.error) || `请求失败 (${res.status})`
    throw new ApiError(res.status, msg)
  }
  return data as T
}

function postJson<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ---- auth ----
export function authLogin(username: string, password: string) {
  return postJson<{ ok: true; user: SessionUser }>('/api/auth/login', { username, password })
}

export function authMe() {
  return request<{ ok: true; user: SessionUser | null }>('/api/auth/me')
}

export function authLogout() {
  return postJson<{ ok: true }>('/api/auth/logout', {})
}

export function authChangePassword(oldPassword: string, newPassword: string) {
  return postJson<{ ok: true }>('/api/auth/password', { oldPassword, newPassword })
}

// ---- admin ----
export function adminListUsers() {
  return request<{ ok: true; users: AdminUserInfo[] }>('/api/admin/users')
}

export function adminCreateUser(username: string, note: string, password?: string) {
  return postJson<{ ok: true; username: string; password: string }>('/api/admin/users', { username, note, password })
}

export function adminResetPassword(username: string, password?: string) {
  return postJson<{ ok: true; username: string; password: string }>('/api/admin/users/reset', { username, password })
}

export function adminDeleteUser(username: string) {
  return request<{ ok: true }>(`/api/admin/users?name=${encodeURIComponent(username)}`, { method: 'DELETE' })
}

// ---- chats ----
export interface ChatPayload {
  messages: unknown[]
  reasonings: unknown[]
}

export function chatGet() {
  return request<{ ok: true; messages: unknown[]; reasonings: unknown[]; rev: number; updatedAt: number }>('/api/chats')
}

export function chatPut(payload: ChatPayload) {
  return postJson<{ ok: true; rev: number; bytes: number }>('/api/chats', payload)
}

export function chatDelete() {
  return request<{ ok: true }>('/api/chats', { method: 'DELETE' })
}
