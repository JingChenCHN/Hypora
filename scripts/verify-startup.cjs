// 启动优化冒烟测试：遮罩移除、AIPanel 懒加载、katex/mermaid 渲染、置顶降级提示
// 用法：先启动 npx vite preview --port 4173，再 node scripts/verify-startup.cjs
const puppeteer = require('puppeteer-core')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL = process.env.SMOKE_URL || 'http://localhost:4173'
const wait = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1280,800'] })
  const p = await b.newPage()
  const errors = []
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  p.on('pageerror', e => errors.push('PAGEERROR: ' + e.message))
  const failedReqs = []
  p.on('requestfailed', r => failedReqs.push(r.url()))

  const t0 = Date.now()
  await p.goto(URL, { waitUntil: 'networkidle2' })
  await p.waitForSelector('.markdown-body')
  const tMounted = Date.now() - t0

  // T1: 加载遮罩应在 mount 后很快移除（不再等 load+500ms）
  await wait(400)
  const overlay = await p.evaluate(() => {
    const el = document.getElementById('app-loading')
    return el ? getComputedStyle(el).opacity : null
  })
  console.log(`[T1] 遮罩状态(mount后400ms): ${overlay === null ? '已移除 ✓' : `仍存在(opacity=${overlay}) ✗`} | 首屏耗时 ${tMounted}ms`)

  // T2: 首屏不应加载 jspdf / html2canvas / AIPanel chunk
  const eager = await p.evaluate(() => performance.getEntriesByType('resource').map(r => r.name))
  const bad = eager.filter(u => /jspdf|html2canvas|AIPanel/i.test(u))
  console.log(`[T2] 首屏误加载懒加载块: ${bad.length === 0 ? '无 ✓' : bad.join(', ') + ' ✗'}`)

  // T3: katex 与 mermaid 渲染
  await p.evaluate(() => {
    const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('document')
    s.updateContent('# 启动冒烟\n\n行内公式 $E=mc^2$ 结束\n\n```mermaid\ngraph TD\n  A-->B\n```\n')
  })
  await wait(2000)
  const rendered = await p.evaluate(() => ({
    katex: !!document.querySelector('.markdown-body .katex'),
    mermaid: !!document.querySelector('.markdown-body .mermaid svg')
  }))
  console.log(`[T3] katex 渲染: ${rendered.katex ? '✓' : '✗'} | mermaid 渲染: ${rendered.mermaid ? '✓' : '✗'}`)

  // T4: AI 面板（Ctrl+J 打开 → 异步 chunk 加载 → 面板出现）
  await p.keyboard.down('Control'); await p.keyboard.press('j'); await p.keyboard.up('Control')
  await p.waitForSelector('.ai-panel', { timeout: 8000 }).catch(() => {})
  const ai = await p.evaluate(() => {
    const el = document.querySelector('.ai-panel')
    return { exists: !!el, collapsed: el ? el.classList.contains('is-collapsed') : null }
  })
  console.log(`[T4] AI 面板: ${ai.exists ? `已加载 ✓ (collapsed=${ai.collapsed})` : '未出现 ✗'}`)
  await p.keyboard.down('Control'); await p.keyboard.press('j'); await p.keyboard.up('Control')
  await wait(200)

  // T5: 置顶按钮在 Web 环境的降级提示
  const pinBtn = await p.evaluateHandle(() => [...document.querySelectorAll('.toolbar-right .toolbar-btn')].find(b => b.querySelector('.pin-icon')))
  if (pinBtn) {
    await pinBtn.click()
    await wait(600)
    const toast = await p.evaluate(() => {
      const el = document.querySelector('.el-message')
      return el ? el.textContent : null
    })
    console.log(`[T5] 置顶降级提示: ${toast && toast.includes('桌面客户端') ? '✓ ' + toast : `✗ ${toast || '无提示'}`}`)
  } else {
    console.log('[T5] 未找到置顶按钮 ✗')
  }

  console.log(`\n控制台错误: ${errors.length ? errors.join(' | ') : '无'}`)
  console.log(`失败请求: ${failedReqs.length ? failedReqs.join(' | ') : '无'}`)
  await b.close()
  const ok = overlay === null && bad.length === 0 && rendered.katex && rendered.mermaid && ai.exists
  console.log(ok ? '\n=== SMOKE PASS ===' : '\n=== SMOKE FAIL ===')
  process.exit(ok ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
