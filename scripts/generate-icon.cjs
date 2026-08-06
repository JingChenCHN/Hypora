/**
 * Hypora 图标生成器（§11 图标：macOS26 风格 squircle + Hypora 衬线 monogram）
 * 纯 Node 实现（zlib + 手写 PNG 编码），无外部依赖。
 * 生成：32x32 / 128x128 / 128x128@2x(256) / icon.png(512)
 */
const zlib = require('zlib')
const fs = require('fs')
const path = require('path')

const ACCENT = [233, 84, 32] // #E95420 Yaru orange
const AUBERGINE = [44, 0, 30] // #2C001E dark aubergine
const CREAM = [255, 250, 244] // 衬线主色

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

/* ---------- SDF 绘图（圆角矩形 + H 衬线 monogram） ---------- */

// 圆角矩形 SDF：内部为负
function sdRoundRect(x, y, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(x - cx) - (halfW - r)
  const qy = Math.abs(y - cy) - (halfH - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(ax, ay) - r
}

// 矩形 SDF（用于 H 的三个横竖条）
function sdRect(x, y, x0, y0, x1, y1) {
  const dx = Math.max(x0 - x, x - x1, 0)
  const dy = Math.max(y0 - y, y - y1, 0)
  return Math.hypot(dx, dy)
}

const clamp01 = (v) => Math.max(0, Math.min(1, v))

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const px = 1 / size
  const S = size

  // 圆角矩形参数（squircle 圆角 ~22%）
  const rect = {
    cx: S * 0.5,
    cy: S * 0.5,
    halfW: S * 0.48,
    halfH: S * 0.48,
    r: S * 0.22,
  }
  // H monogram：两条竖 + 一条横
  const barW = S * 0.115
  const leftX0 = S * 0.30 - barW / 2
  const leftX1 = S * 0.30 + barW / 2
  const rightX0 = S * 0.70 - barW / 2
  const rightX1 = S * 0.70 + barW / 2
  const topY0 = S * 0.32
  const botY1 = S * 0.68
  const crossY0 = S * 0.44
  const crossY1 = S * 0.56

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const pxd = x + 0.5
      const pyd = y + 0.5
      // 4x 超采样
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const fx = pxd + (sx + 0.5) * px - 0.5 * px * 4 / 4 // 采样点
          const fy = pyd + (sy + 0.5) * px - 0.5 * px * 4 / 4
          const dist = sdRoundRect(fx, fy, rect.cx, rect.cy, rect.halfW, rect.halfH, rect.r)
          const bodyCover = clamp01(0.5 - dist)
          if (bodyCover <= 0) continue

          // 内描边（aubergine 细线）
          const ring = clamp01(0.5 - Math.abs(dist + S * 0.012))
          // H 字形覆盖
          const hDist = Math.min(
            sdRect(fx, fy, leftX0, topY0, leftX1, botY1),
            sdRect(fx, fy, rightX0, topY0, rightX1, botY1),
            sdRect(fx, fy, leftX0, crossY0, rightX1, crossY1),
          )
          const hCover = clamp01(0.5 - hDist)

          const base = ring > 0.5 ? AUBERGINE : ACCENT
          const cr = base[0] + (CREAM[0] - base[0]) * hCover
          const cg = base[1] + (CREAM[1] - base[1]) * hCover
          const cb = base[2] + (CREAM[2] - base[2]) * hCover
          r += cr * bodyCover
          g += cg * bodyCover
          b += cb * bodyCover
          a += bodyCover
        }
      }
      const idx = (y * S + x) * 4
      rgba[idx] = Math.round(r / 16)
      rgba[idx + 1] = Math.round(g / 16)
      rgba[idx + 2] = Math.round(b / 16)
      rgba[idx + 3] = Math.round(a / 16)
    }
  }
  return rgba
}

/* ---------- ICO 编码（Windows 应用图标，Vista+ PNG 条目） ---------- */
function encodeICO(entries) {
  const count = entries.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(count, 4)
  const dirSize = 16
  let offset = 6 + count * dirSize
  const parts = [header]
  for (const e of entries) {
    const dir = Buffer.alloc(dirSize)
    dir.writeUInt8(e.width >= 256 ? 0 : e.width, 0) // 0 表示 256
    dir.writeUInt8(e.height >= 256 ? 0 : e.height, 1)
    dir.writeUInt8(0, 2) // color count
    dir.writeUInt8(0, 3) // reserved
    dir.writeUInt16LE(1, 4) // planes
    dir.writeUInt16LE(32, 6) // bit count
    dir.writeUInt32LE(e.png.length, 8)
    dir.writeUInt32LE(offset, 12)
    parts.push(dir)
    offset += e.png.length
  }
  for (const e of entries) parts.push(e.png)
  return Buffer.concat(parts)
}

/* ---------- 输出 ---------- */
const outDir = path.join(__dirname, '..', 'src-tauri', 'icons')
fs.mkdirSync(outDir, { recursive: true })

const targets = [
  ['32x32.png', 32],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
  ['icon.png', 512],
]

for (const [name, size] of targets) {
  const png = encodePNG(size, size, drawIcon(size))
  fs.writeFileSync(path.join(outDir, name), png)
  console.log(`✔ ${name} (${size}×${size}, ${(png.length / 1024).toFixed(1)} KB)`)
}

// Windows icon.ico：16/32/48/256 PNG 条目（Win10/11 原生支持）
const icoEntries = [16, 32, 48, 256].map((size) => ({
  width: size,
  height: size,
  png: encodePNG(size, size, drawIcon(size)),
}))
const ico = encodeICO(icoEntries)
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico)
console.log(`✔ icon.ico (${icoEntries.length} 个尺寸, ${(ico.length / 1024).toFixed(1)} KB)`)
console.log('图标已生成到 src-tauri/icons/')
