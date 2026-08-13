// AI 回复气泡排版冒烟测试：首尾 margin 穿透消除、内边距/圆角规范
// 用法：先 npx vite preview --port 4173，再 node scripts/verify-bubble-layout.cjs
const puppeteer = require('puppeteer-core')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL = process.env.SMOKE_URL || 'http://localhost:4173'
const wait = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1280,800'] })
  const p = await b.newPage()
  await p.goto(URL, { waitUntil: 'networkidle2' })
  await p.keyboard.down('Control'); await p.keyboard.press('j'); await p.keyboard.up('Control')
  await p.waitForSelector('.ai-panel'); await wait(400)
  if (await p.evaluate(() => document.querySelector('.ai-panel').classList.contains('is-collapsed'))) {
    await p.keyboard.down('Control'); await p.keyboard.press('j'); await p.keyboard.up('Control'); await wait(400)
  }

  // 注入一条多段落 + 标题 + 列表的 AI 回复（绕过真实 API）
  await p.evaluate(() => {
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('ai')
    store.messages.push({
      role: 'assistant',
      content: '# 标题\n\n第一段正文。\n\n第二段正文。\n\n- 列表项 A\n- 列表项 B\n\n末尾段落。'
    })
  })
  await wait(300)

  const m = await p.evaluate(() => {
    const bubble = document.querySelector('.ai-msg.assistant .msg-bubble')
    const md = bubble.querySelector('.markdown-body')
    const content = md.querySelector('.ai-md-content')
    const first = content.firstElementChild
    const last = content.lastElementChild
    const cs = getComputedStyle(bubble)
    const bubbleRect = bubble.getBoundingClientRect()
    const mdRect = md.getBoundingClientRect()
    const firstRect = first.getBoundingClientRect()
    const lastRect = last.getBoundingClientRect()
    // 顶间隙相对气泡顶（= padding）；底间隙相对 .markdown-body 底，排除 .msg-actions 区
    return {
      borderRadius: cs.borderRadius,
      padding: cs.padding,
      firstTopGap: Math.round(firstRect.top - bubbleRect.top),
      lastBottomGap: Math.round(mdRect.bottom - lastRect.bottom),
      pMarginTop: getComputedStyle(first).marginTop,
      pMarginBottom: getComputedStyle(last).marginBottom
    }
  })
  console.log('[T1] 气泡:', { borderRadius: m.borderRadius, padding: m.padding })
  console.log(`[T2] 首元素顶部间隙: ${m.firstTopGap}px（≈ padding，应≤14，不应有 margin 叠加）${m.firstTopGap <= 16 ? ' ✓' : ' ✗'}`)
  console.log(`[T3] 末元素底部间隙: ${m.lastBottomGap}px（≈ padding，应≤14）${m.lastBottomGap <= 16 ? ' ✓' : ' ✗'}`)
  console.log(`[T4] 首元素 marginTop: ${m.pMarginTop}（应为 0，否则穿透）${m.pMarginTop === '0px' ? ' ✓' : ' ✗'}`)
  console.log(`[T5] 末元素 marginBottom: ${m.pMarginBottom}（应为 0）${m.pMarginBottom === '0px' ? ' ✓' : ' ✗'}`)

  const ok = m.firstTopGap <= 16 && m.lastBottomGap <= 16 && m.pMarginTop === '0px' && m.pMarginBottom === '0px'
  console.log(ok ? '\n=== BUBBLE LAYOUT PASS ===' : '\n=== BUBBLE LAYOUT FAIL ===')
  await b.close()
  process.exit(ok ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
