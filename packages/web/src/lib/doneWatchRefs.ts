import { githubRefFromUrl } from "./githubAutolink.ts"

// THE PULL REQUESTS AND ISSUES A DONE CARD NAMES — what its Watch buttons offer (2026-10-07).
//
// Read off the card's RENDERED HTML, not its markdown, so it is exactly the set the card already links:
// the autolinker (githubAutolink.ts) has resolved a bare `#123` against the thread's project repo and kept
// code spans literal, and every github.com issue/PR anchor — minted or pasted as a URL alike — resolves
// to its canonical key through `githubRefFromUrl`, the same reading the hovercards key on. A second scan
// of the prose here would be a second grammar that could disagree with the links the human is looking at.
//
// Commits (`owner/repo@sha`) are dropped: there is nothing to watch on one. PR vs issue is not decided
// here — prose cannot say which a `#N` is, and the server asks GitHub (router.watchDoneRef).

export interface DoneWatchRef {
  /** `owner/repo#N`, as the link resolved it — what the server is asked to watch. */
  ref: string
  /** What the button says after "Watch": `#N` in the thread's own repo, the full ref anywhere else. */
  label: string
}

const HREF = /<a\b[^>]*?\bhref="([^"]+)"/g

export function doneWatchRefs(html: string, repo: string | null): DoneWatchRef[] {
  const seen = new Set<string>()
  const out: DoneWatchRef[] = []
  for (const match of html.matchAll(HREF)) {
    const ref = githubRefFromUrl(match[1].replaceAll("&amp;", "&"))
    const at = ref?.lastIndexOf("#") ?? -1
    if (!ref || at < 0) continue
    // GitHub names are case-blind, and so is the server's one-watcher-per-thing rule.
    const key = ref.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const ownRepo = repo !== null && ref.slice(0, at).toLowerCase() === repo.toLowerCase()
    out.push({ ref, label: ownRepo ? ref.slice(at) : ref })
  }
  return out
}

/** A ref the thread already watches, by the board's armed `github` rows — case-blind, as GitHub is. */
export function watchedRefs(watches: readonly { kind: string; target: string; state: string }[] | undefined): Set<string> {
  return new Set((watches ?? []).filter((w) => w.kind === "github" && w.state === "armed").map((w) => w.target.toLowerCase()))
}
