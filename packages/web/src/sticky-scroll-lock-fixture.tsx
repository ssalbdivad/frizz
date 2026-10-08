import { createRoot } from "react-dom/client"
import { useState } from "react"
import { Dialog } from "./components/ui/Dialog.tsx"
import { SIDEBAR_COLUMN_CLASS, SIDEBAR_SLOT_CLASS } from "./components/Sidebar.tsx"
import "./styles.css"

// THE SIDEBAR MUST NOT MOVE WHEN A MODAL OPENS OVER A SCROLLED PAGE.
//
// The desktop rail is `position: sticky` in the PAGE's flow, and Radix's react-remove-scroll locks the
// page by putting `overflow: hidden !important` on <body>. Those two only coexist while the ROOT's own
// overflow stays `visible`: a browser propagates the viewport's overflow from <html> and falls back to
// <body> only when <html> is visible in both axes, so a root that declares its own overflow makes that
// `hidden` apply to the BODY BOX instead — <body> becomes a scroll container pinned at scrollTop 0, and
// every sticky descendant re-anchors to it. The rail then renders at the top of the DOCUMENT, `scrollY`
// pixels above the fold, and the whole column reads as having stopped rendering (maintainer 2026-08-26,
// on the "End this session?" confirmation: "the sidebar that's sort of behind the pop-up just stops
// rendering"). Nothing in the sidebar's own CSS looks wrong; the cause is one declaration in styles.css.
//
// The column is fixed to the viewport since 2026-10-08 (Sidebar.tsx SIDEBAR_COLUMN_CLASS), which no body
// scroll container can re-anchor; the root rule still stands for every other sticky box in the app.
//
// So this fixture is deliberately thin around the two things that actually interact — the REAL
// SIDEBAR_COLUMN_CLASS in the REAL page-scroll shell, and the REAL shared Dialog — and the e2e beside
// it measures the aside before and during the lock.
function Fixture() {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative min-h-screen bg-bg text-fg text-sm">
      <div className="flex min-h-screen justify-center gap-[clamp(28px,3.4vw,52px)] px-5">
        <div className={SIDEBAR_SLOT_CLASS}>
          <aside className={SIDEBAR_COLUMN_CLASS} data-sticky-rail>
            <div className="rounded-md border border-border bg-panel p-3">Sidebar</div>
          </aside>
        </div>
        <main className="w-[720px] max-w-[62vw] min-w-0 flex flex-col py-5">
          {/* Tall enough that the page genuinely scrolls at every viewport the suite uses. */}
          <div className="h-[3000px] rounded-lg border border-border bg-panel p-4">
            <button
              type="button"
              data-open-dialog
              onClick={() => setOpen(true)}
              className="rounded-md border border-border-strong bg-panel-2 px-2.5 py-1 text-[12px]"
            >
              Open the dialog
            </button>
          </div>
        </main>
      </div>
      <Dialog open={open} onOpenChange={setOpen} title="End this session?" className="w-[390px] max-w-[92vw]">
        <div className="p-4 text-[12px] text-muted">A modal Radix layer, which is what locks the page.</div>
      </Dialog>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
