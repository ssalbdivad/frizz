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
// the same thread. Both sides fold from the HANDLE, never from the stored words: the fold strips a plural
// on the last word, and "Dev ops" is two short words where `devOps` is one (server thread-mentions.ts).

// A name's HANDLE is also what the operator TYPES after `@`, so two words are not enough of a bound on
// their own — every writer but a human rename also holds the handle to this length (server
// thread-names.ts `threadNameProblem`): "Spinoff feature scope and UI" went onto the board as
// `@spinoffFeatureScopeAndUi`, 24 characters nobody wants to type even with autocomplete (maintainer
// 2026-09-29). Sixteen admits every good name on the board that day — `shellBudgets` (12),
// `threadMentions` (14), `backgroundShells` (16) — and refuses the sentences.
export const THREAD_HANDLE_MAX_CHARS = 16

/** Past this many words a stored title is not a name but a sentence (a legacy row, a long human rename),
 *  and a camelCase run of it would be unreadable; it stays as written and has no handle. Frizz mints one
 *  or two words, but the name SHOWN can be Claude's own session title until then, and that runs to four
 *  or five ("Test fixture secret word" — seen on a real dispatch, 2026-09-29); those still need a handle
 *  that matches what the board shows. */
const HANDLE_MAX_WORDS = 5

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

// A SUB-AGENT IS ADDRESSED UNDER ITS THREAD (maintainer 2026-09-30: "subagents accessible as
// `topLevel.subagent` and given name ids with the same prompting as the top-level threads"). A child's
// name is its dispatch `description` (a Workflow agent's, its `label`), and the worker is prompted to
// write it the way a thread's name is written — one or two words naming its subject — so it camelCases
// into a handle by the same rule: "Cache keys" under `portTheParser` is `portTheParser.cacheKeys`, and a
// Workflow's agents sit one segment further down. The address is what the board shows in a sub-agent's
// drawer header, what the `@` typeahead completes, and what `read_thread` resolves.
//
// A child whose description is a sentence (six words or more — a worker that did not follow the prompt,
// or one dispatched before it existed) has no handle, exactly as a sentence-length thread title has
// none: it shows as written and is left out of the typeahead.
export const SUB_AGENT_SEPARATOR = "."

/** A sub-agent's handle: its dispatch name, camelCased by the thread rule, or undefined for a sentence. */
export function subAgentHandle(label: string): string | undefined {
  return threadHandle(label)
}

/** The handles a `thread.subAgent` address names, outermost first, without the `@`. */
export function addressSegments(address: string): string[] {
  return address.trim().replace(/^@/, "").split(SUB_AGENT_SEPARATOR).filter(Boolean)
}

type ChainAgent = { readonly id?: string; readonly label: string; readonly parentId?: string }

/** Each sub-agent's handle from the thread down to `id`, by walking `parentId`: `["wave2", "implW3"]`.
 *  Undefined when a link in the chain has no handle or is not in `agents` (a descendant whose parent has
 *  already returned), since an address with a hole in it would name nothing. */
export function subAgentChain(agents: readonly ChainAgent[], id: string): string[] | undefined {
  const byId = new Map(agents.flatMap((a) => (a.id ? [[a.id, a] as const] : [])))
  const chain: string[] = []
  const seen = new Set<string>()
  let at = byId.get(id)
  while (at) {
    if (seen.has(at.id!)) return undefined
    seen.add(at.id!)
    const handle = subAgentHandle(at.label)
    if (!handle) return undefined
    chain.unshift(handle)
    if (!at.parentId) return chain
    at = byId.get(at.parentId)
  }
  return undefined
}

/** `portTheParser.cacheKeys` — the thread's handle, then each sub-agent's down the dispatch tree. */
export function subAgentAddress(threadHandle: string, chain: readonly string[]): string {
  return [threadHandle, ...chain].join(SUB_AGENT_SEPARATOR)
}

/** `@handle` mentions in free text, in order, without the `@`. A mention starts at a word boundary (so an
 *  email address is not one) and runs over letters, digits, `-` and `_`, and on through a `.` that is
 *  followed by another segment (`@portTheParser.cacheKeys`) — so a sentence's full stop after a mention is
 *  never part of it. */
export function threadMentions(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/(?:^|[^\p{L}\p{N}_@./])@([\p{L}\p{N}][\p{L}\p{N}_-]*(?:\.[\p{L}\p{N}][\p{L}\p{N}_-]*)*)/gu)) out.push(m[1]!)
  return out
}
