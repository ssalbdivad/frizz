// THE SIDEBAR'S PURE HALF — what the Frizz sidebar (sidebar.ts) frames, how it checks what the page
// says, which key chords it acts on, and where an editor command's selection goes. No `vscode` here, so
// every rule below is a unit test under plain node (embed.test.ts); sidebar.ts and app.ts are the glue.
// Design: plans/vscode-extension.md § The sidebar. The wire: packages/shared/src/embed-protocol.ts.

import { isAbsolute } from "node:path"
import {
  EMBED_PARAM,
  EMBED_PROTOCOL_VERSION,
  EMBED_THEME_PARAM,
  EMBED_VSCODE,
  type EmbedComposeMessage,
  type EmbedComposedMessage,
  type EmbedPageMessage,
  type EmbedTheme,
} from "@frizz/shared/embed-protocol"

// ── the frame's address ──────────────────────────────────────────────────────────────────────────────

/**
 * `vscode.ColorThemeKind` → the page's two themes. The enum's values (Light 1, Dark 2, HighContrast 3,
 * HighContrastLight 4) are stable API, spelled out here so this module needs no `vscode`.
 */
export function embedTheme(kind: number): EmbedTheme {
  return kind === 1 || kind === 4 ? "light" : "dark"
}

/** `<origin>/?embed=vscode&theme=dark&project=<slug>` — what the page reads once at boot. */
export function embedUrl(origin: string, theme: EmbedTheme, projectSlug: string | undefined): string {
  const url = new URL("/", origin)
  url.searchParams.set(EMBED_PARAM, EMBED_VSCODE)
  url.searchParams.set(EMBED_THEME_PARAM, theme)
  if (projectSlug) url.searchParams.set("project", projectSlug)
  return url.toString()
}

/** A URL's port as a number, its scheme's default when it names none (`new URL` drops a default port). */
function portOf(url: URL): number {
  if (url.port) return Number(url.port)
  return url.protocol === "https:" ? 443 : 80
}

export type FrameTarget =
  | { kind: "frame"; url: string; origin: string }
  /** The window would reach Frizz on another port, which every Frizz gate refuses. */
  | { kind: "remapped"; port: number; external: number }

/**
 * What the frame may load, given the URL Frizz was found at and what `env.asExternalUri` made of it.
 * Locally the two are the same; under Remote-WSL the host may come back as `localhost`, which Frizz
 * accepts (local-origin.ts). A different PORT is a tunnel Frizz does not know about: its gate requires
 * the request's port to be its own, so the page and every request it made would be refused — the view
 * says so instead of framing a page that cannot work.
 */
export function frameTarget(discovered: string, external: string): FrameTarget {
  const before = new URL(discovered)
  const after = new URL(external)
  if (portOf(before) !== portOf(after)) return { kind: "remapped", port: portOf(before), external: portOf(after) }
  return { kind: "frame", url: after.toString(), origin: after.origin }
}

/**
 * An origin fit to go verbatim into a CSP and a script: http(s), a host, maybe a port, and nothing a
 * policy or a string could be broken out of with. `URL.origin` always is; this is the belt to that.
 */
export function safeOrigin(origin: string): boolean {
  return /^https?:\/\/[A-Za-z0-9.\-[\]:]+$/u.test(origin) && new URL(origin).origin === origin
}

// ── what the page says ─────────────────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const isLine = (value: unknown) => value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10_000_000)
const MAX_FIELD = 8192

/**
 * A page → host message, checked field by field — the relay already took it only from its own frame at
 * Frizz's origin, and this is the second check the contract asks for. Anything unknown, misshapen or out
 * of bounds is `undefined`, which the sidebar ignores. Only the fields the contract names are kept.
 */
export function parsePageMessage(value: unknown): EmbedPageMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined
  switch (value.type) {
    case "frizz:ready":
      return value.v === EMBED_PROTOCOL_VERSION ? { type: "frizz:ready", v: EMBED_PROTOCOL_VERSION } : undefined
    case "frizz:composed": {
      if (typeof value.id !== "string" || !value.id || value.id.length > 200 || typeof value.ok !== "boolean") return undefined
      if (value.error !== undefined && (typeof value.error !== "string" || value.error.length > MAX_FIELD)) return undefined
      return { type: "frizz:composed", id: value.id, ok: value.ok, ...(typeof value.error === "string" ? { error: value.error } : {}) }
    }
    case "frizz:open-file": {
      const { path, line, column, endLine } = value
      if (typeof path !== "string" || !path || path.length > MAX_FIELD || path.includes("\0") || !(isAbsolute(path) || /^[A-Za-z]:[\\/]/u.test(path))) return undefined
      if (!isLine(line) || !isLine(column) || !isLine(endLine)) return undefined
      return {
        type: "frizz:open-file",
        path,
        ...(line === undefined ? {} : { line: line as number }),
        ...(column === undefined ? {} : { column: column as number }),
        ...(endLine === undefined ? {} : { endLine: endLine as number }),
      }
    }
    case "frizz:open-external": {
      if (typeof value.url !== "string" || value.url.length > MAX_FIELD) return undefined
      const url = webUrl(value.url)
      return url ? { type: "frizz:open-external", url } : undefined
    }
    case "frizz:key": {
      const { key, code, ctrl, meta, shift, alt } = value
      if (typeof key !== "string" || typeof code !== "string" || key.length > 64 || code.length > 64) return undefined
      if (typeof ctrl !== "boolean" || typeof meta !== "boolean" || typeof shift !== "boolean" || typeof alt !== "boolean") return undefined
      return { type: "frizz:key", key, code, ctrl, meta, shift, alt }
    }
    case "frizz:add-context": {
      const { what, path } = value
      if (what === "selection") return path === undefined ? { type: "frizz:add-context", what } : undefined
      if (what !== "file" || typeof path !== "string" || !path || path.length > MAX_FIELD || path.includes("\0")) return undefined
      if (!(isAbsolute(path) || /^[A-Za-z]:[\\/]/u.test(path))) return undefined
      return { type: "frizz:add-context", what, path }
    }
    case "frizz:route": {
      const { view, title, description } = value
      if (view !== "queue" && view !== "thread" && view !== "settings" && view !== "other") return undefined
      if (typeof title !== "string" || title.length > MAX_TITLE) return undefined
      if (description !== undefined && (typeof description !== "string" || description.length > MAX_TITLE)) return undefined
      return { type: "frizz:route", view, title, ...(description ? { description } : {}) }
    }
  }
  return undefined
}

/** A title or its reading longer than this is not one the title row could show anyway. */
const MAX_TITLE = 500

/** An http(s) URL with a host, normalized, or undefined: `javascript:`, `file:`, `command:` and the like never reach `openExternal`. */
export function webUrl(text: string): string | undefined {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return undefined
  return url.toString()
}

// ── key chords ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The chords the sidebar runs for the human while the frame has focus — where no VS Code keybinding can
 * see a key. Each is VS Code's own DEFAULT chord for the command, matched by `KeyboardEvent.code` (the
 * physical key, as VS Code dispatches on Linux and Windows), with exactly the modifiers listed. Kept to
 * getting around the workbench: the palette, quick open, the side bar, the panel and terminal, back to
 * the editor, and the built-in views. Nothing that edits, closes or runs anything is here.
 *
 * `primary` is Cmd on a Mac and Ctrl elsewhere; the terminal and source control are Ctrl on every
 * platform, as VS Code binds them.
 */
const CHORDS: readonly { chord: string; mac?: string; command: string }[] = [
  { chord: "primary+shift+KeyP", command: "workbench.action.showCommands" },
  { chord: "primary+KeyP", command: "workbench.action.quickOpen" },
  { chord: "primary+KeyB", command: "workbench.action.toggleSidebarVisibility" },
  { chord: "primary+KeyJ", command: "workbench.action.togglePanel" },
  { chord: "ctrl+Backquote", command: "workbench.action.terminal.toggleTerminal" },
  { chord: "primary+Digit1", command: "workbench.action.focusFirstEditorGroup" },
  { chord: "primary+shift+KeyE", command: "workbench.view.explorer" },
  { chord: "primary+shift+KeyF", command: "workbench.view.search" },
  { chord: "ctrl+shift+KeyG", command: "workbench.view.scm" },
  { chord: "primary+shift+KeyD", command: "workbench.view.debug" },
  { chord: "primary+shift+KeyX", command: "workbench.view.extensions" },
]

export interface KeyChord {
  code: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

/** The VS Code command a forwarded chord runs, or undefined for any chord the allowlist does not name. */
export function chordCommand(key: KeyChord, mac: boolean): string | undefined {
  for (const { chord, command } of CHORDS) {
    const parts = chord.split("+")
    const code = parts.pop()!
    const wants = { ctrl: false, meta: false, shift: false, alt: false }
    for (const part of parts) {
      if (part === "primary") wants[mac ? "meta" : "ctrl"] = true
      else wants[part as keyof typeof wants] = true
    }
    if (key.code === code && key.ctrl === wants.ctrl && key.meta === wants.meta && key.shift === wants.shift && key.alt === wants.alt) return command
  }
  return undefined
}

// ── where an editor command's selection goes ─────────────────────────────────────────────────────────

export interface SidebarReadiness {
  /** The `frizz.useSidebar` setting. */
  enabled: boolean
  /** The view has been opened in this window (and not closed since). */
  opened: boolean
  /** Its page said `frizz:ready` and is still the page in the frame. */
  ready: boolean
}

/**
 * "Add to Frizz prompt": into the sidebar's composer when the human has the sidebar in this window and
 * its page is listening; otherwise the server holds the item for a page to claim, as before the sidebar.
 * A window that never opened the sidebar keeps the browser flow — the selection should not appear in a
 * place the human has never looked.
 */
export function addRoute(sidebar: SidebarReadiness): "sidebar" | "server" {
  return sidebar.enabled && sidebar.opened && sidebar.ready ? "sidebar" : "server"
}

/**
 * "Ask Frizz…" and "Send to Frizz thread…": with the setting on, the sidebar's composer — it is revealed
 * (which opens it) and waited for — instead of a one-line input box. Text a caller passed as an argument
 * (a keybinding, another extension, a test) is a message to SEND, not a draft to write, so it keeps the
 * direct path that sends it.
 */
export function promptRoute(enabled: boolean, text: unknown): "sidebar" | "server" {
  return enabled && typeof text !== "string" ? "sidebar" : "server"
}

/** What `composeInSidebar` needs of the sidebar (sidebar.ts implements it). */
export interface ComposeSidebar {
  reveal(preserveFocus: boolean): Promise<void>
  waitReady(ms: number): Promise<boolean>
  compose(input: Omit<EmbedComposeMessage, "type" | "id">, ms: number): Promise<EmbedComposedMessage | undefined>
}

/**
 * Put a selection into a composer of the sidebar's page: bring the view into sight (opening it, the first
 * time), wait for its page, post the item and wait for the page's answer. Anything short of the page
 * saying it took the item — it never got ready, never answered, or refused — is `ok: false` with the
 * reason for the log, and the command then takes its path from before the sidebar, so a selection is
 * never simply lost.
 */
export async function composeInSidebar(
  sidebar: ComposeSidebar,
  input: Omit<EmbedComposeMessage, "type" | "id">,
  options: { preserveFocus: boolean; readyMs: number; composeMs: number },
): Promise<{ ok: true; id: string } | { ok: false; why: string }> {
  await sidebar.reveal(options.preserveFocus)
  if (!(await sidebar.waitReady(options.readyMs))) return { ok: false, why: "The Frizz sidebar didn't load in time." }
  const answer = await sidebar.compose(input, options.composeMs)
  if (!answer) return { ok: false, why: "The Frizz sidebar didn't answer." }
  if (!answer.ok) return { ok: false, why: `The Frizz sidebar couldn't take it: ${answer.error ?? "no reason given"}` }
  return { ok: true, id: answer.id }
}
