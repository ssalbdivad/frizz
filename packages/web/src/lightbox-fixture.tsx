import { createRoot } from "react-dom/client"
import "./styles.css"
import { splitProseAttachments } from "./lib/imagePaths.ts"
import { mdToHtml } from "./lib/markdown.ts"
import { LightboxGallery, LightboxHost } from "./components/Lightbox.tsx"

// The ```lightbox fence with the REAL components: worker prose split exactly as ChatView splits it
// (splitProseAttachments), each gallery drawn by LightboxGallery, and the viewer hosted the way the page
// layouts host it. Driven by components/lightbox.e2e.test.ts.
//
// The pictures come from that test, not from here. An <img> load is not a `fetch`, so no stub on this
// page can answer `/_frizz/local-image` (see attachment-render-fixture.tsx); the test intercepts the
// request instead and draws a PNG at the size the path names (`…-1440x900.png`). A path naming
// `missing` is answered 404, the way the real route answers a file that is gone.
//
// A window listener counts the keys that reach the PAGE. The real page unwinds its drawers — and leaves
// the fullscreen page — on an Escape that gets that far (DrawerStack), so the viewer must keep its own.
declare global {
  interface Window { __pageKeys?: string[] }
}
window.__pageKeys = []
window.addEventListener("keydown", (e) => { window.__pageKeys!.push(e.key) })

const shot = (name: string) => `/fixture/lightbox/${name}`

const messages = [
  ["Before and after:", "", "```lightbox", `${shot("before-1440x900.png")}  Before`, `${shot("after-1440x900.png")}  After`, "```"],
  ["The board at three widths:", "", "```lightbox", shot("phone-375x812.png"), shot("tablet-768x1024.png"), shot("desktop-1440x900.png"), "```"],
  ["One file was cleaned up:", "", "```lightbox", shot("first-1440x900.png"), shot("missing-1440x900.png"), shot("last-1440x900.png"), "```"],
].map((lines) => lines.join("\n"))

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-[700px] p-8">
    {messages.map((md, m) => (
      <section key={m} data-fixture-message={m} className="mb-8 flex flex-col gap-3 text-[13px]">
        {splitProseAttachments(md).map((part, i) =>
          part.kind === "lightbox" ? <LightboxGallery key={i} entries={part.entries} />
          : part.kind === "md" ? <div key={i} className="md-body" dangerouslySetInnerHTML={{ __html: mdToHtml(part.text) }} />
          : null,
        )}
      </section>
    ))}
    <LightboxHost />
  </main>,
)
