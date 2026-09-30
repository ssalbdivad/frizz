// A THREAD'S NAME IS ALSO ITS HANDLE (maintainer 2026-09-29: "I want the displayed names to also be
// camelCase so its obvious how to refer to them and that they represent ids").
//
// A name is stored as the one or two words it was minted as ("Shell budgets", "ArkType perf") — the
// server's namer, the worker's `title` tool and a human rename all write words — and it is SHOWN as the
// camelCase handle those words make (`shellBudgets`, `arkTypePerf`). What the operator reads on the board
// is therefore exactly what they type after `@` to point one thread at another ("ask @shellBudgets about
// this"), and what a worker passes to `read_thread` / `message_thread`.
//
// Resolution never depends on the casing: a handle is matched by folding case, punctuation and spacing
// away (the server's `foldThreadName`), so `@shellbudgets`, `@shell-budgets` and `@ShellBudgets` all name
// the same thread, and a handle always folds to the same key as the words it came from. That is also why
// uniqueness needs no second rule — names are already unique under that fold.

/** Past this many words a stored title is not a name but a sentence (a legacy row, a long human rename),
 *  and a camelCase run of it would be unreadable; it stays as written and has no handle. Names minted
 *  since 2026-09-29 are one or two words, so three leaves room for a proper noun spelled as two. */
const HANDLE_MAX_WORDS = 3

function words(name: string): string[] {
  return name.normalize("NFKD").replace(/\p{M}+/gu, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

/** The camelCase handle a name is shown and addressed as, or undefined when the name is too long to be
 *  one. The first word leads lowercase (an all-caps acronym lowercases whole: "API keys" → `apiKeys`);
 *  every later word keeps its own casing behind a capital, so a proper noun survives (`arkTypePerf`,
 *  `codexMCP`). */
export function threadHandle(name: string): string | undefined {
  const parts = words(name)
  if (parts.length === 0 || parts.length > HANDLE_MAX_WORDS) return undefined
  const [first, ...rest] = parts
  const lead = first === first!.toUpperCase() ? first!.toLowerCase() : first!.charAt(0).toLowerCase() + first!.slice(1)
  return lead + rest.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("")
}

/** `@handle` mentions in free text, in order, without the `@`. A mention starts at a word boundary (so an
 *  email address is not one) and runs over letters, digits, `-` and `_`. */
export function threadMentions(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/(?:^|[^\p{L}\p{N}_@./])@([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu)) out.push(m[1]!)
  return out
}
