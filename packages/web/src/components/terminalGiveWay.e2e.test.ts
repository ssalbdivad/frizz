import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRIZZ_TERMINAL_GIVE_WAY_E2E_URL

// WHO GIVES WAY ON A TERMINAL ROW, measured in a real browser — the rule is about LAYOUT, and a markup test can
// only say which classes are there. The maintainer's rule (2026-09-29): a row's folder hint appears only where
// the row runs somewhere other than the header says, and the LABEL keeps priority — the hint truncates or drops
// first. Two rounds broke it in a browser while every string assertion stayed green:
//
//   · 390px, round 2: the hint could not shrink, and the label collapsed instead (`Test wat…`).
//   · 390px, round 3: the hint's WORD gave way but its glyph and `·` were kept, so `Running root tick l…` sat
//     beside a bare folder (20px that would have fitted the label), and the bare glyph named nothing; on the
//     1400px rail, 4 of 5 `root` hints were a bare glyph ~120px left of their row's status.
//
// So, on the terminals fixture (terminals-unified-fixture.html — the agent in `probe`, rows left at the root),
// at a desktop, a narrow and a phone width, on every surface that draws a terminal row — the drawer's strip,
// the card's strip, the card's prompt caption, the fullscreen rail:
//   1. no row shows any part of its hint while its label is cut;
//   2. a hint is never partial: its glyph shows exactly when its word does;
//   3. on the rail, a shown hint sits right against its status (it leads it, as the strip's leads its readings);
//   4. the agent drawer's header never cuts a number, and its title keeps a real width.
//
// Run it against a plain vite over packages/web:
//   nubx vite --port 5391 --strictPort --host 127.0.0.1
//   FRIZZ_TERMINAL_GIVE_WAY_E2E_URL=http://127.0.0.1:5391 nub --test packages/web/src/components/terminalGiveWay.e2e.test.ts
test("a terminal row's label outranks its folder hint, which shows whole or not at all, at every width", {
  skip: !baseUrl,
  timeout: 120_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("pageerror", (e) => errors.push(String(e)))
    for (const width of [1400, 420, 390]) {
      await page.setViewport({ width, height: 1400, deviceScaleFactor: 1 })
      await page.goto(`${baseUrl}/terminals-unified-fixture.html?here=probe`, { waitUntil: "networkidle0" })
      await page.evaluate(() => document.fonts.ready)
      const rows = await page.$$eval("[data-fixture-strip] [data-process-row], [data-fixture-rail] [data-wait-row]", (nodes) => nodes.map((row) => {
        const shownIn = (el: Element | null, box: DOMRect | undefined) => {
          if (!el || !box) return false
          const b = el.getBoundingClientRect()
          return b.width > 0 && b.top < box.bottom - 1 && b.bottom > box.top + 1 && b.left >= box.left - 1 && b.right <= box.right + 1
        }
        const label = (row.querySelector("[data-process-label]") ?? row.querySelector("button")) as HTMLElement
        const give = row.querySelector("[data-process-give]")?.getBoundingClientRect()
        const hint = row.querySelector("[data-process-checkout]")
        const status = row.querySelector("[data-wait-status]")
        return {
          surface: row.closest("[data-fixture-rail]") ? "rail" : row.closest("[data-fixture-caption]") ? "caption" : row.closest("[data-fixture-strip]")!.getAttribute("data-fixture-strip"),
          text: (row as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
          cut: label.scrollWidth > label.clientWidth + 0.5,
          hasHint: Boolean(hint),
          glyph: shownIn(hint?.querySelector("svg") ?? null, give),
          word: shownIn(hint?.querySelector("[data-process-checkout-word]") ?? null, give),
          toStatus: hint && status ? status.getBoundingClientRect().left - hint.getBoundingClientRect().right : null,
        }
      }))
      const at = (r: { surface: string | null; text: string }) => `${width}px ${r.surface}: ${r.text}`
      assert.ok(rows.length >= 25, `${width}px: every surface drew its rows (${rows.length})`)
      assert.ok(rows.some((r) => r.hasHint), `${width}px: the fixture has hinted rows`)
      for (const r of rows) {
        assert.equal(r.glyph, r.word, `${at(r)} — a hint's glyph shows exactly when its word does`)
        assert.ok(!(r.cut && r.glyph), `${at(r)} — the label is cut while the hint still shows`)
        if (r.surface === "rail" && r.glyph) assert.ok(r.toStatus !== null && r.toStatus <= 8, `${at(r)} — the hint leads its status (${r.toStatus}px away)`)
      }
      // The widest desktop shows every hint the rows have room for: a row whose label fits whole and whose
      // hint is still hidden would mean the hint gives way for nothing.
      if (width === 1400) {
        for (const r of rows.filter((x) => x.hasHint && x.surface !== "rail")) assert.ok(r.glyph, `${at(r)} — room enough, and no hint`)
      }
    }

    // The agent drawer's header: the reading's numbers are whole or gone, each `·` stands a space clear of what
    // it follows (a part opens a flex item, where a leading space collapses: `running· 43m left· 16m`), and the
    // title keeps a real width.
    for (const width of [1400, 420, 390]) {
      await page.setViewport({ width, height: 700, deviceScaleFactor: 1 })
      await page.goto(`${baseUrl}/terminals-unified-fixture.html?mode=agent`, { waitUntil: "networkidle0" })
      await page.waitForSelector("header [data-sheet-meta] [data-reading-part]")
      const header = await page.$eval("header", (h) => {
        const title = h.querySelector("span[title]")!.getBoundingClientRect()
        const reading = h.querySelector("[data-sheet-meta]")!.firstElementChild!.getBoundingClientRect()
        const parts = [...h.querySelectorAll("[data-reading-part]")].map((p) => {
          const b = p.getBoundingClientRect()
          const sep = p.firstElementChild as HTMLElement
          const before = p.previousElementSibling as HTMLElement | null
          let dotGap: number | null = null
          if (sep.offsetWidth > 0 && before && before.offsetWidth > 0 && sep.firstChild) {
            const range = document.createRange()
            range.setStart(sep.firstChild, 1)
            range.setEnd(sep.firstChild, 2)
            dotGap = range.getBoundingClientRect().left - before.getBoundingClientRect().right
          }
          return { whole: b.right <= reading.right + 0.5, shown: b.top < reading.bottom - 1, dotGap }
        })
        return { titleW: title.width, parts }
      })
      assert.ok(header.titleW > 150, `${width}px: the title keeps ${header.titleW}px (it kept 39-51px on one line)`)
      for (const p of header.parts) {
        assert.ok(!p.shown || p.whole, `${width}px: a reading part is cut`)
        if (p.shown && p.dotGap !== null) assert.ok(p.dotGap >= 2, `${width}px: a \`·\` sits ${p.dotGap}px from what it follows`)
      }
      // At 1400 `running` stands before the age; narrower, beside the Stop, it goes with its `·`.
      if (width === 1400) assert.ok(header.parts.some((p) => p.shown && p.dotGap !== null), `${width}px: a separator was measured`)
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
