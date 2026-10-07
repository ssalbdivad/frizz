import { useState } from "react"
import { createRoot } from "react-dom/client"
import { BandTabs, type PageTab } from "./components/PhonePage.tsx"
import { initFont } from "./lib/font.ts"
import "./styles.css"

// The phone page's band tabs (PhonePage.tsx BandTabs) at the counts that matter, one strip per case, each
// its own full-width block so a strip that runs past the screen widens the document as it would on the
// page. Read by components/phoneBandTabs.e2e.test.ts at 360, 390 and 430px.
//
//   usual  — the three bands at everyday counts: four queued, two snoozed, no schedules.
//   qa     — the case QA found wrapping (2026-10-06): a question waiting, 15 queued, a schedule.
//   worst  — every count at its realistic worst: 12 asks of 15 queued, 24 snoozed, 12 schedules.
initFont()

const CASES = [
  { id: "usual", asks: 0, queue: 4, snoozed: 2, schedules: null },
  { id: "qa", asks: 1, queue: 15, snoozed: 4, schedules: { count: 1, attention: false } },
  { id: "worst", asks: 12, queue: 15, snoozed: 24, schedules: { count: 12, attention: true } },
] as const

function Strip({ counts }: { counts: (typeof CASES)[number] }) {
  const [tab, setTab] = useState<PageTab>("queue")
  return (
    <div data-case={counts.id} className="mb-6">
      <BandTabs tab={tab} onTab={setTab} asks={counts.asks} queue={counts.queue} snoozed={counts.snoozed} schedules={counts.schedules} />
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-bg pt-4 text-fg">
    {CASES.map((counts) => <Strip key={counts.id} counts={counts} />)}
  </main>,
)
