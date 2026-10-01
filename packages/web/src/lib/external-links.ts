// Frizz normally runs in an ordinary browser tab. External http(s) anchors should therefore stay in
// the browser's native click path: target=_blank opens a normal tab synchronously from the user
// gesture, preserves modifier-key behavior, and cannot be stranded behind an async RPC. Internal
// links and non-http schemes are left untouched so local navigation remains local.
//
// IN AN EDITOR'S SIDEBAR (lib/embed.ts) there is no new tab to open: a VS Code webview cannot open a
// window, so a `target=_blank` click and a `window.open` both do nothing at all. There the same external
// anchors are cancelled and handed to the editor (`frizz:open-external`), which opens them in the
// system browser. Still decided in the CAPTURE phase, before any component sees the click: several of
// these anchors stop the click's propagation in their own onClick (ThreadLinks, the GitHub picker's
// rows), so a listener that waited for the bubble would never hear them.

import { embedded, postToHost } from "./embed.ts"

type AnchorLike = Pick<HTMLAnchorElement, "getAttribute" | "setAttribute" | "hasAttribute">

/** Resolve an untrusted href, accepting only http(s). Useful for explicit link-like controls too. */
export function safeHttpUrl(raw: string, baseHref: string): string | null {
  try {
    const url = new URL(raw, baseHref)
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * Give an external http(s) anchor safe native new-tab attributes. Returns true only when the anchor
 * is external. No navigation is prevented or synthesized here; the browser completes the click.
 */
export function prepareExternalAnchor(anchor: AnchorLike, currentHref: string): boolean {
  const href = anchor.getAttribute("href")
  if (!href) return false
  const targetUrl = safeHttpUrl(href, currentHref)
  if (!targetUrl) return false

  let currentUrl: URL
  try {
    currentUrl = new URL(currentHref)
  } catch {
    return false
  }
  if (new URL(targetUrl).origin === currentUrl.origin) return false

  anchor.setAttribute("target", "_blank")
  const rel = new Set((anchor.getAttribute("rel") ?? "").split(/\s+/u).filter(Boolean))
  rel.add("noopener")
  rel.add("noreferrer")
  anchor.setAttribute("rel", [...rel].join(" "))
  return true
}

/**
 * Exported for focused node tests; the installed listener delegates to this exact handler. `toHost` is
 * set in embed mode: an external anchor's click is cancelled and its URL handed there instead — a middle
 * click too, whose new tab a webview cannot open either.
 */
export function createExternalLinkClickHandler(
  currentHref: () => string = () => location.href,
  toHost?: (url: string) => void,
): (event: MouseEvent) => void {
  return (event) => {
    if (event.defaultPrevented) return
    if (event.button !== 0 && !(toHost && event.button === 1)) return
    const anchor = findAnchor(event)
    if (!anchor || !prepareExternalAnchor(anchor, currentHref())) return
    const url = toHost ? safeHttpUrl(anchor.getAttribute("href") ?? "", currentHref()) : null
    if (!toHost || !url) return
    event.preventDefault()
    toHost(url)
  }
}

function hostOpens(url: string): void {
  postToHost({ type: "frizz:open-external", url })
}

export function installExternalLinkInterceptor(): () => void {
  const host = embedded()
  const handler = createExternalLinkClickHandler(undefined, host ? hostOpens : undefined)
  document.addEventListener("click", handler, true)
  if (host) document.addEventListener("auxclick", handler, true)
  return () => {
    document.removeEventListener("click", handler, true)
    document.removeEventListener("auxclick", handler, true)
  }
}

/**
 * Open a web page from code — a control that is not an anchor. A new tab in a browser; in an editor's
 * sidebar, the editor's `openExternal`. Only http(s) ever leaves.
 */
export function openExternalUrl(raw: string): void {
  const url = safeHttpUrl(raw, location.href)
  if (!url) return
  if (embedded()) hostOpens(url)
  else window.open(url, "_blank", "noreferrer,noopener")
}

// Nearest enclosing anchor with an href — via composedPath (crosses shadow boundaries) with a
// closest() fallback. Structural detection keeps this helper testable without a synthetic DOM.
function findAnchor(event: MouseEvent): HTMLAnchorElement | null {
  const path = typeof event.composedPath === "function" ? event.composedPath() : []
  for (const value of path) {
    if (isAnchor(value)) return value
  }
  const target = event.target as { closest?: (selector: string) => unknown } | null
  const closest = target?.closest?.("a[href]")
  return isAnchor(closest) ? closest : null
}

function isAnchor(value: unknown): value is HTMLAnchorElement {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<HTMLAnchorElement>
  return candidate.tagName?.toLowerCase() === "a"
    && typeof candidate.getAttribute === "function"
    && typeof candidate.setAttribute === "function"
    && typeof candidate.hasAttribute === "function"
    && candidate.hasAttribute("href")
}
