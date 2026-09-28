import assert from "node:assert/strict"
import test from "node:test"

// Opt-in like the other *.e2e.test.ts here. Needs a REAL Frizz serving at least two projects, which
// `scripts/adhoc-stack.mjs` builds in one command:
//   nub scripts/adhoc-stack.mjs --port=45781 --project=/abs/a --also-project=/abs/b > /tmp/stack.log 2>&1 &
//   FRIZZ_PROJECT_SWITCH_E2E_URL=http://127.0.0.1:45781 nub --test --test-force-exit \
//     packages/web/src/lib/projectSwitch.e2e.test.ts
const baseUrl = process.env.FRIZZ_PROJECT_SWITCH_E2E_URL

// WHICH PROJECT THE LIVE FEED IS POINTED AT, after a client-side switch — the one thing no unit test
// here can reach. The pieces are all individually fine and were when this broke: `apiBase()` derives
// the right base from the page's project, `wsUrl()` derives from `apiBase()`, and `rebindProject()`
// drops and re-opens correctly. The bug lived in the seam — routes.tsx guarded the rebind with a
// `useRef` seeded from the slug it was looking at, so a switch that mounted a FRESH component (the
// project grid's tiles into a board, when this broke) found a ref that already said "bound", skipped the
// rebind entirely, and left the socket on the previous project. Every board then rendered the launching
// project's threads under another project's URL, and nothing but a document load recovered it
// (reported 2026-08-11). The rebind now asks the feed itself (routes.tsx useProjectBinding).
//
// The switch is the one the page has: the prompt box's project picker re-focuses `/` on another project
// without a navigation, and the page binds it (routes.tsx CrossProjectPage). Until 2026-09-28 it was a
// project row's ⋯ → Open board, a client-side navigation to `/project/<slug>`; the board is gone.
//
// So this asserts the socket URL, not the render: it is the one artifact that says which project the
// page's live data is actually coming from, and it is recorded from `evaluateOnNewDocument` so the
// module-load connection is captured too.
test("switching the page to another project re-points the live feed at that project", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  // Every registered project, opened: the server activates a tenant on its first request, and the picker
  // only binds a project the server has open.
  const headers = { origin: baseUrl!, "content-type": "application/json" }
  const listed = (await (await fetch(`${baseUrl}/_frizz/rpc/projectsList`, { headers })).json()) as { result: Array<{ slug: string; home?: boolean; stale?: boolean }> }
  const slugs = listed.result.filter((p) => !p.home && !p.stale).map((p) => p.slug)
  assert.ok(slugs.length >= 2, `needs a stack serving ≥2 projects, saw: ${slugs.join(", ") || "none"}`)
  for (const slug of slugs) await fetch(`${baseUrl}/_frizz/${slug}/rpc/board`, { headers })

  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    await page.evaluateOnNewDocument(() => {
      const w = window as unknown as { __wsUrls: string[]; WebSocket: typeof WebSocket }
      w.__wsUrls = []
      const Native = w.WebSocket
      w.WebSocket = new Proxy(Native, {
        construct(target, args: [string, ...unknown[]]) {
          w.__wsUrls.push(String(args[0]))
          return Reflect.construct(target, args)
        },
      })
    })
    // The page, focused on the LAST of them and bound to it, so both switches below move the feed.
    await page.goto(`${baseUrl}/?focus=${slugs.at(-1)}`, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-xq-project-picker]", { timeout: 15_000 })

    // The BOARD socket for a project, ignoring any other socket the page opens. Matched
    // with a regex rather than `endsWith("…")`, which frizzRouteUrls.test.ts reads as a hand-built
    // client URL — this only recognises one, it never constructs one.
    const isBoard = /\/ws$/
    const boardSocket = async () => (await page.evaluate(() =>
      (window as unknown as { __wsUrls: string[] }).__wsUrls))
      .filter((u) => isBoard.test(u)).at(-1)

    for (const slug of slugs.slice(0, 2)) {
      // CLIENT-SIDE, through the picker — a document load would rebind the feed and hide the bug. A Radix
      // menu mounts its items before it positions them, so the item is clicked once it holds still.
      await page.click("[data-xq-project-picker]")
      await page.waitForSelector(`[role="menuitem"][data-value="${slug}"]`, { timeout: 10_000 })
      await page.waitForFunction((s) => new Promise((resolve) => {
        const at = document.querySelector(`[role="menuitem"][data-value="${s}"]`)?.getBoundingClientRect()
        if (!at || at.top < 0 || at.bottom > innerHeight) return resolve(false)
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.querySelector(`[role="menuitem"][data-value="${s}"]`)?.getBoundingClientRect().y === at.y)))
      }), { timeout: 10_000 }, slug)
      await page.click(`[role="menuitem"][data-value="${slug}"]`)
      await page.waitForFunction((s) => document.querySelector("[data-xq-picker-name]")?.textContent?.trim() === s, { timeout: 15_000 }, slug)
      assert.equal(new URL(page.url()).pathname, "/", "the switch is not a navigation")
      // The rebind is an effect + a socket open, so give the new one a moment to be constructed.
      await page.waitForFunction((s) =>
        ((window as unknown as { __wsUrls: string[] }).__wsUrls
          .filter((u) => /\/ws$/.test(u)).at(-1) ?? "").includes(`/_frizz/${s}/`), { timeout: 15_000 }, slug)
        .catch(() => {})
      assert.match(
        (await boardSocket()) ?? "",
        new RegExp(`/_frizz/${slug}/ws$`),
        `the page's feed, switched to ${slug}, must address ${slug}, not whichever project it was last bound to`,
      )
      // …and the keyframe that feed delivers actually lands: the prompt box swaps its stand-in for the
      // project's real form once the project's board is in (AllQueues.tsx FocusedComposer), which is what
      // a page bound to nothing never does.
      await page.waitForFunction(() => !document.querySelector("[data-xq-composer-pending]") && document.querySelector("[data-dispatch-form]"), { timeout: 15_000 })
        .catch(() => assert.fail(`the prompt box never took ${slug}'s form`))
    }
  } finally {
    await browser.close()
  }
})
