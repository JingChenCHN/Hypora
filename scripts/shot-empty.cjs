const puppeteer = require('puppeteer-core')
async function main() {
  const b = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })
  const p = await b.newPage()
  await p.setViewport({ width: 1000, height: 300 })
  await p.goto('http://localhost:5300', { waitUntil: 'networkidle2' })
  await p.waitForSelector('.markdown-body')
  await new Promise(r => setTimeout(r, 1500))
  await p.evaluate(() => { document.querySelector('.markdown-body').innerHTML = '<p><br></p>' })
  await p.click('.markdown-body p')
  await p.focus('.markdown-body')
  await p.keyboard.type('## ', { delay: 150 })
  await new Promise(r => setTimeout(r, 600))
  const info = await p.evaluate(() => {
    const h = document.querySelector('.markdown-body h2')
    const cs = getComputedStyle(h, '::before')
    return { childNodes: h.childNodes.length, before: cs.content, color: cs.color }
  })
  console.log('空h2占位检测:', JSON.stringify(info))
  await p.screenshot({ path: 'empty-h2-placeholder.png' })
  await b.close()
}
main().catch(e => { console.error(e); process.exit(1) })