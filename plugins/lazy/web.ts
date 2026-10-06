import type { ThreadComposerSlotProps, WebPluginActivation, WebPluginHost } from "../../packages/web/src/plugins/api.ts"

// LAZY THREADS — the page's half (server.ts has the why). Two slots:
//
//   · `newThread.submitAlt`: the snail beside Send and ⌘/Ctrl-Shift-Enter in the new-thread box write the
//     prompt down as a lazy thread instead of starting it (the snail sat in Composer.tsx, hard-wired, until
//     2026-10-06). Base clears the box, puts the words back on a failure, and toasts the result;
//   · `thread.composer`: a lazy thread's prompt box is its note — base's own HeldThreadBox (host.ui), bound
//     to this plugin's note and procedures. Typing saves the note; sending starts the agent with it.
//
// Served with its types stripped and `import()`ed by the page, so: types only from Frizz, React through
// `host`, and no JSX — `h(…)` is React.createElement.

/** Lucide's `Snail` (lucide-react 0.525.0, ISC), drawn exactly as the page's lucide icons draw: the rail's
 *  measured offset for this slot (iconRhythm.ts RAIL_ALT_OFFSET) is this glyph's ink. */
const SNAIL: readonly (readonly [string, Record<string, string>])[] = [
  ["path", { d: "M2 13a6 6 0 1 0 12 0 4 4 0 1 0-8 0 2 2 0 0 0 4 0" }],
  ["circle", { cx: "10", cy: "13", r: "8" }],
  ["path", { d: "M2 21h12c4.4 0 8-3.6 8-8V7a2 2 0 1 0-4 0v6" }],
  ["path", { d: "M18 3 19.1 5.2" }],
  ["path", { d: "M22 3 20.9 5.2" }],
]

export function activate(host: WebPluginHost): WebPluginActivation {
  const { h } = host

  function Snail({ size, strokeWidth }: { size: number; strokeWidth: number }) {
    return h(
      "svg",
      {
        xmlns: "http://www.w3.org/2000/svg", width: size, height: size, viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth, strokeLinecap: "round", strokeLinejoin: "round",
        className: "lucide lucide-snail", "aria-hidden": "true",
      },
      ...SNAIL.map(([tag, attrs], index) => h(tag, { key: index, ...attrs })),
    )
  }

  function LazyThreadBox({ thread, surface, className, id, call }: ThreadComposerSlotProps) {
    const mine = thread.plugins?.lazy as { note?: string } | undefined
    const sessionId = thread.sessionId ?? ""
    return h(host.ui.HeldThreadBox, {
      thread,
      surface,
      ...(className ? { className } : {}),
      ...(id ? { id } : {}),
      // Ours, or base's copy while the board has not drawn ours yet.
      note: mine?.note ?? thread.heldPrompt ?? "",
      save: (note: string) => call("update", { slug: thread.id, sessionId, note }),
      start: (prompt: string) => call("start", { slug: thread.id, sessionId, prompt }),
    })
  }

  return {
    slots: {
      "thread.composer": LazyThreadBox,
      "newThread.submitAlt": {
        label: "Add as lazy thread",
        title: "Add as lazy thread, without starting an agent",
        Icon: Snail,
        done: "Lazy thread added",
        submit: (draft) => host.call("create", draft) as Promise<{ slug: string }>,
      },
    },
  }
}
