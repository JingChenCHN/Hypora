// 通用 OpenAI 兼容流式对话(DeepSeek 云端 / 本地 llama-server / GLM 多模态 共用)
// DeepSeek: base=https://api.deepseek.com  端点 /v1/chat/completions  需 Bearer key
// 本地 llama-server: base=http://127.0.0.1:8899  端点 /v1/chat/completions  无 key、可不传 model
// GLM(智谱): base=https://open.bigmodel.cn/api/paas/v4  端点 /chat/completions  需 Bearer key,支持图文多模态
// 三者均为 SSE 流式: data: {json}, 取 choices[0].delta.content( + reasoning_content 思考链)
//
// 安全模型: 网页版(非 Tauri) 默认经同源代理 /api/ai 转发(需配套 server.cjs), 访客用自己的
// API Key; 桌面版 keep直连云端。代理白名单校验后透传 Authorization, 本身不持有密钥, 避免产生
// 「站点级中心密钥」。

// 多模态消息内容片段(OpenAI/GLM 通用格式)
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  // 纯文本对话为 string;图文多模态(GLM-4V 等)为 ContentPart[]
  content: string | ContentPart[]
}

/** 是否运行在 Tauri 桌面环境(桌面上直连云端即可,无需代理;网页浏览器则走同源代理) */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 本地 llama-server 主机判断(网页上连不上本地 127.0.0.1, 保持直连语义, 桌面端才有意义) */
function isLocalBase(baseUrl: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)/.test(baseUrl)
}

/**
 * 计算实际请求 URL + 目标。
 * - 非 Tauri(网页版) + 非本地  → 走同源代理 /api/ai, 真实上游 URL 放进 X-Hypora-Target 交给 server.cjs 校验转发。
 * - 其余(Tauri 桌面 / 本地模型) → 构造原始云端 URL 直接 fetch。
 * 返回的对象供发起请求使用。target 仅在内容 proxy 模式下非空。
 */
function resolve(baseUrl: string, endpoint: string): {
  url: string; headers: Record<string, string>
} {
  const fullTarget = baseUrl.replace(/\/+$/, '') + endpoint
  const viaProxy = !isTauriEnv() && !isLocalBase(baseUrl)
  if (viaProxy) {
    // 走同源代理: 浏览器把请求发到同源 /api/ai, 真实上游完整 URL 放 X-Hypora-Target,
    // 由 server.cjs 白名单校验后转发(CORS + key 不落服务器)。
    return {
      url: '/api/ai',
      headers: { 'X-Hypora-Target': fullTarget },
    }
  }
  return { url: fullTarget, headers: {} }
}

/**
 * 流式对话。渲染进程直接 fetch 或经同源代理 /api/ai。
 * DeepSeek/GLM 在网页版由 server.cjs 代理(CORS + key 不落服务器);
 * 本地线性版本 127.0.0.1 无 CORS 问题, 桌面版直连。
 */
export async function streamChat(opts: {
  baseUrl: string
  apiKey?: string
  model?: string
  messages: ChatMessage[]
  thinking?: boolean
  temperature?: number
  topP?: number
  maxTokens?: number
  /** 接口路径,默认 /v1/chat/completions;GLM 用 /chat/completions */
  path?: string
  onChunk: (delta: string) => void
  onReasoning?: (delta: string) => void
  signal?: AbortSignal
}): Promise<void> {
  const endpoint = opts.path ?? '/v1/chat/completions'
  const { url, headers: maybeProxy } = resolve(opts.baseUrl, endpoint)
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...maybeProxy }
  if (opts.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`

  const body: any = { messages: opts.messages, stream: true }
  if (opts.model) body.model = opts.model
  if (opts.thinking) body.thinking = { type: 'enabled' }
  if (opts.temperature != null) body.temperature = opts.temperature
  if (opts.topP != null) body.top_p = opts.topP
  if (opts.maxTokens) body.max_tokens = opts.maxTokens

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal
  })

  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`${res.status}: ${txt.slice(0, 300)}`)
  }
  if (!res.body) throw new Error('响应无 body(不支持流式)')

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || '' // 末行可能不完整,留给下次
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') return
      try {
        const json = JSON.parse(data)
        const delta = json.choices?.[0]?.delta
        if (delta?.content) opts.onChunk(delta.content)
        if (delta?.reasoning_content && opts.onReasoning) opts.onReasoning(delta.reasoning_content)
      } catch {
        // 跳过无法解析的行(心跳/分片)
      }
    }
  }
}

/**
 * 测试连接(GET /v1/models)。用于本地引擎探测是否在运行。
 * in proxy 模式同样由同源 /api/ai 转发(GET)。
 */
/**
 * 测试连接(GET /v1/models)。用于本地引擎探测是否在运行。
 * in proxy 模式同样由同源 /api/ai 转发(GET)。
 */
export async function testConnection(
  baseUrl: string,
  apiKey?: string
): Promise<{ ok: boolean; info?: string; error?: string }> {
  try {
    const base = baseUrl.replace(/\/+$/, '')
    const endpoint = '/v1/models'
    const { url, headers: maybeProxy } = resolve(base, endpoint)
    const headers: Record<string, string> = { ...maybeProxy }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    const res = await fetch(url, { headers })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const json = await res.json()
    const list: any[] = json.data || json.models || []
    const info = list.length
      ? list.map((m) => m.id || m.name).filter(Boolean).slice(0, 5).join(', ')
      : '已连接'
    return { ok: true, info }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/**
 * 校验某模型是否可对话(发一条最小 chat 请求)。用于 GLM 等不以 /v1/models 暴露列表的厂商。
 * 经与 streamChat 相同的同源代理链路，能真实验证「key + 模型 + 网络」是否可用。
 */
export async function testChatCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  path = '/chat/completions'
): Promise<{ ok: boolean; info?: string; error?: string }> {
  try {
    const { url, headers: maybeProxy } = resolve(baseUrl, path)
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...maybeProxy }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5, stream: false }),
    })
    if (res.ok) {
      return { ok: true, info: `已连接：${model}` }
    }
    const t = await res.text().catch(() => '')
    return { ok: false, error: `HTTP ${res.status}: ${t.slice(0, 120)}` }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}