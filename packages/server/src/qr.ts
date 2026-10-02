import qrcode from "qrcode-generator"

/**
 * Render a string as a QR code sized for a terminal.
 *
 * Two decisions worth stating, because both are the difference between "scans instantly" and "does not
 * scan at all":
 *
 * HALF BLOCKS. Terminal cells are about twice as tall as they are wide, so one module per cell yields a
 * QR stretched 2:1 that many phone cameras refuse. Packing two module ROWS into one cell with `▀`
 * (upper half block) makes the code square AND halves its height — a 33-module code is 41 columns with
 * its quiet zone, which is 21 rows instead of 41 and therefore fits an 80x24 terminal.
 *
 * EXPLICIT COLOUR, NOT BARE GLYPHS. A QR needs dark modules on a light field. Drawing glyphs in the
 * terminal's default colours inverts that on a dark theme, which is most of them, and an inverted QR
 * does not scan on iOS. So every cell sets an explicit foreground and background instead of trusting
 * the theme. The quiet zone is drawn, not assumed — a QR flush against surrounding text is unreadable
 * even when the code itself is perfect.
 *
 * NO GLYPH IN A UNIFORM CELL. A pair of dark modules used to be `▀` in dark ink on a dark background,
 * and that is a glyph the SAME colour as the field behind it — which is exactly what a terminal's
 * minimum-contrast setting exists to "repair" by lightening the ink, and what any font whose half block
 * stops short of the cell edge leaves a hairline of background through. Either way every solid dark
 * run came out striped, and a phone would not read the finder patterns (maintainer's screenshot,
 * 2026-09-23: "the qr code is unscannable, looks like some artifacts"). The light field never
 * striped, because a light glyph on a light background is invisible whatever happens to it. So a
 * uniform cell is now a bare space over its colour as background, with no glyph to mistreat; only a
 * MIXED cell draws a half block, and always as dark ink on a light background — `▀` when the top
 * module is the dark one, `▄` when the bottom is — so the one edge the glyph draws is a real module
 * edge, and the contrast across it is the full contrast a scanner wants.
 *
 * A font whose half block is a pixel narrower than its cell still leaves a hairline through the dark
 * half of each mixed cell. A glyph-free rendering (two background-painted columns per module, one row
 * each) avoids that entirely, and was tried on #44 — but it is four times the area of this one, 82x41
 * cells for a typical sign-in link, which dominates a terminal. Rejected for size; the hairline is
 * confined to mixed cells and a camera's blur absorbs it.
 */

const LIGHT_BG = "\x1b[48;5;15m"
const DARK = "\x1b[38;5;0m"
const DARK_BG = "\x1b[48;5;0m"
const RESET = "\x1b[0m"
const UPPER_HALF = "▀"
const LOWER_HALF = "▄"
/** Four modules is the spec's minimum quiet zone; less and the finder patterns stop being findable. */
const QUIET_ZONE = 4

export interface QrRenderOptions {
  /** Error correction. "M" tolerates ~15% damage, which covers a slightly out-of-focus phone camera. */
  errorCorrection?: "L" | "M" | "Q" | "H"
  /** Emit plain `#`/space instead of ANSI colour, for tests and non-TTY sinks. */
  plain?: boolean
}

/** True when the module at (x, y) is dark; anything outside the code is quiet zone, hence light. */
type ModuleAt = (x: number, y: number) => boolean

function encode(value: string, errorCorrection: "L" | "M" | "Q" | "H"): { size: number; at: ModuleAt } {
  // Type 0 asks the encoder to pick the smallest version that fits.
  const code = qrcode(0, errorCorrection)
  code.addData(value)
  code.make()
  const modules = code.getModuleCount()
  const size = modules + QUIET_ZONE * 2
  return {
    size,
    at: (x, y) => {
      const mx = x - QUIET_ZONE
      const my = y - QUIET_ZONE
      if (mx < 0 || my < 0 || mx >= modules || my >= modules) return false
      return code.isDark(my, mx)
    },
  }
}

/**
 * The code as terminal lines, quiet zone included. Returns lines rather than a blob so a caller can
 * centre it, box it, or repaint a region without re-encoding.
 */
export function renderQrLines(value: string, options: QrRenderOptions = {}): string[] {
  if (!value) throw new Error("renderQr requires a value")
  const { size, at } = encode(value, options.errorCorrection ?? "M")
  const lines: string[] = []
  // Two module rows per terminal row. An odd final row pairs with quiet zone, which is light anyway.
  for (let y = 0; y < size; y += 2) {
    let line = ""
    for (let x = 0; x < size; x++) {
      const top = at(x, y)
      const bottom = y + 1 < size ? at(x, y + 1) : false
      if (options.plain) {
        line += top && bottom ? "#" : top ? "^" : bottom ? "v" : " "
        continue
      }
      if (top === bottom) line += `${top ? DARK_BG : LIGHT_BG} `
      else line += `${DARK}${LIGHT_BG}${top ? UPPER_HALF : LOWER_HALF}`
    }
    lines.push(options.plain ? line : `${line}${RESET}`)
  }
  return lines
}

/** Convenience for printing straight to a terminal. */
export function renderQr(value: string, options: QrRenderOptions = {}): string {
  return renderQrLines(value, options).join("\n")
}

/** Width in terminal columns, so a caller can centre or box the code without rendering it first. */
export function qrWidth(value: string, errorCorrection: "L" | "M" | "Q" | "H" = "M"): number {
  return encode(value, errorCorrection).size
}

/**
 * The code as a standalone SVG, quiet zone included, for a browser to show (Settings → Remote access).
 *
 * One path of unit squares in a `size × size` viewBox, dark on an explicit white field — the same
 * reason as the terminal's explicit colours: an inverted code on a dark theme does not scan on iOS.
 * `shape-rendering="crispEdges"` keeps adjacent modules from leaving anti-aliased seams at odd scales.
 */
export function renderQrSvg(value: string, errorCorrection: "L" | "M" | "Q" | "H" = "M"): string {
  if (!value) throw new Error("renderQrSvg requires a value")
  const { size, at } = encode(value, errorCorrection)
  let path = ""
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (at(x, y)) path += `M${x} ${y}h1v1h-1z`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
}
