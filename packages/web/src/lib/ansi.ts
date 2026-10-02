// A ```ansi fence: terminal output with its SGR escape sequences rendered as the colours and weights a
// terminal would draw, rather than as `[31m` noise. highlight.js has no grammar for this — escape codes
// are not a language, they are presentation — so it is its own small renderer beside hljs, reached
// through the same `highlightToHtml` door (syntaxHighlight.ts).
//
// WHICH BYTES COUNT AS ESC. A raw ESC (U+001B) rarely reaches the browser: the Claude runtime replaces
// every control byte with U+FFFD before an event leaves the server (safeText in
// claude-agent-sdk-protocol.ts), so a pasted terminal capture arrives as `�[31m`. And an agent writing a
// fence by hand types the escape the way source code spells it — `\x1b[31m`, `\e[1m`, `\033[0m`. So the
// introducer is any of: the raw byte, U+FFFD, `\x1b`, `\u001b`, `\033`, `\e`, or caret notation `^[`.
// A non-raw one only counts when a CSI (`[`), OSC (`]`) or charset designation (`(B`) follows it, so a
// lone `\e` or a genuine replacement character in the text stays literal.
//
// THE SOURCE STAYS IN THE DOM. Each sequence is kept, verbatim, in a `display: none` span instead of
// being dropped, so the block's textContent is byte-identical to what the author wrote — the invariant
// every other highlighter here keeps (codeBody.ts), and what the fence's copy button reads
// (lib/copy-code.ts). A mouse selection copies the RENDERED text, because the browser serializes a
// selection without its display:none content; the button copies the source. Both are useful, and each
// gesture already means that elsewhere.
//
// COLOURS. The sixteen indexed colours are classes on the `--terminal-*` palette in theme.css, so they
// follow the light/dark theme the way a terminal profile does. A 256-colour index above 15 or a 24-bit
// colour is a value the author pinned, so it rides an inline hex `style` — the one inline style the
// markdown sanitizer admits, and only in exactly the shape this file emits (ANSI_STYLE_PATTERN).
//
// Everything that is not SGR (cursor motion, erase-line, OSC titles and hyperlinks, charset switches) is
// consumed and draws nothing: a static block has no cursor to move.

const PALETTE = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const

type Color = { index: number } | { hex: string }

interface Style {
  fg?: Color
  bg?: Color
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  inverse: boolean
  hidden: boolean
  strike: boolean
}

const PLAIN: Readonly<Style> = Object.freeze({
  bold: false, dim: false, italic: false, underline: false, inverse: false, hidden: false, strike: false,
})

export const ANSI_ESC_CLASS = "ansi-esc"

// The sanitizer's allowlist for a span's `style`, and the only shape `openTag` below produces.
export const ANSI_STYLE_PATTERN = /^(?:color:#[0-9a-f]{6}(?:;background-color:#[0-9a-f]{6})?|background-color:#[0-9a-f]{6})$/

const INTRODUCER = String.raw`(?:\x1b|�|\\x1[bB]|\\u001[bB]|\\033|\\e|\^\[)`
const NEXT_INTRODUCER = new RegExp(INTRODUCER, "g")
// Anchored at the byte after the introducer. CSI is ECMA-48's own grammar: parameter bytes, then
// intermediates, then one final byte. The length caps keep a stray introducer from scanning a whole log.
const CSI = /\[([0-?]{0,64})[ -/]{0,8}([@-~])/y
// OSC runs to BEL or ST on the same line; both arrive in every spelling the introducer does, and the
// Claude runtime turns a raw BEL into U+FFFD just as it does ESC. ST is listed first so `�\` reads as
// ST and not as a BEL followed by a stray backslash.
const OSC = new RegExp(String.raw`\][^\n]{0,2048}?(?:${INTRODUCER}\\\\?|\x07|�|\\a|\\x07|\\007|\\u0007)`, "y")
const CHARSET = /[()][0-9A-Za-z]/y

export function renderAnsi(text: string): string {
  let out = ""
  let style: Style = { ...PLAIN }
  let tag = ""
  let cursor = 0
  const emitText = (end: number) => {
    if (end <= cursor) return
    const chunk = escapeHtml(text.slice(cursor, end))
    out += tag ? `${tag}${chunk}</span>` : chunk
  }
  NEXT_INTRODUCER.lastIndex = 0
  for (let match = NEXT_INTRODUCER.exec(text); match; match = NEXT_INTRODUCER.exec(text)) {
    const start = match.index
    const after = start + match[0].length
    let end = -1
    let sgr: string | undefined
    for (const grammar of [CSI, OSC, CHARSET]) {
      grammar.lastIndex = after
      const body = grammar.exec(text)
      if (!body) continue
      end = after + body[0].length
      if (grammar === CSI && body[2] === "m") sgr = body[1]
      break
    }
    // A raw ESC that starts nothing recognisable is still never text: drop the byte alone.
    if (end < 0 && match[0] === "\x1b") end = after
    if (end < 0) continue
    emitText(start)
    out += `<span class="${ANSI_ESC_CLASS}">${escapeHtml(text.slice(start, end))}</span>`
    if (sgr !== undefined) {
      style = applySgr(style, sgr)
      tag = openTag(style)
    }
    cursor = end
    NEXT_INTRODUCER.lastIndex = end
  }
  emitText(text.length)
  return out
}

// One SGR parameter string — `1;31`, `38;5;208`, `38;2;255;128;0`, or the colon forms `38:5:208` and
// `38:2::255:128:0` (ITU T.416, with its optional colour-space id) — applied to the running style. An
// empty string is a reset, as is an empty parameter. Private-mode parameters (`<=>?`) are not SGR.
function applySgr(previous: Style, params: string): Style {
  if (!/^[0-9:;]*$/.test(params)) return previous
  const style = { ...previous }
  const codes = params === "" ? ["0"] : params.split(";")
  for (let i = 0; i < codes.length; i++) {
    const [head, ...sub] = codes[i].split(":")
    const code = head === "" ? 0 : Number(head)
    if (code === 38 || code === 48 || code === 58) {
      let color: Color | undefined
      if (sub.length > 0) color = extendedColor(sub[0], sub[0] === "2" && sub.length > 4 ? sub.slice(2, 5) : sub.slice(1))
      else {
        const kind = codes[i + 1]
        const width = kind === "5" ? 1 : kind === "2" ? 3 : 0
        color = extendedColor(kind, codes.slice(i + 2, i + 2 + width))
        i += 1 + width
      }
      // 58 is the underline colour: consumed so its arguments are not read as codes, then ignored.
      if (color && code === 38) style.fg = color
      if (color && code === 48) style.bg = color
      continue
    }
    if (code === 0) Object.assign(style, PLAIN, { fg: undefined, bg: undefined })
    else if (code === 1) style.bold = true
    else if (code === 2) style.dim = true
    else if (code === 3) style.italic = true
    else if (code === 4) style.underline = sub[0] !== "0"
    else if (code === 7) style.inverse = true
    else if (code === 8) style.hidden = true
    else if (code === 9) style.strike = true
    else if (code === 21) style.underline = true
    else if (code === 22) style.bold = style.dim = false
    else if (code === 23) style.italic = false
    else if (code === 24) style.underline = false
    else if (code === 27) style.inverse = false
    else if (code === 28) style.hidden = false
    else if (code === 29) style.strike = false
    else if (code >= 30 && code <= 37) style.fg = { index: code - 30 }
    else if (code === 39) style.fg = undefined
    else if (code >= 40 && code <= 47) style.bg = { index: code - 40 }
    else if (code === 49) style.bg = undefined
    else if (code >= 90 && code <= 97) style.fg = { index: code - 90 + 8 }
    else if (code >= 100 && code <= 107) style.bg = { index: code - 100 + 8 }
  }
  return style
}

function extendedColor(kind: string | undefined, args: string[]): Color | undefined {
  const values = args.map((arg) => (arg === "" ? Number.NaN : Number(arg)))
  if (!values.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) return undefined
  if (kind === "5" && values.length === 1) return indexedColor(values[0])
  if (kind === "2" && values.length === 3) return { hex: hex(values[0], values[1], values[2]) }
  return undefined
}

// xterm's 256-colour table: 0–15 are the themeable sixteen, 16–231 a 6×6×6 cube, 232–255 a grey ramp.
function indexedColor(index: number): Color {
  if (index < 16) return { index }
  if (index >= 232) {
    const grey = 8 + (index - 232) * 10
    return { hex: hex(grey, grey, grey) }
  }
  const level = (n: number) => (n === 0 ? 0 : 55 + n * 40)
  const cube = index - 16
  return { hex: hex(level(Math.floor(cube / 36)), level(Math.floor(cube / 6) % 6), level(cube % 6)) }
}

function hex(...channels: number[]): string {
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
}

function colorName(index: number): string {
  return index < 8 ? PALETTE[index] : `bright-${PALETTE[index - 8]}`
}

// The span a run of text in this style is wrapped in, or "" for the block's own default.
//
// Inverse swaps the two colours. A side that was the DEFAULT has no colour to swap in, so it takes the
// block's own: `ansi-fg-inverse` paints text in the block's background, `ansi-bg-inverse` fills behind it
// with the block's text colour — what a terminal does with `\e[7m` on default colours.
function openTag(style: Style): string {
  const fg = style.inverse ? style.bg : style.fg
  const bg = style.inverse ? style.fg : style.bg
  const classes: string[] = []
  const inline: string[] = []
  if (fg && "index" in fg) classes.push(`ansi-fg-${colorName(fg.index)}`)
  else if (fg) inline.push(`color:${fg.hex}`)
  else if (style.inverse) classes.push("ansi-fg-inverse")
  if (bg && "index" in bg) classes.push(`ansi-bg-${colorName(bg.index)}`)
  else if (bg) inline.push(`background-color:${bg.hex}`)
  else if (style.inverse) classes.push("ansi-bg-inverse")
  if (style.bold) classes.push("ansi-bold")
  if (style.dim) classes.push("ansi-dim")
  if (style.italic) classes.push("ansi-italic")
  if (style.underline) classes.push("ansi-underline")
  if (style.strike) classes.push("ansi-strike")
  if (style.hidden) classes.push("ansi-hidden")
  if (classes.length === 0 && inline.length === 0) return ""
  return `<span${classes.length ? ` class="${classes.join(" ")}"` : ""}${inline.length ? ` style="${inline.join(";")}"` : ""}>`
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;"
    if (char === "<") return "&lt;"
    if (char === ">") return "&gt;"
    if (char === '"') return "&quot;"
    return "&#39;"
  })
}
