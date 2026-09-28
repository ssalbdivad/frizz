import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router"
import type { BoardSnapshot } from "@frizz/shared"
import { StatusRow } from "./StatusRow.tsx"
import { store, type ConnectionState } from "../store.ts"

// The row's SHAPE is a spec, not an accident: home → settings → reload → quota, left to right and all
// of it left-justified, with the page's name pinned to the right edge. It has been three separate pieces
// of chrome in three places (identity top-left, settings/reload top-right, quota floating over the
// sidebar composer), then one fixed corner chip, then the same row running the other way — so a
// regression here is a silent return to one of those rather than a visible break.
//
// The store's board is seeded because the row must NOT read it: it names the page, never a project, so a
// board carrying an owner/repo is exactly what would leak into it if it did.
function render(
  label: string | null = "colinhacks/frizz",
  options: { connection?: ConnectionState; quota?: boolean } = {},
): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // The quota chips and the gate in front of them read these two cache entries; seeding them is how a
  // static render reaches the shown state at all.
  if (options.quota !== false) {
    client.setQueryData(["quota"], {
      claude: { status: "ok", planType: "max", windows: [{ key: "5h", label: "5h", usedPercent: 17 }] },
      codex: { status: "ok", planType: "pro", windows: [{ key: "5h", label: "5h", usedPercent: 41 }] },
    })
    client.setQueryData(["authStatus"], { claude: "authed", codex: "authed", emails: {} })
  }
  store.board = (label === null
    ? null
    : { projectLabel: label, githubRepo: label, threads: [] }) as unknown as BoardSnapshot
  store.connection = options.connection ?? "open"
  store.socketBoardFallback = null
  // The home crumb is a router Link (it hard-loaded the document until 2026-09-04), and a Link outside a
  // router context throws on render — every case here failed at once when it changed. In the app the row
  // is always under RouterProvider; MemoryRouter is the same context without a DOM history.
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, null, createElement(StatusRow, null)),
    ),
  )
}

test("controls run along the left; the page's name anchors the right", () => {
  const html = render()

  const home = html.indexOf('aria-label="Everything"')
  const settings = html.indexOf('aria-label="Settings"')
  const quota = html.indexOf("data-quota-bar")
  const page = html.indexOf("data-status-row-page")

  assert.ok(home >= 0 && settings >= 0 && quota >= 0 && page >= 0, "every segment renders")
  assert.ok(home < settings, "the page's own door leads")
  assert.ok(settings < quota, "the buttons precede the readouts")
  assert.ok(quota < page, "the name is last, at the far edge")
  // `ml-auto` on the name IS the split. Without it the name packs left with everything else.
  assert.match(html, /data-status-row-page="true" class="ml-auto min-w-0 truncate font-semibold text-fg\/90">Everything</)
  // …and ∞ is the page itself (unfiltered, as every static render is: the filter is per tab).
  assert.match(html, /aria-label="Everything" aria-current="page"/)
})

// THERE IS NO PROJECT VIEW (2026-09-28), so the row names no project: not the one a new thread goes to
// (the prompt box's own pill), not the one the queue is filtered to (the READY header's), and not the
// board the store happens to hold.
test("the row names the page, never a project", () => {
  const html = render("colinhacks/frizz")
  assert.doesNotMatch(html, /colinhacks/)
  assert.doesNotMatch(html, /github\.com/)
  assert.doesNotMatch(html, /data-project-identity-state/)
})

test("ONE door out: the project grid folded into Everything, and its house went with it", () => {
  const html = render()
  // A house (the grid) and an infinity (Everything) stood side by side until 2026-09-24 — two ways "up"
  // to pages that were never meant to be different places.
  assert.doesNotMatch(html, /All projects/)
  assert.equal(html.match(/href="\//g)?.length, 1, "the ∞ is the row's only in-app link")
})

test("TWO dividers: home is the door OUT, settings and reload act on the app you are in", () => {
  const html = render()
  // One divider would group all three as "buttons". The first one is the whole distinction.
  assert.equal(html.split('class="h-3 w-px shrink-0 bg-border"').length - 1, 2)
})

test("the row is LOOSE on the page — no fill, no border, no shadow, nothing fixed", () => {
  const html = render()

  assert.match(html, /data-status-row/)
  // It was a fixed, opaque, shadowed chip in the page's top-left corner until 2026-08-19, because a
  // full sidebar or a scrolling narrow rail would paint through it. In the column there is nothing to
  // pass behind it, and a surface here would read as a second box stacked on the prompt box.
  assert.match(html, /class="mb-2\.5 flex min-w-0 items-center gap-3 text-\[12px\]"/)
  for (const gone of [/\bfixed\b/, /\bz-20\b/, /bg-panel/, /shadow-sm/, /rounded-lg border border-border/]) {
    assert.doesNotMatch(html, gone)
  }
})

test("the connection dot is gone, in every state", () => {
  // It had been the connection's last remnant since 2026-08-19, and went with the maintainer's
  // 2026-08-28 "then maybe we should just drop the status indicator".
  for (const connection of ["open", "connecting", "closed"] as const) {
    const state = render("colinhacks/frizz", { connection })
    assert.doesNotMatch(state, /role="img" aria-label="connected"/)
    assert.doesNotMatch(state, /aria-label="disconnected"|aria-label="connecting…"/)
    assert.doesNotMatch(state, /bg-live|bg-danger-fill|data-board-sync-fallback/)
  }
})

test("the controls do not wait on a board — they are reachable from the first paint", () => {
  const html = render(null)
  assert.match(html, /aria-label="Settings"/)
  assert.match(html, /aria-label="Everything"/)
})

test("the row's gap is 12px of INK: one flex gap, and every icon square trimmed onto its glyph", () => {
  const html = render()

  // The pair is the whole point and neither half works alone. `gap-3` without the trims puts 20px of
  // ink between two icon squares and 8px beside the quota chips (measured 2026-08-14 with
  // scripts/ink-gaps.mjs); the trims without a matching gap pull the icons on top of each other. Every
  // button takes its trim from STATUS_ROW_ACTION, so a new row action inherits the rhythm instead of
  // re-deriving it — and a glyph that paints something other than 12px needs a fresh measurement.
  assert.match(html, /class="-mx-1\.5 inline-flex h-6 w-6/)
  // The door out takes the shared trim and NOTHING more. The house it replaced (2026-09-24) needed a
  // `-ml-px` of its own to put its ink on the composer's border; the infinity's stroke reaches one unit
  // further out in lucide's 24-unit box (x=1 against the house's x=2), which is that pixel already.
  assert.doesNotMatch(html, /-ml-px/)
  // The quota chips are IN this row, so they keep the row's distance rather than one of their own.
  assert.match(html, /data-quota-bar="true" class="flex shrink-0 items-center gap-3/)
})

test("the quota READING is small, but its provider mark is a full-sized, full-brightness icon", () => {
  const html = render()

  // "logos should be the same brightness and size as the other icons. The text should just be small"
  // (maintainer 2026-08-19). The size is per-mark because the two do not fill their viewBoxes alike.
  assert.match(html, /data-quota-bar="true" class="[^"]*text-\[9px\]/)
  assert.match(html, /text-fg\/75! size-\[14px\]!/)
  assert.match(html, /text-fg\/75! size-\[12\.75px\]!/)
  // ProviderMark's own `text-muted-65 size-[11px]` is still in the class list and MUST be — the `!`
  // is what outranks it, because Tailwind resolves a same-property collision by CSS source order and
  // not by class order. Asserting the default is absent would be asserting the wrong mechanism; the
  // browser-side check that these resolve to 14px/12.75px is in the handoff's measurements.
  assert.match(html, /text-muted-65 size-\[11px\][^"]*size-\[14px\]!/)
})

test("the home crumb is a ROUTER link, not a raw anchor that reloads the document", () => {
  // It was `<a href="/">` from 2026-08-19 to 2026-09-04: a full document load measured at 116-411ms with
  // a 0.15 CLS, throwing away the app socket and the whole query cache on the way out. The rail's
  // identical door had been a `<Link>` since the router refactor a fortnight earlier, so this was an
  // oversight — and an easy one to make again, because in STATIC MARKUP the two are the same string.
  // `<Link to="/">` renders exactly `<a href="/">`, so no assertion on the HTML can tell them apart.
  //
  // What differs is the CONTEXT they need: a Link reads the router off React context and throws without
  // one, a plain anchor does not care. So rendering the row with no router is the discriminator, and it
  // is the same property that makes this a client-side navigation at all.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(["authStatus"], { claude: "authed", codex: "authed", emails: {} })
  store.board = { projectLabel: "colinhacks/frizz", threads: [] } as unknown as BoardSnapshot
  store.connection = "open"
  assert.throws(
    () => renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(StatusRow, null))),
    /basename|Router/,
    "a raw <a href=\"/\"> would render happily here; a router Link cannot",
  )
  // …and inside a router it renders, pointing at Everything.
  assert.match(render(), /href="\/"[^>]*aria-label="Everything"|aria-label="Everything"[^>]*href="\/"/)
})

test("a provider with NO DATA renders nothing at all — and takes the divider with it", () => {
  // "if there's no data available for a given agent, then it should just be entirely hidden instead of
  // showing an em dash" (maintainer 2026-08-19). An em dash spent a readout's worth of space saying a
  // readout was missing.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(["quota"], {
    claude: { status: "ok", planType: "max", windows: [{ key: "5h", label: "5h", usedPercent: 17 }] },
    codex: { status: "unavailable", windows: [] },
  })
  client.setQueryData(["authStatus"], { claude: "authed", codex: "signed-out", emails: {} })
  store.board = { projectLabel: "colinhacks/frizz", threads: [] } as unknown as BoardSnapshot
  store.connection = "open"
  // Seeds its own client rather than going through `render`, so it needs the router context too.
  const one = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, null, createElement(StatusRow, null)),
    ),
  )
  assert.doesNotMatch(one, /—/, "no em dash anywhere")
  assert.equal(one.split("Claude Code").length - 1, 1, "the Claude chip is still there")
  assert.equal(one.split("OpenAI Codex").length - 1, 0, "the Codex chip is gone entirely")
  // One provider still reporting keeps the group, and therefore its divider.
  assert.equal(one.split('class="h-3 w-px shrink-0 bg-border"').length - 1, 2)

  // NEITHER reporting drops the whole group, and the divider that introduced it goes too — otherwise
  // the row ends on a hairline with nothing after it.
  const none = render("colinhacks/frizz", { quota: false })
  assert.doesNotMatch(none, /data-quota-bar/)
  assert.equal(none.split('class="h-3 w-px shrink-0 bg-border"').length - 1, 1)
})
