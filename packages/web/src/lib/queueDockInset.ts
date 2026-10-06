// THE BAND AT THE BOTTOM OF THE SCREEN THAT THE QUEUE'S DOCKED PROMPT BOXES COVER, published as
// `--queue-dock-inset` on <html> so everything else that lives at the viewport bottom stands clear of it:
//
// - the page's `scroll-padding-bottom` (styles.css), so a control focused by Tab under a dock is
//   scrolled out from beneath it rather than left hidden behind the box that covers it;
// - the toaster (Toaster.tsx), which sat on top of the dock's send button and Goal.
//
// Every queue card docks its own box; they are all the same shape, so the tallest one is the inset. A
// textarea grows to its 220px cap while the operator types, which is why this observes rather than
// reading the height once. No card, no dock (the phone never renders a queue card): the inset is 0.
const heights = new Map<string, number>()

function publish(): void {
  const inset = heights.size === 0 ? 0 : Math.max(...heights.values())
  if (inset > 0) document.documentElement.style.setProperty("--queue-dock-inset", `${inset}px`)
  else document.documentElement.style.removeProperty("--queue-dock-inset")
}

export function trackQueueDock(slug: string, dock: HTMLElement): () => void {
  const observer = new ResizeObserver(() => {
    heights.set(slug, dock.getBoundingClientRect().height)
    publish()
  })
  observer.observe(dock)
  return () => {
    observer.disconnect()
    heights.delete(slug)
    publish()
  }
}
