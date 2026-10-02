import assert from "node:assert/strict"
import test from "node:test"
import { ANSI_STYLE_PATTERN, renderAnsi } from "./ansi.ts"
import { renderHighlightedCode, resolveFenceLanguage, resolveFileLanguage } from "./syntaxHighlight.ts"

const ESC = "<span class=\"ansi-esc\">"

// What the block shows: the markup minus the hidden sequences and every tag.
function visible(html: string): string {
  return html.replace(/<span class="ansi-esc">[^<]*<\/span>/g, "").replace(/<[^>]+>/g, "")
}

// What the copy button reads: every text node, hidden ones included.
function source(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&")
}

test("an ansi fence resolves to its own renderer; no file path does", () => {
  assert.equal(resolveFenceLanguage("ansi"), "ansi")
  assert.equal(resolveFenceLanguage("ANSI title=out.txt"), "ansi")
  assert.equal(resolveFileLanguage("capture.ansi"), "plaintext")
  const html = renderHighlightedCode("\x1b[31mred\x1b[0m\n", "ansi")
  assert.match(html, /^<span class="md-code"><pre><code class="hljs language-ansi">/)
  assert.match(html, /<span class="ansi-fg-red">red<\/span>/)
})

// The Claude runtime turns a raw ESC into U+FFFD before it reaches the browser, and an agent writing a
// fence by hand spells the escape the way source code does. Every one of those is the same sequence.
test("every spelling of the escape introducer draws the same colour", () => {
  for (const introducer of ["\x1b", "\ufffd", "\\x1b", "\\x1B", "\\u001b", "\\033", "\\e", "^["]) {
    const html = renderAnsi(`${introducer}[1;32mok${introducer}[0m done`)
    assert.equal(visible(html), "ok done", introducer)
    assert.match(html, /<span class="ansi-fg-green ansi-bold">ok<\/span>/, introducer)
  }
})

test("the escape sequences stay in the DOM, hidden, so the text content is the source verbatim", () => {
  const input = "\\e[33mwarn\\e[0m: <a> & 'b'\n\x1b[2Kcleared"
  const html = renderAnsi(input)
  assert.equal(source(html), input)
  assert.equal(visible(html), "warn: &lt;a&gt; &amp; &#39;b&#39;\ncleared")
  assert.ok(html.includes(`${ESC}\\e[33m</span>`))
  assert.ok(html.includes(`${ESC}\x1b[2K</span>`), "a non-SGR CSI is consumed and draws nothing")
})

test("an introducer that starts no sequence stays literal text, except a raw ESC", () => {
  assert.equal(renderAnsi("C:\\e\\dir and a stray \ufffd byte"), "C:\\e\\dir and a stray \ufffd byte")
  assert.equal(visible(renderAnsi("a\x1bZb")), "aZb", "a raw ESC is never text, even when nothing follows it")
})

test("SGR attributes set and reset independently", () => {
  const html = renderAnsi("\x1b[1;2;3;4;9mall\x1b[22;23mmid\x1b[24;29mplain\x1b[mreset")
  assert.match(html, /<span class="ansi-bold ansi-dim ansi-italic ansi-underline ansi-strike">all<\/span>/)
  assert.match(html, /<span class="ansi-underline ansi-strike">mid<\/span>/)
  assert.match(html, /<\/span>plain<span/, "an attribute-free run carries no span at all")
  assert.match(html, /<\/span>reset$/)
  assert.match(renderAnsi("\x1b[4:3mcurly\x1b[4:0moff"), /<span class="ansi-underline">curly<\/span>.*<\/span>off$/)
})

test("the sixteen colours are themeable classes; 256 and 24-bit colours are inline hex", () => {
  assert.match(renderAnsi("\x1b[94;41mx"), /<span class="ansi-fg-bright-blue ansi-bg-red">x/)
  assert.match(renderAnsi("\x1b[38;5;9mx"), /<span class="ansi-fg-bright-red">x/, "256-colour index under 16 stays themeable")
  assert.match(renderAnsi("\x1b[38;5;208mx"), /<span style="color:#ff8700">x/)
  assert.match(renderAnsi("\x1b[38;5;244mx"), /<span style="color:#808080">x/)
  assert.match(renderAnsi("\x1b[38;2;10;20;300mx\x1b[38;2;10;20;30my"), /<span style="color:#0a141e">y/,
    "an out-of-range channel is ignored, not clamped")
  assert.match(renderAnsi("\x1b[38:2::255:0:128;48:5:16mx"), /<span style="color:#ff0080;background-color:#000000">x/)
  assert.match(renderAnsi("\x1b[38:2:1:2:3mx"), /<span style="color:#010203">x/, "colon form without a colour-space id")
  assert.match(renderAnsi("\x1b[58;5;1;31mx"), /<span class="ansi-fg-red">x/, "underline colour's arguments are not read as codes")
  assert.match(renderAnsi("\x1b[31m\x1b[39mx"), /<\/span>x$/, "39 restores the default foreground")
})

test("inverse swaps the colours, borrowing the block's own pair for a default side", () => {
  assert.match(renderAnsi("\x1b[7mx"), /<span class="ansi-fg-inverse ansi-bg-inverse">x/)
  assert.match(renderAnsi("\x1b[31;7mx"), /<span class="ansi-fg-inverse ansi-bg-red">x/)
  assert.match(renderAnsi("\x1b[31;44;7mx"), /<span class="ansi-fg-blue ansi-bg-red">x/)
  assert.match(renderAnsi("\x1b[38;5;208;7mx"), /<span class="ansi-fg-inverse" style="background-color:#ff8700">x/)
})

test("OSC titles and hyperlinks are consumed in every terminator spelling, keeping the linked text", () => {
  const raw = "\x1b]8;;https://example.com\x07link\x1b]8;;\x1b\\ after"
  assert.equal(visible(renderAnsi(raw)), "link after")
  const replaced = "\ufffd]0;title\ufffdtext"
  assert.equal(visible(renderAnsi(replaced)), "text", "a BEL the runtime replaced with U+FFFD still terminates")
  const written = "\\e]8;;https://example.com\\e\\\\link\\e]8;;\\a after"
  assert.equal(visible(renderAnsi(written)), "link after")
  assert.equal(source(renderAnsi(written)), written)
})

test("charset designation (tput sgr0's \\e(B) and private modes draw nothing", () => {
  assert.equal(visible(renderAnsi("\x1b(B\x1b[mplain\x1b[?25l")), "plain")
})

test("only the hex shapes the renderer emits pass the sanitizer's style pattern", () => {
  for (const ok of ["color:#ff8700", "background-color:#000000", "color:#010203;background-color:#ff0080"])
    assert.ok(ANSI_STYLE_PATTERN.test(ok), ok)
  for (const bad of ["", "color:red", "color:#FF8700", "color:#ff8700;", "background:url(x)", "color:#ff8700;position:fixed",
    "background-color:#000000;color:#ffffff", "color:var(--x)"])
    assert.ok(!ANSI_STYLE_PATTERN.test(bad), bad)
})
