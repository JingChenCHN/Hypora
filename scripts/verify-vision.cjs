// 识图功能冒烟测试：GLM provider 切换、图片上传、预览、多模态消息渲染
// 用法：先 npx vite preview --port 4173，再 node scripts/verify-vision.cjs
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

  await p.goto(URL, { waitUntil: 'networkidle2' })
  // AI 面板异步组件 + 首次打开才挂载：先 Ctrl+J 触发 panelVisible → 挂载
  await p.keyboard.down('Control'); await p.keyboard.press('j'); await p.keyboard.up('Control')
  await p.waitForSelector('.ai-panel', { timeout: 10000 })
  await wait(400)
  // 若仍是收起态，再按一次展开
  const collapsed = await p.evaluate(() => document.querySelector('.ai-panel').classList.contains('is-collapsed'))
  if (collapsed) { await p.keyboard.down('Control'); await p.keyboard.press('j'); await p.keyboard.up('Control'); await wait(400) }

  // 打开配置区，切换到 GLM 识图
  await p.evaluate(() => document.querySelector('.ai-header .header-btn')?.click())
  await wait(300)
  const switched = await p.evaluate(() => {
    const btns = [...document.querySelectorAll('.ai-config .prov-btn')]
    const glm = btns.find(b => b.textContent.includes('GLM'))
    if (glm) glm.click()
    return !!glm
  })
  console.log(`[T1] 切换到 GLM provider: ${switched ? '✓' : '✗'}`)
  await wait(300)

  // 验证 GLM 配置区出现 + 默认 key/model 已预填
  const glmCfg = await p.evaluate(() => {
    const inputs = document.querySelectorAll('.ai-config input[type=password]')
    const selects = document.querySelectorAll('.ai-config select')
    // 读 glmKey（password 输入框的 value）
    const keyInput = inputs[0]
    return {
      keyPrefilled: !!(keyInput && keyInput.value && keyInput.value.length > 20),
      modelShown: !!document.querySelector('.ai-config .config-hint-row')?.textContent.includes('GLM 识图模式')
    }
  })
  console.log(`[T2] GLM key 已预填: ${glmCfg.keyPrefilled ? '✓' : '✗'} | 提示文案: ${glmCfg.modelShown ? '✓' : '✗'}`)

  // 验证图片上传按钮出现
  const uploadBtnExists = await p.evaluate(() => !!document.querySelector('.img-upload-btn'))
  console.log(`[T3] 图片上传按钮可见: ${uploadBtnExists ? '✓' : '✗'}`)

  // 上传一张测试图片（1x1 PNG，通过 file input 注入）
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  await p.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const file = new File([bytes], 'test.png', { type: 'image/png' })
    const input = document.querySelector('.ai-input input[type=file]')
    const dt = new DataTransfer(); dt.items.add(file)
    // 通过原生 setter 触发 change
    Object.defineProperty(input, 'files', { value: dt.files })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, pngB64)
  await wait(600)

  // 验证预览缩略图出现
  const previewCount = await p.evaluate(() => document.querySelectorAll('.img-preview-strip .img-thumb').length)
  console.log(`[T4] 上传后预览缩略图数: ${previewCount === 1 ? '✓ (1张)' : `✗ (${previewCount}张)`}`)

  // 发送（无文字，应触发默认 prompt）
  await p.evaluate(() => {
    const btns = [...document.querySelectorAll('.ai-input .send-btn')]
    const send = btns.find(b => b.textContent.trim() === '发送')
    if (send) send.click()
  })
  await wait(800)

  // 验证用户气泡渲染了图片（多模态消息）
  const userImgRendered = await p.evaluate(() => {
    const userMsgs = [...document.querySelectorAll('.ai-msg.user')]
    const last = userMsgs[userMsgs.length - 1]
    return !!(last && last.querySelector('img.user-img'))
  })
  console.log(`[T5] 用户气泡渲染图片: ${userImgRendered ? '✓' : '✗'}`)

  // 验证 store 里最后一条 user 消息是数组格式（多模态）
  const storeFormat = await p.evaluate(() => {
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('ai')
    const msgs = store.messages
    const lastUser = [...msgs].reverse().find(m => m.role === 'user')
    return { isArray: Array.isArray(lastUser?.content), hasImage: Array.isArray(lastUser?.content) && lastUser.content.some(p => p.type === 'image_url') }
  })
  console.log(`[T6] store 消息为多模态数组: ${storeFormat.isArray && storeFormat.hasImage ? '✓' : `✗ (array=${storeFormat.isArray})`}`)

  // 因沙箱无法访问 GLM 端点，助手消息会含错误提示，但这证明请求已发出
  await wait(1500)
  const assistantContent = await p.evaluate(() => {
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('ai')
    const last = store.messages[store.messages.length - 1]
    return last?.role === 'assistant' ? last.content : null
  })
  console.log(`[T7] 助手有响应（沙箱无网应为错误提示）: ${assistantContent && assistantContent.length > 0 ? '✓' : '✗'}`)

  // 验证发送后 pendingImages 清空
  const pendingCleared = await p.evaluate(() => {
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('ai')
    return store.pendingImages.length === 0
  })
  console.log(`[T8] 发送后 pendingImages 清空: ${pendingCleared ? '✓' : '✗'}`)

  // 收起配置区，切回 deepseek 时上传按钮应消失（provider 切换响应）
  await p.evaluate(() => {
    const btns = [...document.querySelectorAll('.ai-config .prov-btn')]
    const ds = btns.find(b => b.textContent.includes('DeepSeek'))
    if (ds) ds.click()
  })
  await wait(300)
  const uploadHidden = await p.evaluate(() => !document.querySelector('.img-upload-btn'))
  console.log(`[T9] 切回 DeepSeek 后上传按钮隐藏: ${uploadHidden ? '✓' : '✗'}`)

  console.log(`\n控制台错误: ${errors.length ? errors.slice(0,3).join(' | ') : '无'}`)
  await b.close()
  const ok = switched && glmCfg.keyPrefilled && uploadBtnExists && previewCount === 1 && userImgRendered && storeFormat.isArray && storeFormat.hasImage && pendingCleared && uploadHidden
  console.log(ok ? '\n=== VISION SMOKE PASS ===' : '\n=== VISION SMOKE FAIL ===')
  process.exit(ok ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
