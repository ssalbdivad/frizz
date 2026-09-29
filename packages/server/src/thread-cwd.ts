import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { ThreadWorkingDir, TranscriptMessage, WorkCheckout } from "@frizz/shared"

// WHERE A THREAD IS WORKING NOW — the folder a terminal opened on it starts in (thread-terminals.ts).
//
// Frizz records only where a thread was LAUNCHED (project.ts workDirOf), and that stops being the answer
// the moment an agent moves: Frizz deliberately stays out of the worktree decision, so an agent that
// wants isolation makes its own worktree (`git worktree add .frizz/worktrees/x`, Claude Code's
// EnterWorktree) and works there. A terminal that opened in the project root then ran `npm test` against
// the wrong checkout — Colin's objection to the standalone Terminal tab upstream. So the terminal asks
// the agent's OWN latest reading of where it is:
//
//   CLAUDE — every transcript record carries the session's `cwd`, and it moves. Checked against real
//     transcripts on 2026-09-29 (~/.claude/projects): a Bash `cd` into a folder inside the project
//     moves it and keeps it moved (e.g. `cd .frizz/worktrees/pre-queue-check` → every later record's
//     `cwd` is that worktree); a `cd` OUTSIDE the project does not stick, because Claude Code resets the
//     shell to the project and says so; and EnterWorktree moves it for the rest of the session (a live
//     `claude -p` run: `cwd` went from the repo to `<repo>/.claude/worktrees/probe` on the first record
//     after the tool call, and the transcript was re-bucketed under the worktree's log dir). Not every
//     record has one — a trailing `cost-state` record does not — so the newest record that DOES wins.
//   CODEX — a rollout's tool calls carry the `workdir` each command ran in (transcript.ts reads it for
//     the tool card), so the newest one is where the agent last worked; before any tool call, the
//     session's own recorded folder (`codex_app_server_session.cwd`).
//   ANYTHING ELSE, or no reading at all — the project root.
//
// A reading is then lifted to the CHECKOUT it lies in: the agent's cwd is often a subfolder it `cd`ed
// into for one grep (`packages/web/src`), and the terminal belongs in the checkout — the project root, or
// the worktree — not in whatever folder the last command happened to need. The walk stops at the project
// root, so a project that is itself a folder inside a larger repository is never climbed out of. The
// human sees the result in the terminal dialog and can edit it before anything starts.

/** How far back the Claude reader looks for a record with a `cwd`. Every record but a handful of
 *  bookkeeping ones carries it, so the newest is almost always in the last few KiB; the bound is only
 *  there so a pathological file cannot turn one click into a whole-transcript scan. */
const CWD_SCAN_BYTES = 8 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024

/** The newest `cwd` a Claude transcript records, reading backwards from the end. A sub-agent's records
 *  (`isSidechain`) are skipped: the terminal follows the thread's own agent. */
export function newestTranscriptCwd(path: string, maxBytes = CWD_SCAN_BYTES): string | undefined {
  let fd: number
  try {
    fd = openSync(path, "r")
  } catch {
    return undefined
  }
  try {
    const size = statSync(path).size
    const floor = Math.max(0, size - maxBytes)
    let end = size
    // The part of a line that straddles two chunks: the head of the line is in the NEXT chunk read.
    let carry = Buffer.alloc(0)
    while (end > floor) {
      const start = Math.max(floor, end - CHUNK_BYTES)
      const chunk = Buffer.alloc(end - start)
      readSync(fd, chunk, 0, chunk.length, start)
      const text = Buffer.concat([chunk, carry])
      // The first piece may be the tail end of a line that began before this chunk: keep its BYTES for the
      // next read (a chunk boundary can split a multi-byte character, so it is never decoded alone) —
      // unless this chunk starts the scan window, where it is whole or cut by the bound; try it anyway.
      const firstBreak = start > floor ? text.indexOf(0x0a) : -1
      carry = start > floor ? (firstBreak === -1 ? text : text.subarray(0, firstBreak)) : Buffer.alloc(0)
      const body = start > floor ? (firstBreak === -1 ? Buffer.alloc(0) : text.subarray(firstBreak + 1)) : text
      const lines = body.toString("utf8").split("\n")
      for (let i = lines.length - 1; i >= 0; i--) {
        const cwd = recordCwd(lines[i]!)
        if (cwd) return cwd
      }
      end = start
    }
    return undefined
  } finally {
    closeSync(fd)
  }
}

function recordCwd(line: string): string | undefined {
  // Cheap reject first: most of a transcript's bytes are tool output with no `cwd` key at all.
  if (!line.includes('"cwd"')) return undefined
  try {
    const record = JSON.parse(line) as { cwd?: unknown; isSidechain?: unknown }
    if (record.isSidechain === true) return undefined
    return typeof record.cwd === "string" && isAbsolute(record.cwd) ? record.cwd : undefined
  } catch {
    return undefined
  }
}

/** The folder the newest tool call in a parsed transcript ran in — Codex's `workdir`. Relative readings
 *  resolve against `base`, the folder the session itself runs in. */
export function newestToolWorkdir(messages: readonly TranscriptMessage[], base: string): string | undefined {
  for (let m = messages.length - 1; m >= 0; m--) {
    const tools = messages[m]!.tools ?? []
    for (let t = tools.length - 1; t >= 0; t--) {
      const cwd = tools[t]!.cwd?.trim()
      if (cwd) return isAbsolute(cwd) ? cwd : resolve(base, cwd)
    }
  }
  return undefined
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function within(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** Lift a folder to the checkout it lies in: the nearest ancestor holding a `.git` (a directory for the
 *  main checkout, a file for a linked worktree). The walk stops AT the project root when the folder is
 *  inside the project, so a project that is a subfolder of a bigger repository stays the project. No
 *  checkout found ⇒ the folder itself. */
export function checkoutOf(dir: string, projectDir: string): string {
  const inside = within(dir, projectDir)
  let at = dir
  for (;;) {
    if (inside && at === projectDir) return projectDir
    if (existsSync(join(at, ".git"))) return at
    const up = dirname(at)
    if (up === at) return dir
    at = up
  }
}

// ── ONE CHECKOUT READING, shared by every surface ─────────────────────────────────────────────────────
//
// The agent's own folder (the tailer's fold), each background shell's start folder, a human terminal's
// folder and the terminal dialog's prefill all go through `liftCheckout`, so the drawer header, the card,
// a shell row and the dialog can never classify one folder two ways. Nothing else classifies a checkout.
//
// It is MEMOIZED because the tailer asks it on every tick for every thread (the board signature carries
// the agent's checkout, so a move into a worktree pushes exactly one delta): one `.git` walk and one stat
// per new folder, then a map hit. The TTL is what lets a worktree that was removed since stop reading as
// present; 60s is well inside how long anyone looks at a stale token before it matters.
const LIFT_TTL_MS = 60_000
const LIFT_MAX = 256
interface LiftReading {
  /** The folder's checkout — the project root included. */
  dir: string
  /** Present only when that checkout is NOT the project root. */
  checkout?: WorkCheckout
}
const liftMemo = new Map<string, { at: number; value: LiftReading | undefined }>()

function sameFolder(a: string, b: string): boolean {
  if (a === b) return true
  // macOS spells `/tmp/x` as `/private/tmp/x` once a process resolves it, and a transcript records the
  // resolved one: compare the real paths before calling the project root "somewhere else".
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

/** `dir` lifted to its checkout (checkoutOf), and whether that checkout is the project root. Undefined
 *  when the folder does not exist — no reading, never a stale name. */
export function liftWorkingDir(dir: string | undefined, projectDir: string | undefined, nowMs = Date.now()): LiftReading | undefined {
  if (!dir || !projectDir || !isAbsolute(dir)) return undefined
  const key = `${projectDir}\u0000${dir}`
  const hit = liftMemo.get(key)
  if (hit && nowMs - hit.at < LIFT_TTL_MS) return hit.value
  let value: LiftReading | undefined
  if (isDirectory(dir)) {
    const checkout = checkoutOf(dir, projectDir)
    if (sameFolder(checkout, projectDir)) value = { dir: projectDir }
    else value = { dir: checkout, checkout: { dir: checkout, kind: isFile(join(checkout, ".git")) ? "worktree" : "folder" } }
  }
  liftMemo.delete(key)
  liftMemo.set(key, { at: nowMs, value })
  while (liftMemo.size > LIFT_MAX) {
    const oldest = liftMemo.keys().next().value
    if (oldest === undefined) break
    liftMemo.delete(oldest)
  }
  return value
}

/** `dir` lifted to its checkout and classified; undefined when that checkout IS the project root (or the
 *  folder is gone). kind "worktree" iff the checkout's `.git` is a FILE. */
export function liftCheckout(dir: string | undefined, projectDir: string | undefined, nowMs = Date.now()): WorkCheckout | undefined {
  return liftWorkingDir(dir, projectDir, nowMs)?.checkout
}

/** Test seam: the memo is process-lifetime state keyed by path. */
export function resetCheckoutMemo(): void {
  liftMemo.clear()
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export interface ThreadDirReading {
  projectDir: string
  backend: "claude" | "codex" | "acp"
  /** The thread's transcript on disk, when it has one. */
  transcriptPath?: string
  /** Codex only: the parsed rollout, read on demand (it is the only reader that knows both tool protocols). */
  codexMessages?: () => readonly TranscriptMessage[]
  /** Codex only: the app-server session's recorded folder. */
  sessionCwd?: string
}

export function resolveThreadWorkingDir(reading: ThreadDirReading): ThreadWorkingDir {
  const { projectDir } = reading
  const settle = (dir: string | undefined): string | undefined => (dir && isDirectory(dir) ? checkoutOf(dir, projectDir) : undefined)
  if (reading.backend === "claude" && reading.transcriptPath) {
    const dir = settle(newestTranscriptCwd(reading.transcriptPath))
    if (dir) return { dir, source: "transcript" }
  }
  if (reading.backend === "codex") {
    const base = reading.sessionCwd ?? projectDir
    let messages: readonly TranscriptMessage[] = []
    try {
      messages = reading.codexMessages?.() ?? []
    } catch {
      // An unreadable rollout is no reading; fall through to the session's folder.
    }
    const dir = settle(newestToolWorkdir(messages, base))
    if (dir) return { dir, source: "transcript" }
    const session = settle(reading.sessionCwd)
    if (session) return { dir: session, source: "session" }
  }
  return { dir: projectDir, source: "project" }
}

/** The folder a terminal start names, checked: `~` expanded, absolute, and an existing directory.
 *  Throws the message the drawer shows. */
export function terminalFolder(input: string): string {
  const raw = input.trim()
  const expanded = raw === "~" ? homedir() : raw.startsWith(`~/`) || raw.startsWith(`~${sep}`) ? join(homedir(), raw.slice(2)) : raw
  if (!isAbsolute(expanded)) throw new Error(`The folder must be an absolute path: ${raw}`)
  if (!isDirectory(expanded)) throw new Error(`No such folder: ${raw}`)
  return resolve(expanded)
}
