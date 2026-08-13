// 通用 OpenAI 兼容流式对话（DeepSeek 云端 / 本地 llama-server / GLM 多模态 共用）
// DeepSeek: base=https://api.deepseek.com  端点 /v1/chat/completions  需 Bearer key
// 本地 llama-server: base=http://127.0.0.1:8899  端点 /v1/chat/completions  无 key、可不传 model
// GLM(智谱): base=https://open.bigmodel.cn/api/paas/v4  端点 /chat/completions  需 Bearer key,支持图文多模态
// 三者均为 SSE 流式：data: {json}，取 choices[0].delta.content（+ reasoning_content 思考链）

// 多模态消息内容片段（OpenAI/GLM 通用格式）
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  // 纯文本对话为 string；图文多模态（GLM-4V 等）为 ContentPart[]
  content: string | ContentPart[]
}

/**
 * 流式对话。渲染进程直接 fetch（本地 127.0.0.1 无 CORS 问题；DeepSeek 若遇 CORS 需改主进程代理）。
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
  /** 接口路径，默认 /v1/chat/completions；GLM 用 /chat/completions */
  path?: string
  onChunk: (delta: string) => void
  onReasoning?: (delta: string) => void
  signal?: AbortSignal
}): Promise<void> {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const endpoint = opts.path ?? '/v1/chat/completions'
  const url = `${base}${endpoint}`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
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
  if (!res.body) throw new Error('响应无 body（不支持流式）')

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || '' // 末行可能不完整，留到下次
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
        // 跳过无法解析的行（心跳/分片）
      }
    }
  }
}

/**
 * 测试连接（GET /v1/models）。用于本地引擎探测是否在运行。
 */
export async function testConnection(
  baseUrl: string,
  apiKey?: string
): Promise<{ ok: boolean; info?: string; error?: string }> {
  try {
    const base = baseUrl.replace(/\/+$/, '')
    const headers: Record<string, string> = {}
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    const res = await fetch(`${base}/v1/models`, { headers })
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
