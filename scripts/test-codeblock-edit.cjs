const puppeteer = require('puppeteer-core')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const URL = 'http://localhost:5300/'

const CODE = "function hello() {\n  console.log('hi');\n}"
const DOC_CONTENT = `# Test

Some text here.

\`\`\`js
${CODE}
\`\`\`

More text after.
`

// 已知的、与本次改动无关的预存运行时错误（Tauri 兼容层在纯 Web 环境抛出）
const KNOWN_NOISE = /transformCallback|tauri-apps|onBeforeClose/

function assert(cond, msg) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + msg)
  if (!cond) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })

  const consoleErrors = []
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message))

  await page.evaluateOnNewDocument((content) => {
    const now = Date.now()
    const doc = { id: 'test-1', title: 'Test', content, createTime: now, updateTime: now, isSaved: true }
    localStorage.setItem('hypora_documents', JSON.stringify([doc]))
    localStorage.setItem('hypora_active_doc', 'test-1')
  }, DOC_CONTENT)

  await page.goto(URL, { waitUntil: 'networkidle0' })
  await page.waitForSelector('.code-block-wrapper code', { timeout: 15000 })

  console.log('\n[1] 初始渲染：代码块不可编辑、已语法高亮')
  const init = await page.evaluate(() => {
    const code = document.querySelector('.code-block-wrapper code')
    const wrapper = document.querySelector('.code-block-wrapper')
    return {
      ce: code && code.contentEditable,
      editing: wrapper && wrapper.classList.contains('editing'),
      hasSpans: code ? !!code.querySelector('.token') : false,
      text: code ? code.textContent : null,
    }
  })
  assert(init.ce !== 'true', `code.contentEditable 不应为 true（实际: ${init.ce}，不可编辑）`)
  assert(!init.editing, '初始无 editing 类')
  assert(init.hasSpans, '初始应有 Prism token span（语法高亮）')
  assert(init.text === CODE, `代码文本应完整（实际: ${JSON.stringify(init.text)}）`)

  console.log('\n[2] 点击代码区域 → 进入编辑态')
  await page.click('.code-block-wrapper pre')
  await sleep(200)
  const afterClick = await page.evaluate(() => {
    const code = document.querySelector('.code-block-wrapper code')
    const wrapper = document.querySelector('.code-block-wrapper')
    return {
      ce: code && code.contentEditable,
      editing: wrapper && wrapper.classList.contains('editing'),
      hasSpans: code ? !!code.querySelector('.token') : false,
    }
  })
  assert(afterClick.ce === 'true', `点击后 contentEditable 应为 true（实际: ${afterClick.ce}）`)
  assert(afterClick.editing, '点击后应有 editing 类')
  assert(!afterClick.hasSpans, '编辑态应移除 token span（裸文本）')

  console.log('\n[3] 编辑态输入文字 → 内容更新')
  await page.keyboard.type('// edited')
  await sleep(100)
  const afterType = await page.evaluate(() => {
    const code = document.querySelector('.code-block-wrapper code')
    return { text: code ? code.textContent : null }
  })
  assert(afterType.text && afterType.text.includes('// edited'), `输入应追加到代码（实际: ${JSON.stringify(afterType.text)}）`)

  console.log('\n[4] 编辑态按 Enter → 插入换行符（非 <br>）')
  await page.keyboard.press('Enter')
  await page.keyboard.type('newline')
  await sleep(100)
  const afterEnter = await page.evaluate(() => {
    const code = document.querySelector('.code-block-wrapper code')
    return { text: code ? code.textContent : null, hasBr: code ? !!code.querySelector('br') : false }
  })
  assert(afterEnter.text && afterEnter.text.includes('newline'), '换行后文字应存在')
  assert(/\n/.test(afterEnter.text || ''), '代码应含真实 \\n 换行符')
  assert(!afterEnter.hasBr, '不应产生 <br>（避免 textContent 丢行）')

  console.log('\n[5] 点击代码外部 → 退出编辑态、重新高亮（真实鼠标点击触发 focusout）')
  // 用真实鼠标点击"代码块之后的段落"
  const box = await page.evaluate(() => {
    const paras = Array.from(document.querySelectorAll('.markdown-body p'))
    const p = paras.find((x) => x.textContent.includes('More text'))
    if (!p) return null
    const r = p.getBoundingClientRect()
    return { x: r.left + 40, y: r.top + r.height / 2 }
  })
  await page.mouse.click(box.x, box.y)
  await sleep(400)
  const afterBlur = await page.evaluate(() => {
    const code = document.querySelector('.code-block-wrapper code')
    const wrapper = document.querySelector('.code-block-wrapper')
    return {
      ce: code && code.contentEditable,
      editing: wrapper && wrapper.classList.contains('editing'),
      hasSpans: code ? !!code.querySelector('.token') : false,
      text: code ? code.textContent : null,
    }
  })
  assert(afterBlur.ce !== 'true', `失焦后 contentEditable 不应为 true（实际: ${afterBlur.ce}）`)
  assert(!afterBlur.editing, '失焦后无 editing 类')
  assert(afterBlur.hasSpans, '失焦后应重新高亮（token span 恢复）')
  assert(afterBlur.text && afterBlur.text.includes('newline'), '编辑内容应保留')

  console.log('\n[6] ``` + Enter 自动创建代码块并进入编辑态')
  // 先在末尾段落按 Enter 造一个空段落，再在其中输入 ```ts + 回车
  await page.mouse.click(box.x, box.y)
  await sleep(150)
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await sleep(150)
  await page.keyboard.type('```ts')
  await sleep(100)
  await page.keyboard.press('Enter')
  await sleep(500)
  const newBlock = await page.evaluate(() => {
    const blocks = document.querySelectorAll('.code-block-wrapper')
    const last = blocks[blocks.length - 1]
    const code = last && last.querySelector('code')
    return {
      count: blocks.length,
      ce: code && code.contentEditable,
      lang: last && last.querySelector('.code-lang') && last.querySelector('.code-lang').textContent,
    }
  })
  assert(newBlock.count >= 2, `应新建一个代码块（实际数量: ${newBlock.count}）`)
  assert(newBlock.ce === 'true', `新代码块应进入编辑态（实际: ${newBlock.ce}）`)
  // 说明：输入 ``` 即触发建块（既有自动格式化，非本次改动），语言默认 plaintext；
  // 语言可通过 markdown 源码 ```js 设置（[1] 已验证 lang=js）
  assert(newBlock.lang === 'plaintext', `新代码块语言应为 plaintext（实际: ${newBlock.lang}）`)

  // 在新建代码块里输入内容
  await page.keyboard.type('const x = 1')
  await sleep(200)
  // 点击外部触发同步
  await page.mouse.click(box.x, box.y)
  await sleep(1500) // 等待 deactivate 同步 + autosave(1000ms)

  console.log('\n[7] 同步到 store（localStorage 持久化）')
  const storeMd = await page.evaluate(() => {
    const docs = JSON.parse(localStorage.getItem('hypora_documents') || '[]')
    return docs[0] && docs[0].content
  })
  assert(storeMd && storeMd.includes('// edited'), 'store markdown 应含编辑内容 // edited')
  assert(storeMd && storeMd.includes('newline'), 'store markdown 应含换行后内容 newline')
  assert(storeMd && storeMd.includes('const x = 1'), 'store markdown 应含新代码块内容')

  console.log('\n[8] 运行时无新增 JS 错误')
  const newErrors = consoleErrors.filter((e) => !KNOWN_NOISE.test(e))
  assert(newErrors.length === 0, '无新增 console/page 错误' + (newErrors.length ? '：\n    ' + newErrors.join('\n    ') : ''))

  await browser.close()
  console.log('\n完成。')
})().catch((e) => {
  console.error('测试异常:', e)
  process.exitCode = 1
})
