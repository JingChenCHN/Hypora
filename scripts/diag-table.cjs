// 诊断：表格往返失败 + 列表间距 根因分析
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

  const diag = await page.evaluate(async () => {
    const m = await import('/src/utils/markdown.ts')
    const mdToHtml = m.mdToHtml
    const htmlToMd = m.htmlToMd

    // 表格1: 标准两列
    const t1 = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    // 表格2: 带表头三列
    const t2 = '| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |'
    // 表格3: 无前导管道
    const t3 = 'a | b\n--- | ---\n1 | 2'
    // 简单列表
    const l1 = '- item'

    function rt(md, n) {
      let cur = md
      const trace = [cur]
      for (let i = 0; i < n; i++) {
        const h = mdToHtml(cur)
        cur = htmlToMd(h)
        trace.push(h)
        trace.push(cur)
      }
      return trace
    }

    // 直接测 turndown 对 marked 生成的表格 HTML 的转换
    const t1html = mdToHtml(t1)
    const t1back = htmlToMd(t1html)

    // 测 turndown 对手写纯净表格 HTML（无多余空白）的转换
    const cleanTableHtml = '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
    const cleanBack = htmlToMd(cleanTableHtml)

    // 测 turndown 是否有 table 规则
    let turndownRules = 'n/a'
    try {
      // turndown 实例未直接暴露，跳过
    } catch (e) {}

    return {
      t1: { md: t1, html: t1html, back: t1back, rt3: rt(t1, 3) },
      t2: { md: t2, html: mdToHtml(t2), back: htmlToMd(mdToHtml(t2)) },
      t3: { md: t3, html: mdToHtml(t3), back: htmlToMd(mdToHtml(t3)) },
      cleanTable: { html: cleanTableHtml, back: cleanBack },
      list: { md: l1, html: mdToHtml(l1), back: htmlToMd(mdToHtml(l1)) }
    }
  })

  console.log('=== TABLE DIAGNOSTIC ===')
  console.log('\n[t1 standard 2-col]')
  console.log('  md   :', JSON.stringify(diag.t1.md))
  console.log('  html :', diag.t1.html)
  console.log('  back :', JSON.stringify(diag.t1.back))
  console.log('  has | in back:', diag.t1.back.includes('|'))

  console.log('\n[t2 3-col with header]')
  console.log('  md   :', JSON.stringify(diag.t2.md))
  console.log('  html :', diag.t2.html)
  console.log('  back :', JSON.stringify(diag.t2.back))
  console.log('  has | in back:', diag.t2.back.includes('|'))

  console.log('\n[t3 no leading pipe]')
  console.log('  md   :', JSON.stringify(diag.t3.md))
  console.log('  html :', diag.t3.html)
  console.log('  back :', JSON.stringify(diag.t3.back))

  console.log('\n[clean hand-written table HTML -> md]')
  console.log('  html :', diag.cleanTable.html)
  console.log('  back :', JSON.stringify(diag.cleanTable.back))
  console.log('  has | in back:', diag.cleanTable.back.includes('|'))

  console.log('\n[list spacing]')
  console.log('  md   :', JSON.stringify(diag.list.md))
  console.log('  html :', diag.list.html)
  console.log('  back :', JSON.stringify(diag.list.back))

  await browser.close()
}
main().catch(e => { console.error(e); process.exit(1) })
