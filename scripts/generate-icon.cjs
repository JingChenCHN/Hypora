const sharp = require('sharp')
const { default: pngToIco } = require('png-to-ico')
const fs = require('fs')
const path = require('path')

const sizes = [256, 128, 64, 48, 32, 16]
const root = path.join(__dirname, '..')
const svgPath = path.join(root, 'public/app-icon.svg')

async function generateIcon() {
  const pngBuffers = []

  for (const size of sizes) {
    const png = await sharp(svgPath, { density: 384 })
      .resize(size, size)
      .png()
      .toBuffer()
    pngBuffers.push(png)
    console.log(`生成 ${size}x${size} PNG`)
  }

  // 生成 ICO 文件
  const ico = await pngToIco(pngBuffers)
  fs.writeFileSync(path.join(root, 'public/favicon.ico'), ico)
  console.log('✅ 已生成 public/favicon.ico')

  // 同时输出一张 256 PNG 供打包用
  await sharp(svgPath, { density: 384 }).resize(512, 512).png()
    .toFile(path.join(root, 'public/icon.png'))
  console.log('✅ 已生成 public/icon.png')
}

generateIcon().catch(err => {
  console.error('生成图标失败:', err)
  process.exit(1)
})