const puppeteer = require('puppeteer-core')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const DEV = 'http://localhost:5300'
const wait = ms => new Promise(r => setTimeout(r, ms))

async function getStore(page) {
  return page.evaluate(() => {
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('document')
    return { docCount: store.documents.length, activeId: store.activeDocId, content: store.activeDocument ? store.activeDocument.content : null, isSource: store.isSourceMode }
  })
}
async function clearEditor(page) {
  const st = await getStore(page)
  if (st.isSource) { await page.keyboard.down('Control'); await page.keyboard.press('/'); await page.keyboard.up('Control'); await wait(200) }
  await page.evaluate(() => { const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('document'); store.updateContent('') })
  await wait(250)
  await page.evaluate(() => { document.querySelector('.markdown-body').innerHTML = '<p><br></p>' })
  await page.focus('.markdown-body')
  await page.click('.markdown-body p')
  await wait(50)
}
async function readDom(page) { return page.evaluate(() => { const ed = document.querySelector('.markdown-body'); return { innerHTML: ed.innerHTML, text: ed.textContent } }) }

async function main() {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1280,800'] })
  const p = await b.newPage()
  let errors = []
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  p.on('pageerror', e => errors.push('PAGEERROR: ' + e.message))
  await p.goto(DEV, { waitUntil: 'networkidle2' })
  await p.waitForSelector('.markdown-body')
  await wait(1500)
  await clearEditor(p)

  // ===== VERIFY T2: special chars survive a re-render (doc-switch path) =====
  console.log('\n--- T2 verify (doc-switch re-render path) ---')
  await clearEditor(p)
  errors = []
  await p.click('.markdown-body p')
  await p.keyboard.type('text1 <b>notbold</b> text2', { delay: 20 })
  await wait(350)
  const t2immediate = await readDom(p)
  const t2storeBefore = await getStore(p)
  console.log('immediate html:', t2immediate.innerHTML)
  console.log('immediate text:', JSON.stringify(t2immediate.text))
  console.log('store md before:', JSON.stringify(t2storeBefore.content))
  // re-render via: create a 2nd doc, switch to it, switch back
  const otherId = await p.evaluate(() => { const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('document'); return s.newDocument('other', '') })
  await wait(300)
  await p.evaluate((id) => { const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('document'); s.switchDocument(id) }, t2storeBefore.activeId)
  await wait(350)
  const t2after = await readDom(p)
  const t2storeAfter = await getStore(p)
  const hasRealB = await p.evaluate(() => !!document.querySelector('.markdown-body b'))
  console.log('AFTER switch-back html:', t2after.innerHTML)
  console.log('AFTER text:', JSON.stringify(t2after.text))
  console.log('store md after:', JSON.stringify(t2storeAfter.content))
  console.log('hasRealB after:', hasRealB, '| literal "<b>notbold</b>" still in text:', t2after.text.includes('<b>notbold</b>'), '| errors:', JSON.stringify(errors))

  // ===== VERIFY T4 corrected: rapid switch preserves content =====
  console.log('\n--- T4 verify corrected (rapid switch) ---')
  // fresh two docs
  await p.evaluate(() => { const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('document'); s.documents.splice(0, s.documents.length); s.activeDocId = '' })
  await wait(100)
  const aid = await p.evaluate(() => { const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('document'); return s.newDocument('A', '') })
  await wait(150)
  const bid = await p.evaluate(() => { const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('document'); return s.newDocument('B', '') })
  await wait(150)
  // go to A, type rapidly, immediately switch to B (<300ms debounce), back to A
  await p.evaluate((id) => { const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('document'); s.switchDocument(id) }, aid)
  await wait(250)
  await clearEditor(p)
  await p.click('.markdown-body p')
  await p.keyboard.type('RapidAlpha999', { delay: 15 })
  // switch to B immediately
  await p.evaluate((id) => { const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('document'); s.switchDocument(id) }, bid)
  await wait(100)
  // back to A
  await p.evaluate((id) => { const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('document'); s.switchDocument(id) }, aid)
  await wait(350)
  const t4dom = await readDom(p)
  const t4store = await getStore(p)
  console.log('A dom text:', JSON.stringify(t4dom.text))
  console.log('A store content:', JSON.stringify(t4store.content))
  console.log('A keeps RapidAlpha999:', t4dom.text.includes('RapidAlpha999'))

  // ===== VERIFY T5: search/replace DOM staleness =====
  console.log('\n--- T5 verify (search/replace DOM vs store) ---')
  await p.evaluate(() => { const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('document'); s.documents.splice(0, s.documents.length); s.activeDocId = ''; s.newDocument('srch', 'abc def abc') })
  await wait(300)
  errors = []
  const beforeDom = await readDom(p)
  console.log('before dom:', beforeDom.innerHTML)
  await p.keyboard.down('Control'); await p.keyboard.press('f'); await p.keyboard.up('Control')
  await wait(300)
  await p.evaluate(() => {
    const inputs = document.querySelectorAll('.search-panel input.el-input__inner')
    const setVal = (el, v) => { const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
    if (inputs[0]) setVal(inputs[0], 'abc')
    if (inputs[1]) setVal(inputs[1], 'xyz')
  })
  await wait(150)
  await p.evaluate(() => { const btns = [...document.querySelectorAll('.search-panel button')]; const b = btns.find(x => x.textContent.trim() === '全部替换'); if (b) b.click() })
  await wait(500)
  const afterDom = await readDom(p)
  const afterStore = await getStore(p)
  console.log('after dom html:', afterDom.innerHTML)
  console.log('after dom text:', JSON.stringify(afterDom.text))
  console.log('after store content:', JSON.stringify(afterStore.content))
  console.log('DOM shows xyz:', afterDom.text.includes('xyz'), '| DOM still shows abc:', afterDom.text.includes('abc'), '| store correct:', afterStore.content === 'xyz def xyz', '| errors:', JSON.stringify(errors))
  // try toggling source to confirm model is correct (proves it is a view-only staleness)
  await p.keyboard.down('Control'); await p.keyboard.press('/'); await p.keyboard.up('Control')
  await wait(200)
  const srcText = await p.evaluate(() => document.querySelector('.source-editor')?.value)
  console.log('source textarea after toggle:', JSON.stringify(srcText))
  await p.keyboard.down('Control'); await p.keyboard.press('/'); await p.keyboard.up('Control')
  await wait(250)
  const backDom = await readDom(p)
  console.log('WYSIWYG dom after source roundtrip:', backDom.innerHTML, '| shows xyz now:', backDom.text.includes('xyz'))
  // close search
  await p.keyboard.down('Control'); await p.keyboard.press('f'); await p.keyboard.up('Control')
  await wait(150)

  await b.close()
}
main().catch(e => { console.error(e); process.exit(1) })
