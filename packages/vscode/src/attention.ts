// WHEN A THREAD NEEDS YOU, AND THE SIDEBAR IS OUT OF SIGHT — what this window says, and how often.
//
// Frizz tells ONE window (editor-bridge.ts § attention): of the windows that listen and have the thread's
// project open, the one the human was in last. That window shows a VS Code notification unless the Frizz
// sidebar is in sight — the card is in front of the human already — with Open, which shows the thread in
// the sidebar. The page's own notifications cannot fire inside an editor (a framed page is refused the
// permission), so without this a question an agent asked while the human was in their code waited for
// them to happen to look at the badge.
//
// The words are the board's: the thread as the page names it, then what it needs — "has a question",
// "needs your approval", "is ready for you" — and the line the page's own notification would show.
//
// How often (AttentionGate): a burst of threads coming to rest at once — a fan-out finishing, a restart
// — must not stack a toast per thread over the editor. One notification at most every SPACING_MS; what
// arrives inside that is held and said together when it ends ("3 threads need you"). The same thread
// again inside REPEAT_MS is not news: it went out and came back (a side turn, an answer that raised
// another question at once), and the human was just told.
//
// Pure, no `vscode`: attention.test.ts drives the gate on a fake clock.

import type { EditorAttentionNeeds } from "@frizz/shared/editor-protocol"

export const SPACING_MS = 20_000
export const REPEAT_MS = 2 * 60_000
/** Characters of the thread's line in a notification; a toast is read in a glance. */
export const BODY_MAX = 160

export interface AttentionItem {
  /** The thread's slug, and its project's — what Open navigates the sidebar to. */
  slug: string
  projectSlug?: string
  /** The project's name, said only when the window has more than one project to tell apart. */
  projectName?: string
  /** The thread as the board names it (threads.ts displayTitle). */
  title: string
  needs: EditorAttentionNeeds
  body?: string
}

const NEEDS: Record<EditorAttentionNeeds, string> = {
  terminal: "is waiting for input in a terminal",
  approval: "needs your approval",
  question: "has a question",
  stopped: "stopped and needs you",
  limit: "hit a usage limit",
  ready: "is ready for you",
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/gu, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** `tidy-the-sample-loop has a question: Which branch should I merge into?` — one thread. */
export function attentionText(item: AttentionItem): string {
  const where = item.projectName ? ` in ${item.projectName}` : ""
  const said = item.body ? clip(item.body, BODY_MAX) : ""
  return `${item.title}${where} ${NEEDS[item.needs]}${said ? `: ${said}` : "."}`
}

/** `3 threads need you: a, b and c.` — several, held together. */
export function manyText(items: readonly AttentionItem[]): string {
  const names = items.map((item) => item.title)
  const shown = names.length <= 3 ? names : [...names.slice(0, 2), `${names.length - 2} more`]
  const list = shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`
  return `${items.length} threads need you: ${list}.`
}

export interface AttentionToast {
  /** One thread (Open shows it), or several (Open shows the queue). */
  items: AttentionItem[]
}

export class AttentionGate {
  readonly #spacingMs: number
  readonly #repeatMs: number
  #lastShownAt: number | undefined
  #held: AttentionItem[] = []
  /** When each thread was last said, by `project/slug`. */
  readonly #said = new Map<string, number>()

  constructor(options: { spacingMs?: number; repeatMs?: number } = {}) {
    this.#spacingMs = options.spacingMs ?? SPACING_MS
    this.#repeatMs = options.repeatMs ?? REPEAT_MS
  }

  /** A thread that needs the human: a toast to show now, or undefined (held for later, or not news). */
  offer(item: AttentionItem, now: number): AttentionToast | undefined {
    const key = `${item.projectSlug ?? ""}/${item.slug}`
    const said = this.#said.get(key)
    if (said !== undefined && now - said < this.#repeatMs) return undefined
    if (this.#held.some((held) => `${held.projectSlug ?? ""}/${held.slug}` === key)) return undefined
    if (this.#lastShownAt !== undefined && now - this.#lastShownAt < this.#spacingMs) {
      this.#held.push(item)
      return undefined
    }
    return this.#show([item], now)
  }

  /** When the held ones may be shown, or undefined when none are held. */
  dueAt(): number | undefined {
    return this.#held.length && this.#lastShownAt !== undefined ? this.#lastShownAt + this.#spacingMs : undefined
  }

  /** The held ones, together, once the spacing has passed; undefined before then or with none held. */
  due(now: number): AttentionToast | undefined {
    const at = this.dueAt()
    if (at === undefined || now < at) return undefined
    const items = this.#held
    this.#held = []
    return this.#show(items, now)
  }

  /** Drop what is held — the human brought the sidebar into sight, where every one of them shows. */
  clear(): void {
    this.#held = []
  }

  #show(items: AttentionItem[], now: number): AttentionToast {
    this.#lastShownAt = now
    for (const item of items) this.#said.set(`${item.projectSlug ?? ""}/${item.slug}`, now)
    for (const [key, at] of this.#said) if (now - at >= this.#repeatMs) this.#said.delete(key)
    return { items }
  }
}
