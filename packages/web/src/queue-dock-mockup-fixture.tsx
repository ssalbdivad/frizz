import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { Fragment, useEffect, useId, useLayoutEffect, useReducer, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react"
import {
  ArrowUp, Check, ChevronDown, ChevronUp, ChevronsDownUp, ExternalLink, FileText, GitPullRequest, Maximize2,
  MessageSquare, MessageSquarePlus, Paperclip, Pencil, RotateCcw, TerminalSquare, Trash2,
} from "lucide-react"
import type { ChatMessage } from "./hooks.ts"
import { Message, withMessageSpacers } from "./components/ChatView.tsx"
import { VSpace } from "./components/rhythm.tsx"
import { STATUS_BOX } from "./components/BoxSpinner.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { HEADER_ICON_CLASS } from "./lib/headerIcon.ts"
import { CHILD_ARROW, CHILD_ARROW_CLASS, CHILD_KIND_TAG_CLASS, CHILD_MARK_SLOT_CLASS } from "./lib/childOps.ts"
import {
  boxesOf, fullText, HIGHLIGHT_CSS, inUi, MESSAGES, offsetsToRange, paints, rangeToOffsets, repaint, S2, S3, trimmed,
  wireText, type Box, type PaintKind, type Seed,
} from "./inline-comments-mockup-kit.ts"
import "./styles.css"

// MOCKUP SHEET — THE QUEUE CARD WITH A STICKY PROMPT BOX, and the card's controls given one rule per edge.
//
// Not shipped UI and not a test. The ask (maintainer 2026-10-01, after the inline-comments sheet):
//   · a comment leaves its passage LIGHTLY HIGHLIGHTED YELLOW; hovering shows the comment in a popover;
//   · a pending count above the prompt box is useless on the queue, because the prompt box scrolls away
//     while the header is sticky — so consider a prompt box STICKY AT THE BOTTOM, as on /full;
//   · compress the card's bottom: the sub-agent / shell / file rows become a condensed count at the
//     UPPER RIGHT of the prompt box, details on hover;
//   · rethink where the context pie and the goal button live — "I'm not sure there's much logic to it".
//
// The transcript is the REAL Message renderer; the header, prompt box, op rows and lifecycle buttons are
// copies of TodosView's QueueCard / Composer / ChildOpRow / ThreadLifecycleFooter (the op rows import the
// real lib/childOps.ts tokens). The comment highlights use the shared kit's Highlight API engine.
//
//   http://localhost:5478/queue-dock-mockup-fixture.html   (?theme=light for the light palette)
const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = "sans"
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark"

const SHEET_CSS = `
:root { --ic-ink: var(--color-accent); --dock-shade: rgb(0 0 0 / 0.75); }
:root[data-theme="light"] { --ic-ink: #9a6a00; --dock-shade: rgb(0 0 0 / 0.14); }
`

// ── the cards ─────────────────────────────────────────────────────────────────────────────────────

type ActivityKind = "agent" | "shell" | "pr" | "file" | "link"
interface Activity { kind: ActivityKind; label: string; age?: string; live?: boolean; target?: string }

interface CardData {
  id: string
  title: string
  sub: string
  messages: ChatMessage[]
  activity: Activity[]
  context: number
  goal?: string
  retry?: boolean
}

const text = (sourceId: string, role: "user" | "assistant", body: string): ChatMessage => ({ sourceId, role, tools: [], text: body, parts: role === "user" ? [] : [{ kind: "text", text: body }] })

const CACHE: CardData = {
  id: "cache",
  title: "Fix the cache collision in the resolver",
  sub: "Last active 2m ago",
  messages: MESSAGES,
  context: 64,
  activity: [
    { kind: "agent", label: "Audit the other caches for the same collision", age: "4m", live: true },
    { kind: "shell", label: "Watch the resolver tests", age: "12m", live: true },
    { kind: "shell", label: "Run the dev server", age: "25m", live: true },
    { kind: "pr", label: "acme/app#391 — checks running", age: "6m", live: true },
    { kind: "file", label: "Resolver audit report" },
    { kind: "link", label: "Cache key migration plan", target: "docs.acme.dev/cache-keys" },
  ],
}

const PRICING: CardData = {
  id: "pricing",
  title: "Refactor the pricing parser",
  sub: "Last active 23m ago",
  retry: true,
  context: 31,
  goal: "Keep going until the tier-boundary audit is folded in",
  messages: [
    text("p1", "user", "Refactor the pricing parser and verify it end-to-end."),
    {
      sourceId: "p2",
      role: "assistant",
      text: "",
      tools: [],
      parts: [
        { kind: "tools", tools: [{ name: "Read", detail: "src/pricing/parser.ts" }, { name: "Bash", detail: "nub run dev", desc: "Start the dev server" }] },
        { kind: "text", text: "Audit dispatched and the dev server is up. I'll fold the findings in when the sub-agent reports back." },
      ],
    },
  ],
  activity: [{ kind: "agent", label: "Audit the pricing parser for tier-boundary rounding", age: "24m", live: true }],
}

const RELEASE: CardData = {
  id: "release",
  title: "Watch the release build",
  sub: "Last active 23m ago",
  context: 12,
  messages: [
    text("r1", "user", "Kick off the release build and keep an eye on it."),
    {
      sourceId: "r2",
      role: "assistant",
      text: "",
      tools: [],
      parts: [
        { kind: "tools", tools: [{ name: "Bash", detail: "nub run release", desc: "Run the release build" }] },
        { kind: "text", text: "Build is running in the background. Nothing to decide yet." },
      ],
    },
  ],
  activity: [{ kind: "shell", label: "Watch the release build", age: "23m", live: true }],
}

const CARDS = [CACHE, PRICING, RELEASE]

// ── small marks ───────────────────────────────────────────────────────────────────────────────────

// Tabler's target-arrow, the goal mark (RecurringPromptControl.tsx keeps the provenance).
function GoalGlyph({ size = 13, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
      <path d="M12 7a5 5 0 1 0 5 5" />
      <path d="M13 3.055a9 9 0 1 0 7.941 7.945" />
      <path d="M15 6v3h3l3 -3h-3v-3l-3 3" />
      <path d="M15 9l-3 3" />
    </svg>
  )
}

// ContextMeter's ring: same 16-unit grid, same 1.25 stroke, a filled arc for the share used.
function ContextRing({ percent, size = 15 }: { percent: number; size?: number }) {
  const r = 7.5 - 1.25 / 2
  const c = 2 * Math.PI * r
  return (
    <span title={`Context ${percent}% full`} className="flex shrink-0 items-center text-muted-60">
      <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden>
        <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.25" />
        <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray={`${(c * percent) / 100} ${c}`} transform="rotate(-90 8 8)" />
      </svg>
    </span>
  )
}

function ActivityMark({ kind, live }: { kind: ActivityKind; live?: boolean }) {
  if (kind === "file") return <FileText size={11} className="text-muted-55" />
  if (kind === "link") return <ExternalLink size={11} className="text-muted-55" />
  if (kind === "pr") return <GitPullRequest size={11} className="text-watch" />
  return <span className={`block h-1.5 w-1.5 rounded-full ${kind === "agent" ? "bg-accent" : "bg-shell"} ${live ? "animate-pulse" : ""}`} />
}

const TAG: Record<ActivityKind, string> = { agent: "Agent", shell: "Shell", pr: "PR", file: "File", link: "Link" }

// One ⤷ row, in the ChildOpRow grammar (the real lib/childOps.ts tokens).
function OpRow({ a }: { a: Activity }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 text-[11.5px] leading-[17.25px]">
      <span aria-hidden className={CHILD_ARROW_CLASS}>{CHILD_ARROW}</span>
      <span className={`${CHILD_MARK_SLOT_CLASS} self-center`}><ActivityMark kind={a.kind} live={a.live} /></span>
      <span className={CHILD_KIND_TAG_CLASS}>{TAG[a.kind]}</span>
      <span className="min-w-0 flex-1 truncate text-muted-70">{a.label}</span>
      {a.target && <span className="max-w-[40%] truncate font-mono-keep text-[10px] text-muted-45">{a.target}</span>}
      {a.age && <span className="shrink-0 tabular-nums text-[10.5px] text-muted-45">{a.age}</span>}
    </div>
  )
}

function summarize(items: readonly Activity[]) {
  const order: ActivityKind[] = ["agent", "shell", "pr", "file", "link"]
  const words: Record<ActivityKind, [string, string]> = { agent: ["agent", "agents"], shell: ["shell", "shells"], pr: ["PR", "PRs"], file: ["file", "files"], link: ["link", "links"] }
  return order
    .map((kind) => ({ kind, n: items.filter((a) => a.kind === kind).length, live: items.some((a) => a.kind === kind && a.live) }))
    .filter((g) => g.n > 0)
    .map((g) => ({ ...g, word: words[g.kind][g.n === 1 ? 0 : 1] }))
}

// THE CONDENSED ACTIVITY: one line of counts at the prompt box's upper right; the ⤷ rows on hover.
function ActivitySummary({ items, forceOpen, align = "right" }: { items: readonly Activity[]; forceOpen?: boolean; align?: "right" | "left" }) {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  if (!items.length) return null
  const show = forceOpen || open
  return (
    <div
      data-ic-ui
      className="relative"
      onMouseEnter={() => { clearTimeout(timer.current); setOpen(true) }}
      onMouseLeave={() => { timer.current = setTimeout(() => setOpen(false), 160) }}
    >
      <button type="button" className={`flex items-center gap-3 rounded-md px-1.5 py-0.5 text-[11.5px] transition-colors ${show ? "bg-panel-2 text-fg/85" : "text-muted-70 hover:bg-panel-2 hover:text-fg/85"}`}>
        {summarize(items).map((g) => (
          <span key={g.kind} className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="flex w-[11px] justify-center"><ActivityMark kind={g.kind} live={g.live} /></span>
            <span><span className="tabular-nums text-fg/85">{g.n}</span> {g.word}</span>
          </span>
        ))}
      </button>
      {show && (
        <div className={`absolute bottom-full z-40 mb-1.5 w-[420px] rounded-lg border border-border bg-elevated px-3 py-2 shadow-xl shadow-black/40 ${align === "right" ? "right-0" : "left-0"}`}>
          <div className="flex flex-col gap-0.5">
            {(["agent", "shell", "pr", "file", "link"] as const).flatMap((k) => items.filter((a) => a.kind === k)).map((a, i) => <OpRow key={i} a={a} />)}
          </div>
          <div className="mt-1.5 border-t border-border/70 pt-1.5 text-[10.5px] text-muted-55">Click a row to open it · × on hover stops or clears it</div>
        </div>
      )}
    </div>
  )
}

function PendingChip({ n, onNav }: { n: number; onNav: (dir: 1 | -1) => void }) {
  if (n === 0) return null
  return (
    <span data-ic-ui className="flex items-center text-[11.5px] text-[var(--ic-ink)]">
      <button type="button" title="Show the next pending comment" onClick={() => onNav(1)} className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-panel-2">
        <MessageSquare size={11.5} className="translate-y-px" />
        <span><span className="font-medium tabular-nums">{n}</span> pending comment{n === 1 ? "" : "s"}</span>
      </button>
      <button type="button" title="Previous comment" onClick={() => onNav(-1)} className="flex h-5 w-5 items-center justify-center rounded text-muted-60 hover:bg-panel-2 hover:text-fg"><ChevronUp size={12} /></button>
      <button type="button" title="Next comment" onClick={() => onNav(1)} className="flex h-5 w-5 items-center justify-center rounded text-muted-60 hover:bg-panel-2 hover:text-fg"><ChevronDown size={12} /></button>
    </span>
  )
}

function HeaderCount({ n, onNav }: { n: number; onNav: (dir: 1 | -1) => void }) {
  if (n === 0) return null
  return (
    <button type="button" data-ic-ui title={`${n} pending comment${n === 1 ? "" : "s"} — show the next`} onClick={() => onNav(1)} className="mr-1 flex h-7 items-center gap-1 rounded-md px-1.5 text-[12px] text-[var(--ic-ink)] hover:bg-panel-2">
      <MessageSquare size={13} className="translate-y-px" />
      <span className="font-medium tabular-nums">{n}</span>
    </button>
  )
}

const PILL = "rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] text-fg/80"
function LifecycleButtons() {
  return (
    <span className="flex items-center gap-2">
      <span className="inline-flex items-stretch rounded-md border border-border-strong bg-panel-2/60 text-[12px]">
        <span className="flex items-center rounded-l-md px-2.5 py-1 font-medium text-fg/75">Snooze 1d</span>
        <span aria-hidden className="my-1 w-px bg-border" />
        <span className="flex items-center px-2 text-fg/75"><ChevronDown size={12} /></span>
      </span>
      <span className={`flex items-center gap-1 font-medium ${PILL}`}><Check size={12} />Mark as done</span>
    </span>
  )
}

function ProfileChips() {
  const chip = "inline-flex items-center gap-[3px] rounded-md border border-border/50 px-2 py-1 text-muted"
  return (
    <>
      <span className={chip}><span className="petite-caps text-[11px] tracking-wide">Opus 5 › high</span><ChevronDown size={12} className="text-fg/65" /></span>
      <span className={`${chip} opacity-70`}><span className="petite-caps text-[11px] tracking-wide">Auto</span><ChevronDown size={12} className="text-fg/65" /></span>
    </>
  )
}

// The goal, as a prompt box control: a bare mark while unset; a lit chip saying what it does once armed.
function GoalChip({ goal }: { goal?: string }) {
  if (!goal) {
    return <span title="Set a goal — a standing instruction sent each time the worker rests" className="flex h-[26px] w-[26px] items-center justify-center rounded-md text-muted-60 hover:bg-panel-2 hover:text-fg"><GoalGlyph size={13} /></span>
  }
  return (
    <span title={`Goal: ${goal}`} className="inline-flex min-w-0 items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-accent">
      <GoalGlyph size={12} className="shrink-0" />
      <span className="petite-caps truncate text-[11px] tracking-wide">Goal · each rest</span>
    </span>
  )
}

interface PromptBoxProps {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  placeholder: string
  goal?: string | false
  context?: number | false
  sendCount?: number
}
function PromptBox({ value, onChange, onSend, placeholder, goal, context, sendCount = 0 }: PromptBoxProps) {
  const enabled = Boolean(value.trim()) || sendCount > 0
  return (
    <div className="group relative rounded-xl border border-border bg-bg transition-colors focus-within:border-accent">
      <textarea
        value={value}
        rows={2}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
            e.preventDefault()
            onSend()
          }
        }}
        className="block w-full resize-none bg-transparent px-3.5 pb-1 pt-2.5 text-[13px] leading-relaxed text-fg outline-none placeholder:text-muted"
      />
      <div className="flex min-w-0 items-center gap-1 pb-1.5 pl-1.5 pr-2">
        <ProfileChips />
        {goal !== false && <GoalChip goal={goal} />}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {context !== false && context !== undefined && <span className="mr-1"><ContextRing percent={context} /></span>}
          <span className="flex h-7 w-7 items-center justify-center rounded-lg text-muted"><Paperclip size={15} strokeWidth={2} /></span>
          <button
            type="button"
            title={sendCount ? `Send with ${sendCount} comment${sendCount === 1 ? "" : "s"}` : "Send"}
            onClick={onSend}
            className={`flex h-7 w-7 items-center justify-center rounded-lg transition-all ${enabled ? "bg-fg text-bg hover:opacity-90 active:scale-95" : "bg-panel-2 text-muted"}`}
          >
            <ArrowUp size={14} strokeWidth={2.5} />
          </button>
        </span>
      </div>
    </div>
  )
}

// ── comments: a light yellow highlight, the words in a hover popover ────────────────────────────────

interface LayerComment { id: string; start: number; end: number; quote: string; text: string; status: "draft" | "pending" | "sent"; prevText?: string; fresh?: boolean }
interface SentNote { id: string; note: string; items: { id: string; quote: string; text: string }[] }
let seq = 0
const nextId = () => `q${++seq}`

interface LayerOptions { seeds?: Seed[]; openSeed?: number; selectQuote?: string; draft?: Seed }

function useCommentLayer(rootRef: RefObject<HTMLDivElement | null>, scrollerRef: RefObject<HTMLDivElement | null>, opts: LayerOptions) {
  const key = useId()
  const [comments, setComments] = useState<LayerComment[]>([])
  const [sent, setSent] = useState<SentNote[]>([])
  const [geo, setGeo] = useState<{ boxes: Record<string, Box[]>; sel: Box[]; w: number }>({ boxes: {}, sel: [], w: 0 })
  const [openId, setOpenId] = useState<string | null>(null)
  const [pinned, setPinned] = useState(false)
  const [toolbar, setToolbar] = useState<{ start: number; end: number; fake?: boolean } | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const seeded = useRef(false)
  const [, bump] = useReducer((x: number) => x + 1, 0)

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || seeded.current) return
    seeded.current = true
    const all = fullText(root)
    const made: LayerComment[] = []
    for (const s of [...(opts.seeds ?? []), ...(opts.draft ? [opts.draft] : [])]) {
      const at = all.indexOf(s.quote)
      if (at < 0) continue
      const draft = s === opts.draft
      made.push({ id: nextId(), start: at, end: at + s.quote.length, quote: s.quote, text: draft ? "" : s.text, prevText: undefined, status: draft ? "draft" : "pending" })
    }
    setComments(made)
    const draft = made.find((c) => c.status === "draft")
    if (draft) { setOpenId(draft.id); setPinned(true) }
    else if (opts.openSeed !== undefined && made[opts.openSeed]) { setOpenId(made[opts.openSeed].id); setPinned(true) }
    if (opts.selectQuote) {
      const at = all.indexOf(opts.selectQuote)
      if (at >= 0) setToolbar({ start: at, end: at + opts.selectQuote.length, fake: true })
    }
  }, [])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const ro = new ResizeObserver(() => bump())
    ro.observe(root)
    void document.fonts.ready.then(() => bump())
    return () => {
      ro.disconnect()
      paints.delete(key)
      repaint()
    }
  }, [key])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const boxes: Record<string, Box[]> = {}
    const paint: Partial<Record<PaintKind, Range[]>> = {}
    for (const c of comments) {
      const r = offsetsToRange(root, c.start, c.end)
      if (!r) continue
      boxes[c.id] = boxesOf(root, r)
      const kind: PaintKind = c.status === "sent" ? (c.id === openId ? "soft" : "sent") : c.status === "draft" || c.id === openId ? "soft-active" : "soft"
      ;(paint[kind] ??= []).push(r)
    }
    let sel: Box[] = []
    if (toolbar) {
      const r = offsetsToRange(root, toolbar.start, toolbar.end)
      if (r) {
        sel = boxesOf(root, r)
        if (toolbar.fake) (paint.fakesel ??= []).push(r)
      }
    }
    paints.set(key, paint)
    repaint()
    const next = { boxes, sel, w: root.clientWidth }
    setGeo((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
  })

  useEffect(() => {
    const onSelection = () => {
      const root = rootRef.current
      const s = window.getSelection()
      if (!root) return
      if (!s || s.isCollapsed || !s.rangeCount) return setToolbar((t) => (t && !t.fake ? null : t))
      const r = s.getRangeAt(0)
      if (!root.contains(r.commonAncestorContainer) || inUi(r.startContainer) || inUi(r.endContainer)) return setToolbar((t) => (t && !t.fake ? null : t))
      const offs = rangeToOffsets(root, r)
      if (!offs) return
      const [start, end] = trimmed(root, offs)
      if (end > start) setToolbar({ start, end })
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && pinned) { setPinned(false); setOpenId(null); return }
      if (e.key.toLowerCase() !== "i" || !(e.metaKey || e.ctrlKey)) return
      const root = rootRef.current
      const s = window.getSelection()
      if (!root || !s || s.isCollapsed || !s.rangeCount || !root.contains(s.getRangeAt(0).commonAncestorContainer)) return
      e.preventDefault()
      const offs = rangeToOffsets(root, s.getRangeAt(0))
      if (offs) createDraft(...trimmed(root, offs))
    }
    document.addEventListener("selectionchange", onSelection)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("selectionchange", onSelection)
      document.removeEventListener("keydown", onKey)
    }
  })

  function createDraft(start: number, end: number) {
    const root = rootRef.current
    if (!root) return
    const quote = fullText(root).slice(start, end).replace(/\s+/g, " ")
    const id = nextId()
    setComments((cs) => [...cs.filter((c) => c.status !== "draft" || c.prevText !== undefined), { id, start, end, quote, text: "", status: "draft", fresh: true }])
    setOpenId(id)
    setPinned(true)
    setToolbar(null)
    window.getSelection()?.removeAllRanges()
  }

  const pending = comments.filter((c) => c.status === "pending").sort((a, b) => a.start - b.start)

  function hit(e: ReactMouseEvent): string | null {
    const root = rootRef.current
    if (!root) return null
    const o = root.getBoundingClientRect()
    const x = e.clientX - o.left
    const y = e.clientY - o.top
    for (const c of comments) {
      if (c.status === "draft") continue
      if (geo.boxes[c.id]?.some((b) => x >= b.left - 1 && x <= b.left + b.width + 1 && y >= b.top - 1 && y <= b.top + b.height + 1)) return c.id
    }
    return null
  }
  const cancelClose = () => clearTimeout(closeTimer.current)
  const scheduleClose = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setOpenId((id) => (pinned ? id : null)), 180)
  }

  function reveal(id: string) {
    const root = rootRef.current
    const sc = scrollerRef.current
    const b = geo.boxes[id]?.[0]
    if (!root || !sc || !b) return
    const top = root.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop + b.top - sc.clientHeight * 0.35
    sc.scrollTo({ top, behavior: "smooth" })
  }

  function nav(dir: 1 | -1) {
    if (!pending.length) return
    const at = pending.findIndex((c) => c.id === openId)
    const next = pending[at < 0 ? (dir > 0 ? 0 : pending.length - 1) : (at + dir + pending.length) % pending.length]
    setOpenId(next.id)
    setPinned(true)
    reveal(next.id)
  }

  function send(note: string) {
    if (!note.trim() && !pending.length) return false
    const id = nextId()
    const ids = new Set(pending.map((c) => c.id))
    setSent((s) => [...s, { id, note: note.trim(), items: pending.map((c) => ({ id: c.id, quote: c.quote, text: c.text })) }])
    setComments((cs) => cs.map((c) => (ids.has(c.id) ? { ...c, status: "sent" } : c)))
    setOpenId(null)
    setPinned(false)
    return true
  }

  const save = (id: string, t: string) => {
    setComments((cs) => cs.map((c) => (c.id === id ? { ...c, text: t, status: "pending", prevText: undefined, fresh: false } : c)))
    setPinned(false)
    setOpenId(null)
  }
  const cancel = (id: string) => {
    setComments((cs) => cs.flatMap((c) => (c.id !== id ? [c] : c.prevText !== undefined ? [{ ...c, status: "pending" as const, prevText: undefined }] : [])))
    setPinned(false)
    setOpenId(null)
  }

  const open = comments.find((c) => c.id === openId)
  const ob = open && geo.boxes[open.id]
  let popoverAbove = false
  if (ob?.length && rootRef.current && scrollerRef.current) {
    const r = rootRef.current.getBoundingClientRect()
    const last = ob[ob.length - 1]
    popoverAbove = r.top + last.top + last.height + 6 + 130 > scrollerRef.current.getBoundingClientRect().bottom - 190
  }
  const selBox = geo.sel.length
    ? { left: Math.min(...geo.sel.map((b) => b.left)), right: Math.max(...geo.sel.map((b) => b.left + b.width)), top: Math.min(...geo.sel.map((b) => b.top)) }
    : null

  const overlay = (
    <>
      {open && ob && ob.length > 0 && (
        <div
          data-ic-ui
          onMouseEnter={cancelClose}
          onMouseLeave={() => { if (!pinned) scheduleClose() }}
          className="absolute z-40 w-[320px] rounded-lg border border-border-strong bg-elevated px-3 py-2.5 shadow-xl shadow-black/40"
          style={{
            left: Math.max(0, Math.min(ob[0].left - 8, geo.w - 320)),
            // Under the passage, unless that would run into the docked prompt box: then above it.
            ...(popoverAbove ? { top: ob[0].top - 6, transform: "translateY(-100%)" } : { top: ob[ob.length - 1].top + ob[ob.length - 1].height + 6 }),
          }}
        >
          {open.status === "draft" ? (
            <Editor initial={open.prevText ?? open.text} editing={open.prevText !== undefined} focus={open.fresh} onSave={(t) => save(open.id, t)} onCancel={() => cancel(open.id)} />
          ) : (
            <>
              <div className="mb-1 flex h-5 items-center gap-1.5 text-[11px] text-muted-65">
                <MessageSquare size={11} className="translate-y-px text-[var(--ic-ink)]" />
                <span className="petite-caps tracking-wide">{open.status === "sent" ? "Sent" : "Pending · goes with your next send"}</span>
                {open.status === "pending" && (
                  <span className="ml-auto flex items-center">
                    <button type="button" title="Edit" onClick={() => { setComments((cs) => cs.map((c) => (c.id === open.id ? { ...c, status: "draft", prevText: c.text, fresh: true } : c))); setPinned(true) }} className="flex h-5 w-5 items-center justify-center rounded text-muted-60 hover:bg-panel-2 hover:text-fg"><Pencil size={11} /></button>
                    <button type="button" title="Delete" onClick={() => { setComments((cs) => cs.filter((c) => c.id !== open.id)); setOpenId(null); setPinned(false) }} className="flex h-5 w-5 items-center justify-center rounded text-muted-60 hover:bg-panel-2 hover:text-fg"><Trash2 size={11} /></button>
                  </span>
                )}
              </div>
              <div className="whitespace-pre-wrap text-[13px] leading-[19px] text-fg/90">{open.text}</div>
            </>
          )}
        </div>
      )}
      {toolbar && selBox && (
        <div data-ic-ui onMouseDown={(e) => e.preventDefault()} className="absolute z-30 flex items-center rounded-lg border border-border-strong bg-elevated p-0.5 shadow-lg shadow-black/40" style={{ left: Math.max(0, Math.min((selBox.left + selBox.right) / 2 - 62, geo.w - 128)), top: selBox.top - 38 }}>
          <button type="button" onClick={() => createDraft(toolbar.start, toolbar.end)} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-fg/90 hover:bg-panel-2">
            <MessageSquarePlus size={13} />Comment<kbd className="ml-1 font-sans text-[10.5px] font-normal text-muted-60">⌘I</kbd>
          </button>
        </div>
      )}
    </>
  )

  return {
    pending,
    sent,
    overlay,
    nav,
    send,
    hovering: Boolean(openId && !pinned),
    rootHandlers: {
      onMouseMove: (e: ReactMouseEvent) => {
        const id = hit(e)
        if (id) {
          cancelClose()
          if (!pinned && id !== openId) setOpenId(id)
        } else if (openId && !pinned) scheduleClose()
      },
      onMouseLeave: () => { if (!pinned) scheduleClose() },
      onClick: (e: ReactMouseEvent) => {
        const s = window.getSelection()
        if ((s && !s.isCollapsed) || inUi(e.target as Node)) return
        const id = hit(e)
        if (id) { setOpenId(id); setPinned(true) }
        else if (pinned) { setPinned(false); setOpenId(null) }
      },
    },
  }
}

function Editor({ initial, editing, focus, onSave, onCancel }: { initial: string; editing?: boolean; focus?: boolean; onSave: (t: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (focus) ref.current?.focus({ preventScroll: true }) }, [focus])
  return (
    <div data-ic-ui>
      <textarea
        ref={ref}
        rows={2}
        value={value}
        placeholder="Comment on this passage…"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (value.trim()) onSave(value.trim()) }
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel() }
        }}
        className="block w-full resize-none bg-transparent text-[13px] leading-[19px] text-fg outline-none placeholder:text-muted"
      />
      <div className="mt-2 flex items-center gap-1">
        <span className="mr-auto text-[10.5px] text-muted-55">⌘⏎ adds · Esc cancels</span>
        <button type="button" onClick={onCancel} className="rounded-md px-2 py-1 text-[12px] text-muted hover:bg-panel-2 hover:text-fg">Cancel</button>
        <button type="button" disabled={!value.trim()} onClick={() => onSave(value.trim())} className="rounded-md bg-fg px-2.5 py-1 text-[12px] font-medium text-bg hover:opacity-90 disabled:opacity-30">{editing ? "Save" : "Add comment"}</button>
      </div>
    </div>
  )
}

function SentBubble({ s }: { s: SentNote }) {
  return (
    <div className="flex max-w-[85%] flex-col items-end self-end">
      <div className="rounded-xl rounded-br-sm bg-user-bubble px-3.5 py-3 text-[14px] leading-[20px] text-user-bubble-fg">
        {s.note && <p className="whitespace-pre-wrap">{s.note}</p>}
        {s.note && s.items.length > 0 && <div className="my-2.5 h-px bg-bg/15" />}
        <div className="flex flex-col gap-2.5">
          {s.items.map((it) => (
            <div key={it.id}>
              <span className="line-clamp-2 block border-l-2 border-bg/25 pl-2 text-[12px] leading-[17px] text-user-bubble-fg/60">{it.quote}</span>
              <p className="mt-1 whitespace-pre-wrap">{it.text}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── the card ──────────────────────────────────────────────────────────────────────────────────────

type Layout = "today" | "dock" | "header" | "page"
type ContextAt = "box" | "header" | "tabs"

interface CardApi { pending: number; send: (note: string) => boolean; nav: (dir: 1 | -1) => void }

interface CardProps {
  data: CardData
  layout: Layout
  scrollerRef: RefObject<HTMLDivElement | null>
  layer?: LayerOptions
  contextAt?: ContextAt
  activityOpen?: boolean
  targeted?: boolean
  onTarget?: (id: string) => void
  register?: (id: string, api: CardApi) => void
  onPending?: (id: string, n: number) => void
}

function QueueCard({ data, layout, scrollerRef, layer: layerOpts = {}, contextAt = "box", activityOpen, targeted, onTarget, register, onPending }: CardProps) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const layer = useCommentLayer(bodyRef, scrollerRef, layerOpts)
  const [draft, setDraft] = useState("")
  const n = layer.pending.length
  register?.(data.id, { pending: n, send: layer.send, nav: layer.nav })
  useEffect(() => { onPending?.(data.id, n) }, [n])
  const send = () => { if (layer.send(draft)) setDraft("") }
  const sticky = layout === "dock" || layout === "header"
  return (
    <div
      data-card={data.id}
      onPointerDown={() => onTarget?.(data.id)}
      className={`relative flex min-w-0 flex-col rounded-xl border bg-panel shadow-lg shadow-shadow-ink/25 transition-[border-color] ${targeted ? "border-accent/45" : "border-border-strong"}`}
    >
      <CardHeader data={data} pending={n} onNav={layer.nav} lifecycle={layout === "header"} contextAt={contextAt} />
      <div ref={bodyRef} data-ic-root className="relative flex flex-col px-5 pb-5 pt-5" {...layer.rootHandlers}>
        {withMessageSpacers(data.messages, (m) => <Message key={m.sourceId} m={m} />)}
        {layer.sent.map((s) => (
          <Fragment key={s.id}>
            <VSpace h={18} />
            <SentBubble s={s} />
          </Fragment>
        ))}
        {layer.overlay}
      </div>
      {layout === "today" && <TodayBottom data={data} draft={draft} setDraft={setDraft} send={send} />}
      {sticky && (
        <div
          className={`${sticky ? "sticky bottom-0" : ""} z-30 rounded-b-[11px] border-t border-border/60 bg-panel px-5 pb-3 pt-1 shadow-[0_-12px_18px_-14px_var(--dock-shade)]`}
        >
          <TabRow data={data} pending={n} onNav={layer.nav} activityOpen={activityOpen} contextAt={contextAt} />
          <PromptBox
            value={draft}
            onChange={setDraft}
            onSend={send}
            sendCount={n}
            placeholder={n ? `Add a note to go with ${n === 1 ? "the comment" : `the ${n} comments`} (optional)…` : "Reply to the agent…"}
            goal={contextAt === "tabs" ? false : data.goal}
            context={contextAt === "box" ? data.context : false}
          />
          {layout === "dock" && (
            <div className="flex items-center justify-end pt-2.5">
              <LifecycleButtons />
            </div>
          )}
        </div>
      )}
      {layout === "page" && (
        <div className="flex min-h-10 items-center gap-3 rounded-b-[11px] border-t border-border/60 px-4 py-2">
          <ActivitySummary items={data.activity} align="left" />
          <PendingChip n={n} onNav={layer.nav} />
          <span className="ml-auto"><LifecycleButtons /></span>
        </div>
      )}
    </div>
  )
}

function CardHeader({ data, pending, onNav, lifecycle, contextAt }: { data: CardData; pending: number; onNav: (dir: 1 | -1) => void; lifecycle: boolean; contextAt: ContextAt }) {
  return (
    <div className="sticky top-0 z-20 flex items-center gap-2 rounded-t-[11px] border-b border-border/60 bg-panel px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold leading-snug text-fg/95">{data.title}</div>
        <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] leading-tight text-muted-75">
          {data.sub}
          {contextAt === "header" && (
            <>
              <span className="text-muted-45">·</span>
              <ContextRing percent={data.context} size={11} />
              <span>{data.context}% context</span>
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <HeaderCount n={pending} onNav={onNav} />
        <span className={HEADER_ICON_CLASS}><TerminalSquare size={14} strokeWidth={2} /></span>
        <span className={HEADER_ICON_CLASS}><ChevronsDownUp size={14} strokeWidth={2} /></span>
        <span className={HEADER_ICON_CLASS}><Maximize2 size={13} strokeWidth={2} /></span>
        {data.retry && (
          <span className="ml-1.5 flex items-center gap-1.5 rounded-md border border-accent/45 bg-accent/10 px-2.5 py-1 text-[12px] font-medium text-accent"><RotateCcw size={12} />Retry</span>
        )}
        {lifecycle && (
          <>
            <span className="mx-2 h-4 w-px bg-border" />
            <LifecycleButtons />
          </>
        )}
      </div>
    </div>
  )
}

// The row that rides the prompt box's top edge: what is pending from YOU on the left, what is live
// under the WORKER on the right.
function TabRow({ data, pending, onNav, activityOpen, contextAt }: { data: CardData; pending: number; onNav: (dir: 1 | -1) => void; activityOpen?: boolean; contextAt: ContextAt }) {
  return (
    <div className="flex h-7 min-w-0 items-center gap-3 px-0.5">
      <PendingChip n={pending} onNav={onNav} />
      {contextAt === "tabs" && (
        <span className="flex items-center gap-3 text-[11.5px] text-muted-70">
          <span className="flex items-center gap-1.5"><ContextRing percent={data.context} size={12} />{data.context}% context</span>
          {data.goal && <span className="flex min-w-0 items-center gap-1.5 text-accent"><GoalGlyph size={11.5} /><span className="truncate">Goal each rest</span></span>}
        </span>
      )}
      <span className="ml-auto"><ActivitySummary items={data.activity} forceOpen={activityOpen} /></span>
    </div>
  )
}

// TODAY: the prompt box, every live op as its own ⤷ row, then the lifecycle strip — all at the card's end.
function TodayBottom({ data, draft, setDraft, send }: { data: CardData; draft: string; setDraft: (v: string) => void; send: () => void }) {
  return (
    <>
      <div className="px-5 pb-3">
        <PromptBox value={draft} onChange={setDraft} onSend={send} placeholder="Reply to the agent…" goal={false} context={false} />
        <div className="flex flex-col gap-0.5 px-1 pt-1.5">
          {data.activity.filter((a) => a.kind !== "file" && a.kind !== "link").map((a, i) => <OpRow key={i} a={a} />)}
        </div>
        {data.activity.some((a) => a.kind === "file" || a.kind === "link") && (
          <div className="mt-2 flex flex-col gap-0.5 border-t border-border px-1 pt-1.5">
            {data.activity.filter((a) => a.kind === "file" || a.kind === "link").map((a, i) => <OpRow key={i} a={a} />)}
          </div>
        )}
      </div>
      <footer className="flex min-h-10 items-center justify-end gap-3 rounded-b-[11px] border-t border-border/70 bg-panel/95 px-3 py-2 text-[12px]">
        <span className="mr-auto flex items-center gap-3">
          <ContextRing percent={data.context} />
          <span className={data.goal ? "text-accent" : "text-muted-60"}><GoalGlyph size={12} /></span>
        </span>
        <LifecycleButtons />
      </footer>
    </>
  )
}

// ── the queue page, scrollable ────────────────────────────────────────────────────────────────────

function StatusBox({ children }: { children?: ReactNode }) {
  return <span className="inline-flex items-center justify-center rounded-[4px] border border-muted/45" style={{ width: STATUS_BOX, height: STATUS_BOX }}>{children}</span>
}

function SidebarGhost({ pendingByCard }: { pendingByCard: Record<string, number> }) {
  const atRest = <StatusBox><span className="h-[3px] w-[3px] rounded-full bg-muted-70 shadow-[4px_0_0_var(--color-muted-70),-4px_0_0_var(--color-muted-70)]" /></StatusBox>
  return (
    <aside className="w-[280px] pt-5">
      <div className="mb-5 h-[92px] rounded-lg border border-border bg-panel px-3 py-2.5 text-[13px] text-muted-40">Describe the task…</div>
      <div className="flex items-center gap-1.5 px-1.5 py-1 text-[11px] uppercase tracking-wide text-muted-70">Queue<span className="tabular-nums text-muted-60">3</span></div>
      {CARDS.map((c) => (
        <div key={c.id} className="flex min-w-0 items-start gap-2 rounded-md py-1 pl-3 pr-1.5 hover:bg-white/[0.04]">
          <span className="flex h-[19px] w-4 shrink-0 items-center justify-center">{c.retry ? <StatusBox><span className="text-[9px] font-bold leading-none text-accent">!</span></StatusBox> : atRest}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] leading-[19px] text-fg/90">{c.title}</span>
          {pendingByCard[c.id] ? (
            <span title="Unsent comments" className="flex h-[19px] shrink-0 items-center gap-[3px] text-[10.5px] font-medium tabular-nums text-[var(--ic-ink)]"><MessageSquare size={10} strokeWidth={2.4} />{pendingByCard[c.id]}</span>
          ) : null}
          <span className="h-[19px] shrink-0 text-[10.5px] leading-[19px] tabular-nums text-muted-55">{c.sub.replace("Last active ", "").replace(" ago", "")}</span>
        </div>
      ))}
    </aside>
  )
}

function QueueViewport({ layout, height = 780, seeds = [S2, S3], contextAt = "box" }: { layout: Layout; height?: number; seeds?: Seed[]; contextAt?: ContextAt }) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const apis = useRef(new Map<string, CardApi>())
  const [target, setTarget] = useState(CARDS[0].id)
  const [pendingByCard, setPendingByCard] = useState<Record<string, number>>({})
  const [pageText, setPageText] = useState("")
  const register = (id: string, api: CardApi) => { apis.current.set(id, api) }
  // Each card reports its pending count up, for the rail and the page dock.
  const onPending = (id: string, n: number) => setPendingByCard((prev) => (prev[id] === n ? prev : { ...prev, [id]: n }))
  // C · the page dock answers whichever card crosses the line 45% down the viewport.
  useEffect(() => {
    const sc = scrollerRef.current
    if (!sc || layout !== "page") return
    const onScroll = () => {
      const line = sc.getBoundingClientRect().top + sc.clientHeight * 0.45
      for (const el of sc.querySelectorAll<HTMLElement>("[data-card]")) {
        const r = el.getBoundingClientRect()
        if (r.top <= line && r.bottom >= line) { setTarget(el.dataset.card!); return }
      }
    }
    sc.addEventListener("scroll", onScroll, { passive: true })
    onScroll()
    return () => sc.removeEventListener("scroll", onScroll)
  }, [layout])
  const targetCard = CARDS.find((c) => c.id === target) ?? CARDS[0]
  const targetPending = pendingByCard[target] ?? 0
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-bg" style={{ width: 1100, height }}>
      <div ref={scrollerRef} className="absolute inset-0 overflow-y-auto">
        <div className="flex items-start gap-9 pl-7 pr-7">
          <div className="sticky top-0"><SidebarGhost pendingByCard={pendingByCard} /></div>
          <div className="flex w-[720px] min-w-0 flex-col gap-10 py-5" style={{ paddingBottom: layout === "page" ? 190 : 60 }}>
            {CARDS.map((c, i) => (
              <QueueCard
                key={c.id}
                data={c}
                layout={layout}
                scrollerRef={scrollerRef}
                layer={i === 0 ? { seeds } : {}}
                contextAt={contextAt}
                targeted={layout === "page" && target === c.id}
                onTarget={layout === "page" ? setTarget : undefined}
                register={register}
                onPending={onPending}
              />
            ))}
          </div>
        </div>
      </div>
      {layout === "page" && (
        <div className="pointer-events-none absolute bottom-0 left-[344px] w-[720px]">
          <div className="h-6 bg-gradient-to-t from-bg to-transparent" />
          <div className="pointer-events-auto bg-bg pb-4">
            <div className="flex h-7 items-center gap-3 px-0.5">
              <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-70">
                <span className="text-muted-50">Replying to</span>
                <span className="truncate font-medium text-fg/85">{targetCard.title}</span>
              </span>
              <PendingChip n={targetPending} onNav={(d) => apis.current.get(target)?.nav(d)} />
            </div>
            <PromptBox
              value={pageText}
              onChange={setPageText}
              onSend={() => { if (apis.current.get(target)?.send(pageText)) setPageText("") }}
              sendCount={targetPending}
              placeholder={`Reply to “${targetCard.title}”…`}
              goal={targetCard.goal}
              context={targetCard.context}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// A single card, scrolled to its end, inside a fixed window — for side-by-side comparison.
function CardEnd({ data, layout, height = 560, layer, contextAt, activityOpen, scroll = "end" }: { data: CardData; layout: Layout; height?: number | "fit"; layer?: LayerOptions; contextAt?: ContextAt; activityOpen?: boolean; scroll?: "end" | "middle" }) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const sc = scrollerRef.current
    if (!sc || height === "fit") return
    const settle = () => { sc.scrollTop = scroll === "end" ? sc.scrollHeight : sc.scrollHeight * 0.3 }
    settle()
    const t = setTimeout(settle, 400)
    return () => clearTimeout(t)
  }, [scroll, height])
  const card = <QueueCard data={data} layout={layout} scrollerRef={scrollerRef} layer={layer} contextAt={contextAt} activityOpen={activityOpen} />
  // The dashed edge is the screen, the solid one the card. A short card gets a frame that fits it, so
  // nothing scrolls and no half-message peeks out under the sticky header.
  if (height === "fit") {
    return (
      <div ref={scrollerRef} className="relative overflow-hidden rounded-xl border border-dashed border-muted-45 bg-bg p-4" style={{ width: 754 }}>
        {card}
      </div>
    )
  }
  return (
    <div className="relative overflow-hidden rounded-xl border border-dashed border-muted-45 bg-bg" style={{ width: 754, height }}>
      {/* The padding is on an inner box, never the scroller: Chrome insets the sticky rectangle by the
          scroller's own padding, so a padded scroller pins the header 16px down with text showing above it. */}
      <div ref={scrollerRef} className="absolute inset-0 overflow-y-auto [scrollbar-width:none]">
        <div className="p-4">{card}</div>
      </div>
    </div>
  )
}

// ── the sheet ─────────────────────────────────────────────────────────────────────────────────────

function Section({ id, title, note, children }: { id: string; title: string; note: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="mb-16 scroll-mt-20">
      <h2 className="mb-1 text-[16px] font-semibold tracking-tight text-fg/95">{title}</h2>
      <div className="mb-6 max-w-[900px] text-[12.5px] leading-[19px] text-muted">{note}</div>
      <div className="flex flex-wrap items-start gap-x-10 gap-y-12">{children}</div>
    </section>
  )
}
function Candidate({ letter, title, note, pick, children }: { letter: string; title: string; note: ReactNode; pick?: boolean; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline gap-2">
        {letter && <span className="font-mono text-[12px] text-muted-80">{letter}</span>}
        <h3 className="text-[13px] font-medium text-fg/90">{title}</h3>
        {pick && <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-px text-[10.5px] font-medium text-accent">Recommended</span>}
      </div>
      <p className="mb-3 max-w-[754px] text-[12px] leading-[18px] text-muted-80">{note}</p>
      <div>{children}</div>
    </div>
  )
}
function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted">
      <span>{label}</span>
      <div className="flex rounded-md border border-border p-0.5">
        {options.map((o) => (
          <button key={o.value} type="button" onClick={() => onChange(o.value)} className={`rounded px-2 py-0.5 transition-colors ${o.value === value ? "bg-panel-2 text-fg" : "text-muted hover:text-fg"}`}>{o.label}</button>
        ))}
      </div>
    </div>
  )
}

const LAYOUTS: { value: Layout; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "header", label: "B · verbs in the header" },
  { value: "dock", label: "A · verbs stay at the bottom" },
  { value: "page", label: "C · one dock for the page" },
]

const LAYOUT_NOTES: Record<Layout, string> = {
  today: "The prompt box, one row per live op, then the lifecycle strip — all at the card's end. On a long card none of it is on screen while you read.",
  header: "The prompt box docks to the bottom of the screen while you read the card, the way the header docks to the top. Snooze and Mark as done move up into the sticky header beside the thread's other verbs, so the dock is only the prompt box and the line above it.",
  dock: "The same dock, one row taller: Snooze and Mark as done stay under the prompt box, and ride the dock with it.",
  page: "One prompt box for the whole page, as on /full. It replies to whichever card is under it and names that card; each card ends in one slim row of counts and verbs.",
}

function Playground() {
  const [layout, setLayout] = useState<Layout>("header")
  const [reset, bump] = useReducer((x: number) => x + 1, 0)
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-2">
        <Seg label="Layout" value={layout} onChange={setLayout} options={LAYOUTS} />
        <button type="button" onClick={bump} className="rounded-md border border-border px-2 py-0.5 text-[12px] text-muted hover:text-fg">Reset</button>
      </div>
      <p className="mb-4 max-w-[900px] text-[12px] leading-[18px] text-muted-80">{LAYOUT_NOTES[layout]}</p>
      <div className="flex flex-wrap items-start gap-8">
        <QueueViewport key={`${layout}-${reset}`} layout={layout} />
        <div className="w-[300px]">
          <h3 className="mb-2 text-[12px] font-medium text-fg/85">How to drive it</h3>
          <ol className="list-decimal space-y-1 pl-4 text-[12px] leading-[18px] text-muted">
            <li>Scroll the queue. The header sticks to the top, the prompt box to the bottom, and both let go where the card ends.</li>
            <li>Hover the yellow passages in the first card — the comment shows in a popover. Click one to keep it open.</li>
            <li>Select any text and click Comment (or press ⌘I) to add another. The counts in the header, above the prompt box and in the rail all move.</li>
            <li>Hover the counts at the prompt box's upper right for the live ops behind them.</li>
            <li>Press Enter in a prompt box: the note and every pending comment go as one message.</li>
          </ol>
        </div>
      </div>
    </div>
  )
}

function RuleTable() {
  const rows: [string, string, string][] = [
    ["Sticky header", "Which thread, and what you can do TO it", "Title, last active · terminal, collapse, fullscreen · Retry, restart · Snooze, Mark as done (B) · the pending-comment count"],
    ["Line above the prompt box", "What is outstanding — yours on the left, the worker's on the right", "Pending comments ↑ ↓ · live agents, shells, PR watches, files and links as counts, rows on hover"],
    ["Prompt box", "What you SAY to it, and how it runs", "The message · model and effort · permission mode · the goal (a standing message) · attach, send · the context pie (room left for the next message)"],
  ]
  return (
    <table className="w-full max-w-[1100px] border-collapse text-left text-[12.5px]">
      <thead>
        <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted-60">
          <th className="py-2 pr-6 font-normal">Edge</th><th className="py-2 pr-6 font-normal">Holds</th><th className="py-2 font-normal">So it carries</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([edge, rule, items]) => (
          <tr key={edge} className="border-b border-border/60 align-top">
            <td className="py-2.5 pr-6 font-medium text-fg/90">{edge}</td>
            <td className="py-2.5 pr-6 text-fg/80">{rule}</td>
            <td className="py-2.5 text-muted">{items}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Page() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? "dark")
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  return (
    <main className="min-h-screen bg-bg pb-24 text-fg">
      <style>{HIGHLIGHT_CSS + SHEET_CSS}</style>
      <header className="mx-auto max-w-[1640px] px-8 pb-6 pt-9">
        <h1 className="text-[22px] font-semibold tracking-tight">The queue card with a sticky prompt box</h1>
        <p className="mt-1.5 max-w-[900px] text-[13px] leading-[20px] text-muted">
          The prompt box docks to the bottom of the screen the way the header already docks to the top, so the reply, the pending comments and the live ops stay in view however long the card is. The rows of sub-agents, shells and files under it shrink to one line of counts at its upper right. Comments now leave their passage lightly highlighted in yellow and show on hover.
        </p>
      </header>
      <nav className="sticky top-0 z-50 border-y border-border bg-bg/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1640px] flex-wrap items-center gap-x-6 gap-y-2 px-8 py-2.5 text-[12px]">
          <Seg label="Theme" value={theme} onChange={setTheme} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} />
          <span className="ml-auto flex gap-5 text-muted">
            <a href="#scroll" className="hover:text-fg">Scroll it</a>
            <a href="#bottom" className="hover:text-fg">The card's end</a>
            <a href="#activity" className="hover:text-fg">Live ops</a>
            <a href="#context" className="hover:text-fg">Context and goal</a>
            <a href="#comments" className="hover:text-fg">Comments</a>
            <a href="#rule" className="hover:text-fg">The rule</a>
          </span>
        </div>
      </nav>
      <div className="mx-auto max-w-[1640px] px-8 pt-10">
        <Section id="scroll" title="Scroll it" note="The queue page as it would behave, three cards deep. Switch layouts to compare; every one of them is live.">
          <Playground />
        </Section>

        <Section id="bottom" title="1 · The end of a card" note="The same card — one live sub-agent, two shells, a PR watch, a file and a link — scrolled to its end. Today that is six rows under the prompt box plus the strip under them.">
          <Candidate letter="" title="Today" note={`Prompt box, six ${CHILD_ARROW} rows, then the context pie and the goal on the left of the lifecycle strip.`}>
            <CardEnd data={CACHE} layout="today" height={600} />
          </Candidate>
          <Candidate letter="B" pick title="Verbs in the header" note="The bottom edge is one line of counts and the prompt box. Snooze and Mark as done sit in the header with Retry and the other thread verbs, so the card's verbs all live on the one edge that is always on screen.">
            <CardEnd data={CACHE} layout="header" height={600} />
          </Candidate>
          <Candidate letter="A" title="Verbs stay at the bottom" note="The least change in habit: the lifecycle buttons keep their place under the prompt box. The dock is one row taller, and that row is on screen for the whole card.">
            <CardEnd data={CACHE} layout="dock" height={600} />
          </Candidate>
          <Candidate letter="C" title="One dock for the page" note="Cards stop carrying a prompt box at all and end in one slim row; the page's single prompt box, pinned to the bottom, answers the card under it. Most compact; costs a moment of “which card am I replying to?”, which the dock answers in words.">
            <QueueViewport layout="page" height={600} />
          </Candidate>
        </Section>

        <Section id="activity" title="2 · Live ops, condensed" note={`Counts at the prompt box's upper right, in the marks the ${CHILD_ARROW} rows already use: a yellow dot for an agent, a blue one for a shell, the pull-request mark for a PR watch, file and link icons. Hover for the rows themselves, in the same ${CHILD_ARROW} grammar as today.`}>
          <Candidate letter="i" title="Six live ops, at rest" note="One line, whatever the count.">
            <CardEnd data={CACHE} layout="header" height={460} />
          </Candidate>
          <Candidate letter="ii" title="Hovering the counts" note="The rows open above the line, so nothing under the prompt box moves. Each row keeps its click (open the transcript, the output, the PR) and its × (stop or clear).">
            <CardEnd data={CACHE} layout="header" height={460} activityOpen />
          </Candidate>
          <Candidate letter="iii" title="One sub-agent" note="A single op reads as a sentence.">
            <CardEnd data={PRICING} layout="header" height="fit" />
          </Candidate>
        </Section>

        <Section id="context" title="3 · Where the context pie and the goal go" note="Today both sit at the far left of the lifecycle strip, which holds the verbs that end or park a thread — neither of them does that. The goal is a standing message to the worker, and the pie is how much room is left for the next one; both are about what you send, so both move into the prompt box.">
          <Candidate letter="i" pick title="In the prompt box" note="The goal joins model, effort and permission — the controls for how the worker runs. Unset it is a bare mark; armed it is a lit chip that says what it does. The pie sits by Send, where the room it measures gets used.">
            <CardEnd data={PRICING} layout="header" height="fit" />
          </Candidate>
          <Candidate letter="ii" title="The pie in the header, as a reading" note="“Last active 23m ago · 31% context”: a fact about the thread, next to the other fact about it. Reads well, but the header's second line is the one that truncates first.">
            <CardEnd data={PRICING} layout="header" height="fit" contextAt="header" />
          </Candidate>
          <Candidate letter="iii" title="Both on the line above the prompt box" note="With the other outstanding things. Keeps the prompt box to its message, at the cost of a busier line.">
            <CardEnd data={PRICING} layout="header" height="fit" contextAt="tabs" />
          </Candidate>
        </Section>

        <Section id="comments" title="4 · Comments, as highlights" note="A comment leaves its passage lightly highlighted in yellow and nothing else in the transcript; the words show in a popover on hover, and stay up on click. The count rides both sticky edges: the header and the line above the prompt box.">
          <Candidate letter="i" pick title="Hovering a highlight" note="Pending · goes with your next send. Edit and delete in the corner.">
            <CardEnd data={CACHE} layout="header" height={600} layer={{ seeds: [S2, S3], openSeed: 0 }} />
          </Candidate>
          <Candidate letter="ii" title="Writing one" note="Select, then Comment or ⌘I: the same popover opens as an editor under the passage.">
            <CardEnd data={CACHE} layout="header" height={600} layer={{ seeds: [S3], draft: { quote: "412 passed, 1 skipped", text: "" } }} />
          </Candidate>
          <div className="min-w-[360px] max-w-[560px] flex-1">
            <h3 className="mb-1 text-[13px] font-medium text-fg/90">What the worker reads</h3>
            <p className="mb-3 text-[12px] leading-[18px] text-muted-80">Unchanged from the first sheet: the prompt box text as a note, then one blockquote per comment, in transcript order.</p>
            <pre className="overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-inset p-4 font-mono text-[12px] leading-[18px] text-fg/85">{wireText("", [S2, S3])}</pre>
          </div>
        </Section>

        <Section id="rule" title="The rule" note="One job per edge, which is what decides where each control goes.">
          <RuleTable />
        </Section>
      </div>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <Page />
    </TooltipProvider>
  </QueryClientProvider>,
)
