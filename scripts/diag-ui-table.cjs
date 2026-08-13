// 验证：UI 中表格经 Ctrl+/ 源码往返是否被破坏
const puppeteer = require('puppeteer-core')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const DEV = 'http://localhost:5300'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function main() {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox','--disable-gpu'] })
  const page = await browser.newPage()
  await page.goto(DEV, { waitUntil: 'networkidle0', timeout: 60000 })
  await page.waitForSelector('.markdown-body', { timeout: 30000 })
  await sleep(1500)

  const tableMd = '| a | b |\n| --- | --- |\n| 1 | 2 |'

  // 切到源码模式
  let inSource = await page.$('textarea.source-editor')
  if (!inSource) {
    await page.keyboard.down('Control'); await page.keyboard.press('/'); await page.keyboard.up('Control')
    await sleep(600)
  }
  await page.waitForSelector('textarea.source-editor', { timeout: 5000 })
  // 输入表格 markdown
  await page.evaluate((v) => {
    const ta = document.querySelector('textarea.source-editor')
    if (ta) { ta.value = v; ta.dispatchEvent(new Event('input', { bubbles: true })) }
  }, tableMd)
  await sleep(400)
  const mdBefore = await page.$eval('textarea.source-editor', el => el.value)
  console.log('mdBefore (source, table):', JSON.stringify(mdBefore))

  // 切回所见即所得
  await page.keyboard.down('Control'); await page.keyboard.press('/'); await page.keyboard.up('Control')
  await sleep(700)
  const htmlMid = await page.$eval('.markdown-body', el => el.innerHTML)
  console.log('htmlMid (wysiwyg):', htmlMid)
  console.log('  has <table>:', /<table/i.test(htmlMid))

  // 再切回源码
  await page.keyboard.down('Control'); await page.keyboard.press('/'); await page.keyboard.up('Control')
  await sleep(700)
  const mdAfter = await page.$eval('textarea.source-editor', el => el.value)
  console.log('mdAfter (source):', JSON.stringify(mdAfter))
  console.log('  has | table syntax:', mdAfter.includes('|'))
  console.log('  table preserved:', mdBefore === mdAfter)

  await browser.close()
}
main().catch(e => { console.error(e); process.exit(1) })
