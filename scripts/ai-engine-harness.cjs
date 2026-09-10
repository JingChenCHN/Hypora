#!/usr/bin/env node
/**
 * ai-engine-harness.cjs —— dev-only：在纯 Node 环境（无 Electron）驱动 electron-ai-engine.cjs 全流程。
 * 用真实 llama-server 二进制（ai-engine/linux-x64，scripts/fetch-llamacpp.cjs 产物）。
 * 模型文件须放在 $HOME/.hypora-ai-engine/models/ 且字节数与注册表严格一致（完整性校验），
 * 本机做不了真推理时可用稀疏假文件占位（truncate -s <注册字节数>），只验证择模/spawn/回落状态机。
 * 真模型完整链路（下载 302 → 续传 → 校验 → 推理）见 scripts 下场景脚本；Windows 上做最终验证。
 * 用法：HOME=/tmp/hypora-harness-home node scripts/ai-engine-harness.cjs
 */
process.env.HYPORA_AI_ENGINE_DIR = process.env.HYPORA_AI_ENGINE_DIR || '/home/hemo/Hypora/ai-engine/linux-x64'

const m = require('../electron-ai-engine.cjs')
const engine = m.initAiEngine((level, msg) => console.log(`[engine:${level}] ${msg}`))

console.log('CONFIG:', JSON.stringify(engine.getConfig()))

const watchdog = setTimeout(() => { console.error('WATCHDOG 超时（120s）'); process.exit(2) }, 120_000)

engine.start().then(async (snap) => {
  console.log('STARTED:', JSON.stringify(snap))
  if (snap.phase !== 'running' || !snap.baseUrl) {
    console.error('引擎未进入 running（回落/失败路径已验证），退出')
    process.exit(1)
  }
  // 真实推理冒烟：OpenAI 兼容端点
  const res = await fetch(`${snap.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 8 }),
  })
  const j = await res.json()
  console.log('INFER:', res.status, JSON.stringify(j.choices?.[0]?.message?.content ?? j).slice(0, 150))
  await engine.stop()
  console.log('STOPPED:', JSON.stringify(engine.snapshot()))
  clearTimeout(watchdog)
  setTimeout(() => process.exit(0), 500)
}).catch((err) => {
  console.error('FAILED:', err.message, 'code=', err.code)
  process.exit(1)
})
