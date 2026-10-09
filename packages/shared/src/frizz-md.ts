import { z } from "zod"

// THE FIRST-RUN QUESTIONNAIRE, and the FRIZZ.md it writes.
//
// A project with no threads and no FRIZZ.md opens on a short questionnaire instead of the bare prompt
// box: how workers land finished work, how independently they work, and anything else they should know.
// The answers become the project's FRIZZ.md, which `frizzConfigBlock` (server/dispatch.ts) injects into
// the system prompt of every worker Frizz starts there — and ONLY those: no other coding agent reads
// FRIZZ.md, which is the whole point of putting the answers in it rather than in AGENTS.md or CLAUDE.md.
// The file says so in its own first paragraph, for the human who opens it later.
//
// The composer lives here, in `shared`, because two programs need the identical text: the browser
// shows it as a preview before anything is written, and the server writes it. The server composes from
// the ANSWERS rather than accepting a finished document, so the file it writes is always one this
// function produced.

/** How a worker gets finished work onto the project. */
export const FrizzMdLanding = z.enum(["pull-request", "main", "main-push", "branch"])
export type FrizzMdLanding = z.infer<typeof FrizzMdLanding>

/** How often a worker stops to ask rather than deciding for itself. */
export const FrizzMdAutonomy = z.enum(["decide", "balanced", "check-in"])
export type FrizzMdAutonomy = z.infer<typeof FrizzMdAutonomy>

export const FRIZZ_MD_NOTES_MAX = 8000

export const FrizzMdAnswers = z
  .object({
    landing: FrizzMdLanding,
    autonomy: FrizzMdAutonomy,
    notes: z.string().max(FRIZZ_MD_NOTES_MAX),
  })
  .strict()
export type FrizzMdAnswers = z.infer<typeof FrizzMdAnswers>

/** What the first-run screen needs to decide whether to ask at all, and how to word the answers. */
export const FrizzMdStatus = z.object({
  /** A FRIZZ.md is already at the project root: the project has its rules, so nothing is asked. */
  exists: z.boolean(),
  /** The operator skipped the questionnaire for this project: it is not asked again. */
  skipped: z.boolean(),
  /** The branch the landing rules name — the remote's default, else the checked-out one, else `main`. */
  defaultBranch: z.string(),
})
export type FrizzMdStatus = z.infer<typeof FrizzMdStatus>

/** The screen's choices, in display order, each with the line it shows under its label. */
export const FRIZZ_MD_LANDING_CHOICES: readonly { value: FrizzMdLanding; label: (branch: string) => string; detail: string }[] = [
  {
    value: "pull-request",
    label: () => "Open a pull request",
    detail: "Each change goes on its own branch with a pull request. A human reviews and merges it.",
  },
  {
    value: "main",
    label: (branch) => `Commit to ${branch}`,
    detail: "Finished work is committed straight to the local branch. No pull requests, and nothing is pushed.",
  },
  {
    value: "main-push",
    label: (branch) => `Commit to ${branch} and push`,
    detail: "Finished work is committed and pushed after the project's checks pass. No pull requests.",
  },
  {
    value: "branch",
    label: () => "Leave it on a local branch",
    detail: "Each change is committed to its own local branch. A human merges it; nothing is pushed.",
  },
]

export const FRIZZ_MD_AUTONOMY_CHOICES: readonly { value: FrizzMdAutonomy; label: string; detail: string }[] = [
  {
    value: "decide",
    label: "Decide and proceed",
    detail: "Agents make every reversible call themselves and ask only about irreversible or product decisions.",
  },
  {
    value: "balanced",
    label: "Ask about big choices",
    detail: "Agents make routine calls themselves and ask before a significant design or scope decision.",
  },
  {
    value: "check-in",
    label: "Check in often",
    detail: "Agents confirm a plan before they write substantial code, and ask when anything is unclear.",
  },
]

export const FRIZZ_MD_DEFAULT_ANSWERS: FrizzMdAnswers = { landing: "pull-request", autonomy: "decide", notes: "" }

function landingRule(landing: FrizzMdLanding, branch: string): string {
  const b = `\`${branch}\``
  switch (landing) {
    case "pull-request":
      return `Never commit directly to ${b}. Put each change on its own branch, push it, and open a pull request against ${b}. Never merge a pull request yourself: a human reviews and merges it. Your work is not finished until the pull request is open with its checks passing.`
    case "main":
      return `Commit finished work directly to the local ${b} branch. Do not open pull requests, and do not push to the remote: a human pushes. Commit at each coherent checkpoint, and always commit completed work before you stop.`
    case "main-push":
      return `Commit finished work directly to ${b} and push it to the remote. Do not open pull requests. Run the project's checks before every push, and never force-push.`
    case "branch":
      return `Never commit directly to ${b}, and do not push to the remote. Commit each change to its own local branch and say which branch in your write-up: a human reviews and merges it.`
  }
}

function autonomyRule(autonomy: FrizzMdAutonomy): string {
  switch (autonomy) {
    case "decide":
      return "Decide and proceed. Make every reversible call yourself — names, defaults, error messages, which of two equivalent designs — and say in your write-up which way you went. Ask only before something destructive or irreversible, an external-facing action, or a product decision that is genuinely the human's to make."
    case "balanced":
      return "Make routine implementation calls yourself and say which way you went. Ask before a significant design choice, a change of scope, or anything destructive or irreversible."
    case "check-in":
      return "Check in before acting. Confirm your plan with the human before you write substantial code, and ask about any decision the task does not make obvious."
  }
}

/** The FRIZZ.md the answers produce. Deterministic: the preview and the written file are this string. */
export function composeFrizzMd(answers: FrizzMdAnswers, defaultBranch: string): string {
  const sections = [
    "# Frizz worker norms",
    "Frizz adds this file to the system prompt of every agent it starts in this project. No other coding-agent session reads it: Claude Code, Codex or any other agent you start yourself is unaffected. Edit it freely; the next agent Frizz starts reads the new version.",
    "## Landing changes",
    landingRule(answers.landing, defaultBranch),
    "## Working independently",
    autonomyRule(answers.autonomy),
  ]
  const notes = answers.notes.trim()
  if (notes) sections.push("## Project notes", notes)
  return `${sections.join("\n\n")}\n`
}
