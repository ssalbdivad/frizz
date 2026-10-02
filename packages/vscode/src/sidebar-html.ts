// THE SIDEBAR'S DOCUMENTS — the HTML VS Code serves into the Frizz view. Two kinds:
//
//  - the FRAME document: one full-bleed iframe of the Frizz page, and the relay script, which is the only
//    thing that runs in it. Its CSP names exactly one frame origin (Frizz's), loads nothing else, and lets
//    only its own nonce'd script and style run.
//  - a MESSAGE document: a line of copy and a button or two, in VS Code's own colours, for the states
//    with no page to show (Frizz not found, a port Frizz would refuse).
//
// Pure strings, no `vscode`: sidebar-html.test.ts pins the CSP, the escaping and the relay's rules.
//
// The relay. Three documents take part (embed-protocol.ts): the extension host, this document (served
// from a `vscode-webview://` origin) and the page in its iframe. Messages cross it unchanged:
//  - page → host: only from ITS iframe (`event.source === frame.contentWindow`) at Frizz's origin, sent on
//    as `{ page: <message> }`. The extension validates the message again (embed.ts parsePageMessage).
//  - host → page: VS Code's host frame delivers the extension's messages at this document's own origin
//    (pre/index.html, `contentWindow.postMessage(…, window.origin)`), and that ORIGIN is how they are
//    known: VS Code sets `window.parent = window` in a webview document (its injected API script), so
//    the source cannot be compared with the parent, and each webview's origin is its own — only VS
//    Code's frame and this document share it. A `frizz:` message is posted on with `targetOrigin` =
//    Frizz's origin, so if the frame were ever somewhere else the browser drops it instead of handing it
//    selected code.
//  - the view's own traffic never reaches the page: `{ view: … }` from this document (its buttons, its
//    platform) and `{ view: "hint" }` from the extension, which shows or hides the "hasn't loaded" bar.
// The envelope keeps the two apart, so nothing the page posts can pass for a click on Reload.

import { randomBytes } from "node:crypto"
import { safeOrigin } from "./embed.ts"

export function nonce(): string {
  return randomBytes(18).toString("base64url")
}

export function escapeHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
}

/** The policy for a document that loads nothing from anywhere, frames at most `frameOrigin`, and runs only its own nonce'd code. */
export function contentSecurityPolicy(nonceValue: string, frameOrigin?: string): string {
  return [
    "default-src 'none'",
    ...(frameOrigin ? [`frame-src ${frameOrigin}`] : []),
    `style-src 'nonce-${nonceValue}'`,
    `script-src 'nonce-${nonceValue}'`,
  ].join("; ")
}

/**
 * VS Code's own look: its font, colours and button tokens, so the message states read as part of the
 * workbench (a welcome view's copy and full-width button) and not as a web page.
 */
const STYLE = `
  html, body { margin: 0; padding: 0; height: 100%; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: transparent; }
  .frame { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
  iframe { flex: 1; min-height: 0; width: 100%; border: 0; display: block; background: transparent; }
  .message, .hint { padding: 12px 20px 16px; }
  .hint { border-bottom: 1px solid var(--vscode-panel-border, transparent); }
  .hint[hidden] { display: none; }
  p { margin: 0 0 12px; line-height: 1.4; }
  .actions { display: flex; flex-direction: column; gap: 8px; }
  button { font: inherit; padding: 4px 8px; line-height: 18px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer; width: 100%; max-width: 300px;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
`

export interface ViewAction {
  /** What the extension receives as `{ view: action }`. */
  action: string
  label: string
  secondary?: boolean
}

function buttons(actions: readonly ViewAction[]): string {
  return actions
    .map(({ action, label, secondary }) => `<button type="button" data-action="${escapeHtml(action)}"${secondary ? ' class="secondary"' : ""}>${escapeHtml(label)}</button>`)
    .join("")
}

/** Posts `{ view: <action> }` for a click on any `[data-action]` button. Shared by both documents. */
const CLICKS = `
  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-action]") : null
    if (button) vscode.postMessage({ view: button.dataset.action })
  })`

/** A short message in the view, with buttons. */
export function messageDocument(input: { nonce: string; text: string; actions: readonly ViewAction[] }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(input.nonce)}">
<style nonce="${input.nonce}">${STYLE}</style>
</head>
<body>
<div class="message" role="status"><p>${escapeHtml(input.text)}</p><div class="actions">${buttons(input.actions)}</div></div>
<script nonce="${input.nonce}">
  const vscode = acquireVsCodeApi()${CLICKS}
</script>
</body>
</html>`
}

/** The text and buttons of the bar shown over a page that has not said it is ready. */
export const HINT = {
  text: "Frizz hasn't finished loading here.",
  actions: [{ action: "reload", label: "Reload" }, { action: "browser", label: "Open in browser", secondary: true }],
} as const

/** The iframe of Frizz at `url` (whose origin is `origin`), and the relay. */
export function frameDocument(input: { nonce: string; url: string; origin: string }): string {
  const { url, origin } = input
  if (!safeOrigin(origin) || new URL(url).origin !== origin) throw new Error(`refusing to frame ${url} as ${origin}`)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(input.nonce, origin)}">
<style nonce="${input.nonce}">${STYLE}</style>
</head>
<body>
<div class="frame">
<div class="hint" id="hint" role="status" hidden><p>${escapeHtml(HINT.text)}</p><div class="actions">${buttons(HINT.actions)}</div></div>
<iframe id="frizz" title="Frizz" src="${escapeHtml(url)}" allow="clipboard-read; clipboard-write; local-network-access"></iframe>
</div>
<script nonce="${input.nonce}">
  const vscode = acquireVsCodeApi()
  const FRIZZ = ${JSON.stringify(origin)}
  const frame = document.getElementById("frizz")
  const hint = document.getElementById("hint")
  window.addEventListener("message", (event) => {
    const data = event.data
    if (event.source === frame.contentWindow) {
      if (event.origin === FRIZZ) vscode.postMessage({ page: data })
      return
    }
    if (event.origin !== window.origin) return
    if (!data || typeof data !== "object") return
    if (data.view === "hint") {
      hint.hidden = !data.show
      return
    }
    if (typeof data.type !== "string" || !data.type.startsWith("frizz:")) return
    // The page puts the caret in its composer, or opens the door a title-row button names (New thread's
    // caret, the palette's search box, Settings); the frame has to hold the focus for either to take the
    // keyboard. Without it a button left the keyboard in this document, where no key reaches the page.
    if (data.focus === true || data.type === "frizz:command") frame.focus()
    frame.contentWindow.postMessage(data, FRIZZ)
  })
  // Focus that lands on this document (the view revealed, a click on its edge) belongs to the page. Also
  // when this document's focused element is ALREADY the frame: VS Code's webview host focuses this WINDOW
  // (its active frame's contentWindow.focus()) as it settles a view's focus, and a focused window is the
  // focused frame — the page under it loses the keyboard though nothing here moved. Focusing the frame
  // element again would be a no-op (it is the active element), so the page's window is focused instead.
  window.addEventListener("focus", () => setTimeout(() => {
    if (document.activeElement === document.body) frame.focus()
    else if (document.activeElement === frame) frame.contentWindow.focus()
  }))${CLICKS}
  vscode.postMessage({ view: "platform", mac: /Mac/.test(navigator.platform) })
</script>
</body>
</html>`
}
