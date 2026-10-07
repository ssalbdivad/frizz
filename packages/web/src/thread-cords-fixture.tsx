import { createRoot } from "react-dom/client"
import { ThreadConnector } from "./components/ThreadConnector.tsx"
import "./styles.css"

// THE PROJECT CORDS (ThreadConnector.tsx) on a bare rail: the page's left column — a head, then the rail's
// scrolling list — with two projects strung on cords and nothing else. The head holds a slot that folds
// open the way the prompt box's schedule strip does (NewThreadModal.tsx `data-schedule-slot-wrap`: a
// `grid-template-rows` transition, delayed 60ms), so a test can shift every row down WITHOUT a scroll, a
// window resize, or any mutation the connector watches — the case that left the cords a strip's height off
// (threadCords.e2e.test.ts).
//
//   http://localhost:5907/thread-cords-fixture.html
//
// Open the slot with `document.querySelector("[data-fixture-slot]").style.gridTemplateRows = "1fr"`.

const PROJECTS = [
  { id: "billing", name: "billing-worker", rows: ["stripe-webhooks", "dunning-retries", "invoice-pdf"] },
  { id: "site", name: "marketing-site", rows: ["hero-copy", "pricing-tiers", "rss-feed", "og-images"] },
]

/** The indicator column as the real rows draw it (Sidebar.tsx): a 16px slot on the title's first line, its icon inside. */
const Indicator = ({ size }: { size: number }) => (
  <span data-xq-indicator className="flex h-[19px] w-4 shrink-0 items-center justify-center">
    <span className="block rounded-[3px] border border-fg/40" style={{ width: size, height: size }} />
  </span>
)

function Fixture() {
  return (
    <div className="flex min-h-screen gap-12 bg-bg px-5 text-sm text-fg">
      <aside aria-label="Projects" className="sticky top-0 flex h-screen w-[340px] shrink-0 flex-col self-start pt-[48px]">
        <div className="flex max-h-[calc(100vh-68px)] min-h-0 w-full min-w-0 flex-col">
          <div className="mb-5 shrink-0 px-0.5">
            <div className="h-24 rounded-lg border border-border">prompt box</div>
            <div data-fixture-slot style={{ display: "grid", gridTemplateRows: "0fr", transition: "grid-template-rows 140ms ease-out 60ms" }}>
              <div className="min-h-0 overflow-hidden">
                <div className="h-[51px] px-3 py-2 text-muted">Every weekday at 9am · next Thu Oct 8</div>
              </div>
            </div>
          </div>
          <div data-xq-rail className="min-h-0 min-w-0 overflow-y-auto overflow-x-hidden">
            {PROJECTS.map((project) => (
              <div key={project.id} data-xq-rail-project={project.id} className="mb-4">
                <div data-xq-project-row className="flex h-[28px] items-center gap-2">
                  <Indicator size={16} />
                  <span>{project.name}</span>
                </div>
                {project.rows.map((row) => (
                  <div key={row} data-xq-thread-row data-xq-rail-row={`${project.id}/${row}`} className="flex gap-2 pb-2 pt-1">
                    <Indicator size={14} />
                    <span>{row}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </aside>
      <main id="workpane" className="min-h-screen flex-1" />
      <ThreadConnector activeKey={null} />
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
