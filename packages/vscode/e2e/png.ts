// INK FROM PIXELS — what the real-page sidebar run measures a screenshot with, where the DOM cannot say:
// an activity-bar icon is a CSS mask, so its element box is the same whether the mark inside it is a
// crisp line drawing, a grey smudge or the solid square VS Code paints when the mask's file is missing
// (the maintainer's "the icon doesn't display", 2026-10-01). A minimal decoder for what
// `Page.captureScreenshot` writes (8-bit RGB/RGBA, non-interlaced) and an ink reading over a box of it.
//
// Runs in the harness (Node), never inside the editor.

import { inflateSync } from "node:zlib"

export interface Image {
  width: number
  height: number
  px(x: number, y: number): [number, number, number]
}

export function decodePng(png: Buffer): Image {
  let pos = 8
  let width = 0
  let height = 0
  let channels = 4
  const idat: Buffer[] = []
  while (pos < png.length) {
    const length = png.readUInt32BE(pos)
    const type = png.toString("ascii", pos + 4, pos + 8)
    const data = png.subarray(pos + 8, pos + 8 + length)
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      channels = data[9] === 6 ? 4 : 3
      if (data[8] !== 8 || data[12] !== 0) throw new Error("unsupported png: not 8-bit, or interlaced")
    } else if (type === "IDAT") idat.push(data)
    pos += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]!
      const a = x >= channels ? out[y * stride + x - channels]! : 0
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels]! : 0
      let predicted = 0
      if (filter === 1) predicted = a
      else if (filter === 2) predicted = b
      else if (filter === 3) predicted = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[y * stride + x] = (value + predicted) & 255
    }
  }
  return { width, height, px: (x, y) => [out[y * stride + x * channels]!, out[y * stride + x * channels + 1]!, out[y * stride + x * channels + 2]!] }
}

export interface Ink {
  /** The ink's box, CSS px. */
  box: [number, number]
  /** Full-ish ink pixels over the ink box's area: a line drawing is well under half; a filled square is ~1. */
  fill: number
  /** Sum of contrast normalized to the peak, CSS px² — how much mark there is. */
  mass: number
  /** Peak contrast against the corner pixel (the bar's background), 0–255. */
  peak: number
}

/** The ink in the whole image, against its top-left pixel, for a capture made at `scale` device px per CSS px. */
export function inkOf(image: Image, scale: number): Ink {
  const bg = image.px(0, 0)
  const diff = (x: number, y: number) => {
    const [r, g, b] = image.px(x, y)
    return (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2])) / 3
  }
  let peak = 0
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) peak = Math.max(peak, diff(x, y))
  if (peak === 0) return { box: [0, 0], fill: 0, mass: 0, peak: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -1
  let maxY = -1
  let mass = 0
  let solid = 0
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const d = diff(x, y)
      mass += d / peak
      if (d >= peak * 0.5) solid++
      if (d < peak * 0.25) continue
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
  }
  const round = (n: number) => Math.round(n * 100) / 100
  const area = (maxX - minX + 1) * (maxY - minY + 1)
  return {
    box: [round((maxX - minX + 1) / scale), round((maxY - minY + 1) / scale)],
    fill: round(solid / area),
    mass: round(mass / scale / scale),
    peak: Math.round(peak),
  }
}
