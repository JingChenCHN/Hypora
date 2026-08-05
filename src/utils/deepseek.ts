/**
 * AI Provider 预设（§4 D3：OpenAI 兼容协议统一契约）
 * 云 / 本地 / 未来 provider 全部以 /v1/chat/completions SSE 为契约接入。
 * reasoning_content（思考链）纳入契约。
 */
export interface ProviderPreset {
  id: string
  label: string
  kind: 'cloud' | 'local'
  baseUrl: string
  defaultModel: string
  models: string[]
  needsKey: boolean
  /** 是否原生支持思考链字段 */
  supportsReasoning: boolean
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'cloud',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    needsKey: true,
    supportsReasoning: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'cloud',
    baseUrl: 'https://api.openai.com',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'],
    needsKey: true,
    supportsReasoning: false,
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    kind: 'cloud',
    baseUrl: 'https://open.bigmodel.cn/api/paas',
    defaultModel: 'glm-4-flash',
    models: ['glm-4-flash', 'glm-4-plus', 'glm-4-long'],
    needsKey: true,
    supportsReasoning: false,
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    kind: 'cloud',
    baseUrl: '',
    defaultModel: '',
    models: [],
    needsKey: true,
    supportsReasoning: true,
  },
  {
    id: 'local',
    label: '本地引擎（llama.cpp sidecar）',
    kind: 'local',
    baseUrl: 'http://127.0.0.1:8080',
    defaultModel: 'llama-3.2-1b-instruct',
    models: ['llama-3.2-1b-instruct', 'llama-3.1-8b-instruct', 'qwen2.5-1.5b-instruct'],
    needsKey: false,
    supportsReasoning: false,
  },
]

export function providerById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id)
}

/** 组装 OpenAI 兼容请求体（渲染层组装，经适配层下发） */
export function buildChatBody(provider: ProviderPreset, model: string, messages: ChatMessageLike[], opts?: { temperature?: number; maxTokens?: number }) {
  return {
    model: model || provider.defaultModel,
    messages,
    stream: true,
    temperature: opts?.temperature ?? 0.7,
    max_tokens: opts?.maxTokens,
  }
}

export interface ChatMessageLike {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** AI 写作助手默认 system 提示词（资产 ai-assistant.json 的数据源） */
export const AI_ASSISTANT_SYSTEM = `你是 Hypora 内嵌的 AI 写作助手，一名专业的中文 Markdown 写作协作者。
你的回答应：
1. 直接产出 Markdown 内容（标题、列表、代码块、加粗等），方便用户直接插入文档；
2. 结构清晰、语言精炼，优先使用短段落与列表；
3. 不确定的信息明确说明，不编造；
4. 如需代码，给出完整可运行的代码块并标注语言。`
