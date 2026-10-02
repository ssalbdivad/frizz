// THE SIDEBAR, END TO END, AS THE HUMAN USES IT — a real VS Code (under Xvfb), the extension as its .vsix
// ships, a real disposable two-project Frizz, and the REAL Frizz page framed in the sidebar. Every seam is
// exercised the way a person crosses it: keys and clicks are trusted input on the workbench (Chromium
// routes them through the webview into the page's frame), and what is asserted is read where it shows —
// the page's own DOM, VS Code's own title row and editor, the simulated worker's socket.
//
//   nub packages/vscode/scripts/e2e-sidebar.ts [--out=<dir>] [--dev] [--only=c1,c4] [--icon-before=<png>] [--worktree]
//   (or: nub packages/vscode/scripts/e2e.ts --sidebar [same flags])
//
//   --out    where the screenshots and results.json go (default: a `shots` dir in the run's scratch folder,
//            kept). Names are `<vscode version>-<what>.png`; `-window` is the whole window at 1x, the
//            rest are 2x renders of the sidebar (or of the part named).
//   --dev    run the extension from the source tree (dist/ as scripts/build.ts makes it) instead of the
//            packaged .vsix. The default is the .vsix, unpacked, because the maintainer's "the icon
//            doesn't display" was a package with no icon in it: the source tree had it all along.
//   --only   run only these checks (c1…c13); the boot, the seed and the view opening always run.
//   --icon-before=<png>   an earlier top-dark activity-bar strip (1x enlarged 6x, as c1 writes it) to set
//            beside this run's, for the eye.
//   --worktree  open the window on a thread's git worktree (`.frizz/worktrees/<slug>` of the workspace)
//            instead of the workspace, for c12's positive half; runs c12 alone unless --only says more,
//            because every other check is written against a window on the workspace itself.
//   FRIZZ_E2E_VSCODE=oldest|<version>   VS Code to run (default: stable). `oldest` is the manifest's floor.
//   FRIZZ_E2E_KEEP=1                    keep the scratch folder (logs, the stack's log) even on a pass.
//
// THE CHECKS (each one PASS/FAIL with its evidence in results.json, and a screenshot where it is visible):
//   c1 the Frizz icon in the activity bar, side and top, dark and light: its mask file loads, and its ink
//      is a line drawing the weight of the codicons beside it (within the bar's own spread of their mean)
//      — not a blank, not a solid square
//   c2 the view frames the real page, which says frizz:ready and draws no header and no lone ⌨ row; VS
//      Code's title row reads Frizz, its buttons follow the page's view, the badge's tooltip carries the
//      counts, and each button, clicked, does its thing in the page
//   c3 the context bar follows the editor: a selection, no selection, another editor, the open files
//   c4 Ctrl+L (Cursor's chord, the one the page names) in the editor: the sidebar revealed, the chip a pill
//      in the front composer, the caret after it, typing after it; sent to a thread with a simulated
//      worker, the context serialized and the transcript showing the chip; the context bar's click does the
//      same; Alt+K with only a caret adds the whole file; Ctrl+L pressed in the reply box goes back to the
//      editor, and Ctrl+L in the editor with nothing selected reveals the sidebar with the caret in the box
//   c5 "Ask Frizz to fix" on a real TypeScript error: chip + the problem as a note
//   c6 a code-file link opens in the editor at its range; a web link goes to openExternal (a stub
//      xdg-open, no browser); a Markdown link opens Frizz's reader
//   c7 a VS Code theme switch re-themes the page live
//   c8 keys with the frame focused: Ctrl+Shift+P is VS Code's palette, Ctrl+K Frizz's, `?` the shortcuts
//      sheet with its Editor group (Ctrl+L both ways first) and its VS Code group, the title row's ⋯
//      Keyboard shortcuts opening the same sheet, Ctrl+1 back to the editor
//   c9 the gallery: queue (dark, light), a thread with a selection and a chip, the open-files menu,
//      Settings, the shortcuts sheet — at ~300px and ~450px
//   c10 one switch: the bar's eye, clicked, turns `frizz.shareEditorState` off — the worker's real `editor`
//      tool (frizz-mcp.mjs) then reads nothing and a send carries no block; the setting turned back on in
//      VS Code turns the eye on, the tool reads the selection, a send quotes it, and the next send of the
//      same selection names it instead of quoting it again
//   c11 Claude Code: a stand-in extension with its id (anthropic.claude-code) and its Alt+K, installed
//      live — Alt+K is then its (its binding answers, nothing reaches Frizz) and the `?` sheet drops the
//      row; uninstalled, Alt+K is Frizz's again
//   c12 the window's own thread: a window opened on a thread's worktree opens the sidebar on that thread
//      (--worktree); a window on the project itself opens on the queue (every other run, the control)
//   c13 a restart and a window reload (last: the test runner's VS Code ends with a reload, so the same
//      profile is reopened by a VS Code of the harness's own): the framed page's localStorage survives
//      both, and so does the eye, which is the VS Code setting
//
// NEVER ON THE REAL DISPLAY. On Linux the run re-executes itself under `xvfb-run -a` with DISPLAY and
// WAYLAND_DISPLAY removed (DISPLAY=:0 here is the maintainer's screen through WSLg). The editor gets its
// own user-data and extensions directories; every opener anything could spawn — the server's and VS Code's
// own `xdg-open` — is a stub on PATH that only writes down what it was asked. No agent is ever started:
// the one thread a message is sent to has a simulated worker (e2e/fake-broker.ts). Everything is torn
// down by process group, exact pid, the sandbox HOME and the run's own user-data dir, pass or fail, and
// the run fails if anything survives.

import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron"
import puppeteer, { type Browser, type CDPSession, type ElementHandle, type Frame, type Page } from "puppeteer"
import { parseSentContext, parseSentEditorContext } from "../../web/src/lib/composerContext.ts"
import type { AgentOp, AgentStatus, EditorState, SettingState } from "../e2e/sidebar-agent.ts"
import { decodePng, inkOf } from "../e2e/png.ts"
import { SAMPLE, seedSidebarStack, seedWorktreeThread, type Seeded } from "../e2e/sidebar-seed.ts"
import { bootStack, freePort, killAll, leftovers, stubbedPath, type Stack } from "../e2e/stack.ts"
import { workerTool } from "../e2e/worker-tool.ts"

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repo = resolve(pkg, "..", "..")


if (process.platform === "linux" && process.env.FRIZZ_E2E_UNDER_XVFB !== "1") {
  const env: NodeJS.ProcessEnv = { ...process.env, FRIZZ_E2E_UNDER_XVFB: "1" }
  delete env.DISPLAY
  delete env.WAYLAND_DISPLAY
  const child = spawnSync("xvfb-run", ["-a", "-s", "-screen 0 1920x1200x24", "nub", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit", env })
  if (child.error) {
    console.error(`xvfb-run could not start (${child.error.message}). Install it (apt install xvfb); this harness never uses the real display.`)
    process.exit(1)
  }
  process.exit(child.status ?? 1)
}
if (process.platform === "linux" && (!process.env.DISPLAY || process.env.DISPLAY === ":0" || process.env.WAYLAND_DISPLAY)) {
  console.error(`refusing to run on DISPLAY=${process.env.DISPLAY} / WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY}: that is a real screen`)
  process.exit(1)
}

const flag = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const devMode = process.argv.includes("--dev")
const worktreeWindow = process.argv.includes("--worktree")
const only = flag("only")?.split(",").map((id) => id.trim()) ?? (worktreeWindow ? ["c12"] : undefined)
const wanted = (id: string) => !only || only.includes(id)

function vscodeVersion(): string {
  const asked = process.env.FRIZZ_E2E_VSCODE ?? "stable"
  if (asked !== "oldest") return asked
  const engines = (JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { engines: { vscode: string } }).engines.vscode
  return engines.replace(/^[\^~>=]+/u, "")
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "frizz-vscode-sidebar-e2e-")))
const out = resolve(flag("out") ?? join(scratch, "shots"))
mkdirSync(out, { recursive: true })
const log = (line: string) => console.log(`frizz sidebar e2e: ${line}`)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ── results ───────────────────────────────────────────────────────────────────────────────────────────

interface Result {
  check: string
  name: string
  ok: boolean
  detail?: unknown
}
const results: Result[] = []
/** Observations that are not pass/fail — timings, what a surface read, what looked off. */
const notes: Record<string, unknown> = {}
const shots: string[] = []

function expect(check: string, name: string, ok: boolean, detail?: unknown): boolean {
  results.push({ check, name, ok, ...(detail === undefined ? {} : { detail }) })
  console.log(`  ${ok ? "PASS" : "FAIL"} ${check} ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail).slice(0, 400)}`}`)
  return ok
}

async function waitFor<T>(what: string, probe: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await Promise.resolve(probe()).catch(() => undefined)
    if (value !== undefined && value !== null && value !== false) return value as T
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${what}`)
    await sleep(100)
  }
}

/** True once `probe` holds, false at the deadline — for a step that records the miss rather than stopping. */
async function until(probe: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
  return waitFor("", async () => (await probe()) || undefined, ms).then(() => true, () => false)
}

// ── teardown ──────────────────────────────────────────────────────────────────────────────────────────

let stack: Stack | undefined
let stackTeardown: (() => Promise<void>) | undefined
let seeded: Seeded | undefined
let browser: Browser | undefined
let warmBrowser: Browser | undefined
let suite: Promise<number> | undefined
let agentServer: ReturnType<typeof createServer> | undefined
let finishAgent: (() => void) | undefined
let tornDown = false
const userData = join(scratch, "user-data")

/** VS Code processes of this run: every one carries its user-data dir on its command line. */
const editors = () => leftovers(`/nonexistent-home-${process.pid}`, userData)

async function teardown(): Promise<string[]> {
  if (tornDown) return []
  tornDown = true
  const survivors: string[] = []
  await browser?.disconnect().catch(() => undefined)
  await warmBrowser?.close().catch(() => undefined)
  finishAgent?.()
  if (suite) await Promise.race([suite, sleep(30_000)])
  const editorsLeft = await killAll(editors)
  if (editorsLeft.length) survivors.push(`VS Code: ${editorsLeft.join(", ")}`)
  agentServer?.close()
  if (seeded && seeded.broker.exitCode === null && seeded.broker.signalCode === null) seeded.broker.kill("SIGTERM")
  const home = stack?.info.home
  await stackTeardown?.()
  if (home) {
    const strays = leftovers(home)
    if (strays.length) survivors.push(`sandbox HOME: ${strays.join(", ")}`)
  }
  log(survivors.length ? `STILL RUNNING after teardown: ${survivors.join("; ")}` : "torn down: no VS Code of this run, no stack, nothing with its HOME")
  return survivors
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`${signal}: tearing down`)
    void teardown().finally(() => process.exit(130))
  })
}

// ── the editor's half: an agent inside VS Code that runs what it is asked (e2e/sidebar-agent.ts) ─────────

let agentSeq = 0
const agentQueue: { seq: number; op: AgentOp }[] = []
const agentAnswers = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
let agentWaiting: { after: number; res: ServerResponse; timer: NodeJS.Timeout } | undefined
let agentSeen: () => void = () => undefined
const agentUp = new Promise<void>((resolve) => (agentSeen = resolve))

function flushAgent(): void {
  if (!agentWaiting) return
  const next = agentQueue.find((entry) => entry.seq > agentWaiting!.after)
  if (!next) return
  clearTimeout(agentWaiting.timer)
  agentWaiting.res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(next))
  agentWaiting = undefined
}

async function body(req: IncomingMessage): Promise<string> {
  let text = ""
  for await (const chunk of req) text += chunk
  return text
}

async function startAgentServer(): Promise<string> {
  agentServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (req.method === "GET" && url.pathname === "/next") {
      agentSeen()
      if (agentWaiting) agentWaiting.res.writeHead(204).end()
      agentWaiting = { after: Number(url.searchParams.get("after") ?? 0), res, timer: setTimeout(() => {
        if (agentWaiting?.res === res) agentWaiting = undefined
        res.writeHead(204).end()
      }, 20_000) }
      flushAgent()
      return
    }
    if (req.method === "POST" && url.pathname === "/answer") {
      void body(req).then((text) => {
        const answer = JSON.parse(text) as { seq: number; ok: boolean; value?: unknown; error?: string }
        const waiter = agentAnswers.get(answer.seq)
        agentAnswers.delete(answer.seq)
        if (answer.ok) waiter?.resolve(answer.value)
        else waiter?.reject(new Error(answer.error))
        res.writeHead(204).end()
      })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => agentServer!.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${(agentServer.address() as { port: number }).port}`
}

function agent<T = unknown>(op: AgentOp, ms = 60_000): Promise<T> {
  const seq = ++agentSeq
  agentQueue.push({ seq, op })
  flushAgent()
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      agentAnswers.delete(seq)
      reject(new Error(`the editor did not answer ${op.op} within ${ms / 1000}s`))
    }, ms)
    agentAnswers.set(seq, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value as T)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
  })
}
const status = () => agent<AgentStatus>({ op: "status" })
const command = (id: string, ...args: unknown[]) => agent({ op: "command", id, args })
const editorState = () => agent<EditorState>({ op: "editor" })

// ── the workbench and the page in its sidebar ─────────────────────────────────────────────────────────

let page!: Page
let cdp!: CDPSession
let origin = ""
let version = ""
const pageErrors: string[] = []
/** VS Code's keybinding dispatch log (workbench.action.toggleKeybindingsLog), while it is on. */

const frizzFrame = (): Frame | undefined => page.frames().find((frame) => frame.url().startsWith(`${origin}/`))
const frame = () => waitFor("the Frizz frame in the sidebar", frizzFrame, 30_000)

/** Evaluate in the Frizz page. */
async function inPage<T, A extends unknown[]>(fn: (...args: A) => T, ...args: A): Promise<Awaited<T>> {
  return (await frame()).evaluate(fn as never, ...(args as unknown as never[])) as Promise<Awaited<T>>
}

/** Evaluate in the workbench. */
const inWorkbench = <T>(fn: () => T) => page.evaluate(fn) as Promise<Awaited<T>>

/** A trusted click at an element's centre, in the frame or the workbench. */
async function clickHandle(handle: ElementHandle | null, what: string): Promise<void> {
  if (!handle) throw new Error(`${what}: not there`)
  await handle.evaluate((element) => (element as Element).scrollIntoView({ block: "nearest" }))
  const box = await handle.boundingBox()
  if (!box) throw new Error(`${what}: not visible`)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

async function clickInPage(selector: string, what = selector): Promise<void> {
  const handles = await (await frame()).$$(selector)
  for (const handle of handles) {
    if (await handle.boundingBox()) return clickHandle(handle, what)
  }
  throw new Error(`${what}: no visible ${selector} in the page`)
}

/** Click the first visible element in the page whose text includes `text`, among `selector`. */
async function clickTextInPage(selector: string, text: string): Promise<void> {
  const handle = (await (await frame()).evaluateHandle((s, t) => [...document.querySelectorAll(s)].find((element) => element.textContent?.includes(t) && element.getClientRects().length > 0) ?? null, selector, text)).asElement() as ElementHandle | null
  await clickHandle(handle, `${selector} with "${text}"`)
}

/**
 * Click `selector` inside the composer whose box is `surface`. The page keeps the queue's prompt box
 * mounted under an open drawer, so a bare selector can resolve to the one hidden behind it — and the
 * click then lands on whatever the drawer draws at that spot (once, the drawer's open-in-browser button).
 */
async function clickInComposer(surface: "chatComposer" | "newComposer", selector: string): Promise<void> {
  const handle = (await (await frame()).evaluateHandle((s, sel) => {
    const box = [...document.querySelectorAll(`textarea[data-surface="${s}"]`)].find((t) => t.getClientRects().length > 0)
    let scope: Element | null = box?.parentElement ?? null
    while (scope && !scope.querySelector(sel)) scope = scope.parentElement
    return scope?.querySelector(sel) ?? null
  }, surface, selector)).asElement() as ElementHandle | null
  await clickHandle(handle, `${selector} on the ${surface}`)
}

async function clickInWorkbench(selector: string): Promise<void> {
  // A view's title-row buttons show only while the pointer is over the side bar or it has focus
  // (VS Code's `workbench.view.alwaysShowHeaderActions`, off by default): the hand goes there first.
  if (selector.includes(".title-actions")) {
    const title = await rectOf(".part.sidebar .composite.title")
    if (title) {
      await page.mouse.move(title.x + 12, title.y + title.height / 2)
      await until(async () => !!(await (await page.$(selector))?.boundingBox()), 2_000)
    }
  }
  await clickHandle(await page.$(selector), selector)
}

/** A chord as a keyboard presses it: `Control+Shift+KeyP`. */
async function press(chord: string): Promise<void> {
  const parts = chord.split("+")
  const key = parts.pop()!
  for (const modifier of parts) await page.keyboard.down(modifier as never)
  await page.keyboard.press(key as never)
  for (const modifier of [...parts].reverse()) await page.keyboard.up(modifier as never)
}

/** A prompt box in the page: the visible textarea of that surface, and what its backdrop shows. */
interface BoxState {
  value: string
  active: boolean
  frameFocused: boolean
  caret: number
  /** The pills the box's backdrop draws over its chips: their token and painted background. */
  pills: { token: string; background: string; ring: string }[]
}
const box = (surface: "chatComposer" | "newComposer") =>
  inPage((s) => {
    const el = [...document.querySelectorAll<HTMLTextAreaElement>(`textarea[data-surface="${s}"]`)].find((t) => t.getClientRects().length > 0)
    if (!el) return null
    let scope: HTMLElement | null = el.parentElement
    while (scope && !scope.querySelector("[data-context-token]") && scope.parentElement && !scope.matches("[data-composer-root], form")) scope = scope.parentElement
    const pills = [...(scope?.querySelectorAll<HTMLElement>("[data-context-token]") ?? [])].map((pill) => ({ token: pill.dataset.contextToken ?? "", background: getComputedStyle(pill).backgroundColor, ring: getComputedStyle(pill).boxShadow }))
    return { value: el.value, active: document.activeElement === el, frameFocused: document.hasFocus(), caret: el.selectionStart, pills }
  }, surface) as Promise<BoxState | null>

/** The context bar on a prompt box: what it reads, and in which state. */
const contextBar = (surface: "chatComposer" | "newComposer") =>
  inPage((s) => {
    const el = [...document.querySelectorAll<HTMLTextAreaElement>(`textarea[data-surface="${s}"]`)].find((t) => t.getClientRects().length > 0)
    let scope: HTMLElement | null = el?.parentElement ?? null
    while (scope && !scope.querySelector("[data-editor-context-bar]")) scope = scope.parentElement
    const bar = scope?.querySelector<HTMLElement>("[data-editor-context-bar]")
    if (!bar) return null
    const reading = bar.querySelector<HTMLElement>("[data-editor-context]")
    return {
      kind: reading?.dataset.editorContext ?? null,
      text: reading?.innerText.replace(/\s+/gu, " ").trim() ?? null,
      label: reading?.getAttribute("aria-label") ?? null,
      hint: bar.querySelector<HTMLElement>("[data-editor-context-hint]")?.innerText ?? null,
      openFiles: bar.querySelector<HTMLElement>("[data-editor-open-files]")?.getAttribute("aria-label") ?? null,
      color: reading ? getComputedStyle(reading.parentElement!).color : null,
      background: reading ? getComputedStyle(reading.parentElement!).backgroundColor : null,
    }
  }, surface)

const drawerOpen = async () => (await box("chatComposer")) !== null

/** VS Code's title row over the sidebar: what it reads and the buttons it shows. */
const titleRow = () =>
  inWorkbench(() => {
    const title = document.querySelector(".part.sidebar .composite.title")
    const label = title?.querySelector(".title-label")
    const h2 = label?.querySelector("h2")
    return {
      text: (label as HTMLElement | null)?.innerText.replace(/\s+/gu, " ").trim() ?? "",
      words: h2?.textContent ?? "",
      transform: h2 ? getComputedStyle(h2).textTransform : "",
      sidebarText: (document.querySelector(".part.sidebar") as HTMLElement | null)?.innerText.replace(/\s+/gu, " ").slice(0, 200) ?? "",
      tooltip: label?.getAttribute("title") ?? label?.querySelector("h2")?.getAttribute("title") ?? "",
      html: label?.outerHTML.slice(0, 600) ?? "",
      buttons: [...(title?.querySelectorAll<HTMLElement>(".title-actions .action-label") ?? [])].filter((a) => a.offsetWidth > 0).map((a) => a.getAttribute("aria-label") ?? "").filter((label) => !/More Actions/u.test(label)),
    }
  })

const paletteOpen = () =>
  inWorkbench(() => {
    const widget = document.querySelector<HTMLElement>(".quick-input-widget")
    return !!widget && getComputedStyle(widget).display !== "none" && widget.offsetHeight > 0
  })

/**
 * Where focus is in the workbench: the editor, the sidebar's webview, something else. A webview view's
 * iframe is not in the side bar's DOM — VS Code lays it over the view from a container of its own — so
 * "in the sidebar" is a webview iframe drawn over `.part.sidebar`; one with no box is a HIDDEN webview
 * holding the keyboard (the view is closed, its page kept alive), which no human can see or type into.
 */
const workbenchFocus = () =>
  inWorkbench(() => {
    const active = document.activeElement as HTMLElement | null
    const part = document.querySelector(".part.sidebar")?.getBoundingClientRect()
    const r = active?.getBoundingClientRect()
    const webview = active?.tagName === "IFRAME" && active.classList.contains("webview")
    const shown = !!r && r.width > 0 && r.height > 0 && getComputedStyle(active!).visibility !== "hidden"
    const overSidebar = !!part && !!r && part.width > 0 && r.left + r.width / 2 > part.left && r.left + r.width / 2 < part.right && r.top + r.height / 2 > part.top && r.top + r.height / 2 < part.bottom
    return {
      editor: !!active?.closest(".editor-group-container .monaco-editor"),
      sidebar: !!active?.closest(".part.sidebar") || (webview && shown && overSidebar),
      hiddenWebview: webview && !(shown && overSidebar),
      box: r ? [Math.round(r.width), Math.round(r.height)] : null,
      tag: active?.tagName ?? null,
      cls: active?.className?.toString().slice(0, 80) ?? null,
    }
  })

/**
 * Type into a prompt box — only if the caret is in it. In the page a bare letter is a shortcut (`d` marks
 * the thread being read done, `t` opens a terminal), so text typed after the caret was lost acts on the
 * board: a run that types blind corrupts every check after it. A lost caret is the finding; this refuses.
 */
async function typeInto(surface: "chatComposer" | "newComposer", text: string): Promise<void> {
  const state = await box(surface)
  if (!state?.active || !state.frameFocused) throw new Error(`the caret is not in the ${surface} (${JSON.stringify(state && { active: state.active, frameFocused: state.frameFocused })}); not typing into the page's shortcuts`)
  await page.keyboard.type(text, { delay: 15 })
}

/** Where the caret is a human's pause after an action: a focus taken back a beat later shows here, not at once. */
async function caretAfterPause(surface: "chatComposer" | "newComposer", ms = 1_500) {
  await sleep(ms)
  return { box: await box(surface), focus: await workbenchFocus(), pageActive: await inPage(() => ({ tag: document.activeElement?.tagName ?? null, surface: (document.activeElement as HTMLElement | null)?.dataset?.surface ?? null })) }
}

/**
 * WHO MOVED THE CARET. A trace in each document between the workbench and the page — the page, the
 * extension's relay that frames it (src/sidebar-html.ts), and VS Code's webview host around that — of
 * focusin/focusout, the window's focus and blur, and every programmatic `focus()`/`blur()` with the stack
 * that called it (the call site a report can name), each with what holds focus in that document after
 * it. The workbench is polled every 50ms for what holds focus (the editor, the sidebar's webview,
 * something else). All stamp `Date.now()`, one clock, so a step's slice of each lines up.
 */
function traceInstaller() {
  const w = window as unknown as { __focusTrace?: unknown[] }
  if (w.__focusTrace) return
  const trace: unknown[] = (w.__focusTrace = [])
  const describe = (el: EventTarget | Element | null): string => {
    if (!(el instanceof Element)) return el === null ? "null" : String((el as { constructor?: { name?: string } }).constructor?.name)
    const h = el as HTMLElement
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${h.dataset?.surface ? `[${h.dataset.surface}]` : ""}${el.getAttribute("aria-label") ? ` "${el.getAttribute("aria-label")}"` : ""}`
  }
  const push = (kind: string, el: EventTarget | null, stack?: string) =>
    trace.push({ at: Date.now(), kind, el: describe(el), active: describe(document.activeElement), hasFocus: document.hasFocus(), ...(stack ? { stack } : {}) })
  const stackOf = () => (new Error().stack ?? "").split("\n").slice(2, 8).map((line) => line.trim().replace(/(https?|vscode-webview):\/\/[^/]+/u, "")).join(" | ")
  document.addEventListener("focusin", (event) => push("focusin", event.target), true)
  document.addEventListener("focusout", (event) => push("focusout", event.target), true)
  window.addEventListener("focus", () => push("window-focus", null))
  window.addEventListener("blur", () => push("window-blur", null))
  const focus = HTMLElement.prototype.focus
  HTMLElement.prototype.focus = function (this: HTMLElement, ...args: Parameters<HTMLElement["focus"]>) {
    const stack = stackOf()
    const result = focus.apply(this, args)
    push("focus()", this, stack)
    return result
  }
  const blur = HTMLElement.prototype.blur
  HTMLElement.prototype.blur = function (this: HTMLElement) {
    const stack = stackOf()
    const result = blur.apply(this)
    push("blur()", this, stack)
    return result
  }
}

/** The documents from the page up to (not including) the workbench, named. */
function tracedFrames(): { name: string; frame: Frame }[] {
  const pageFrame = frizzFrame()
  if (!pageFrame) return []
  const names = ["page", "relay", "webview-host", "webview-outer"]
  const out: { name: string; frame: Frame }[] = []
  for (let frame: Frame | null = pageFrame, i = 0; frame && frame !== page.mainFrame(); frame = frame.parentFrame(), i++) out.push({ name: names[i] ?? `frame${i}`, frame })
  return out
}

async function installFocusTrace(): Promise<void> {
  for (const { frame } of tracedFrames()) await frame.evaluate(traceInstaller).catch(() => undefined)
  await page.evaluate(() => {
    const w = window as unknown as { __focusTrace?: unknown[] }
    if (w.__focusTrace) return
    const trace: unknown[] = (w.__focusTrace = [])
    let last = ""
    setInterval(() => {
      const active = document.activeElement
      const where = !active ? "none" : active.closest(".editor-group-container .monaco-editor") ? "editor" : active.closest(".part.sidebar") ? "sidebar" : active.tagName === "IFRAME" ? `iframe(${(active as HTMLElement).className}${(active as HTMLElement).getBoundingClientRect().width > 0 ? "" : ", no box"})` : `${active.tagName.toLowerCase()}.${(active as HTMLElement).className.toString().slice(0, 40)}`
      if (where !== last) trace.push({ at: Date.now(), where })
      last = where
    }, 50)
  })
}

/** Every trace from `since` on, times relative to it, merged into one timeline. */
async function focusTraceSince(since: number) {
  const read = (frame: Frame) => frame.evaluate(() => ((window as unknown as { __focusTrace?: { at: number }[] }).__focusTrace ?? [])).catch(() => [] as { at: number }[])
  const rows: Record<string, unknown>[] = []
  for (const { name, frame } of tracedFrames()) for (const entry of await read(frame)) if (entry.at >= since) rows.push({ ...entry, at: entry.at - since, in: name })
  for (const entry of await read(page.mainFrame())) if (entry.at >= since) rows.push({ ...entry, at: entry.at - since, in: "workbench" })
  return rows.sort((a, b) => (a.at as number) - (b.at as number))
}

/** The extension's output channel, as VS Code writes it to the run's logs. */
function frizzLog(): string {
  try {
    const found = execFileSync("find", [join(userData, "logs"), "-name", "Frizz.log"], { encoding: "utf8" }).trim().split("\n").filter(Boolean)
    return found.map((file) => readFileSync(file, "utf8")).join("\n")
  } catch {
    return ""
  }
}

/** Back to a clean queue: the title row's own command, which closes every drawer and overlay (lib/embedCommand.ts). */
async function resetPage(): Promise<void> {
  await command("frizz.sidebar.queue")
  await until(async () => !(await drawerOpen()) && !(await inPage(() => !!document.querySelector("[data-shortcut-list], [cmdk-root], [data-settings-editor]"))), 8_000)
}

/** Open the seeded thread from its row in the page's list, with the mouse. The list names a thread by its handle. */
async function openThreadRow(): Promise<void> {
  await clickTextInPage("[data-xq-thread-row] button", seeded!.thread.handle)
  await waitFor("the thread's drawer", drawerOpen, 15_000)
}

/** Empty a prompt box the way a human does: click into it, select all, delete. */
async function clearBox(surface: "chatComposer" | "newComposer"): Promise<void> {
  if (!(await box(surface))?.value) return
  await clickInPage(`textarea[data-surface="${surface}"]`)
  if (!(await until(async () => (await box(surface))?.active === true, 3_000))) throw new Error(`could not put the caret in the ${surface} to clear it`)
  await press("Control+KeyA")
  await press("Backspace")
  await until(async () => (await box(surface))?.value === "", 3_000)
}

// ── screenshots ───────────────────────────────────────────────────────────────────────────────────────

async function capture(file: string, clip?: { x: number; y: number; width: number; height: number }, scale = 1): Promise<Buffer> {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale } } : {}), captureBeyondViewport: false })
  const png = Buffer.from(data, "base64")
  if (file) {
    writeFileSync(file, png)
    shots.push(file)
  }
  return png
}

const rectOf = (selector: string) =>
  page.evaluate((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect()
    return r ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : null
  }, selector)

/** The sidebar at 2x, and (with `window`) the whole window at 1x. */
async function shot(name: string, options: { window?: boolean } = {}): Promise<void> {
  const rect = await rectOf(".part.sidebar")
  // The pointer rests on the side bar's left edge: over the bar, so its title-row buttons stay shown, and
  // off every control, so no tooltip or hover state is in the picture.
  if (rect) await page.mouse.move(rect.x + 2, rect.y + rect.height / 2)
  await sleep(350)
  if (rect) await capture(join(out, `${version}-${name}.png`), rect, 2)
  if (options.window) await capture(join(out, `${version}-${name}-window.png`))
}

// ── c11's stand-in ────────────────────────────────────────────────────────────────────────────────────

/** A `.vsix` with Claude Code's id (anthropic.claude-code) and its Alt+K, bound to Select All so whose Alt+K answered shows. */
const claudeCodeStandIn = join(scratch, "claude-code-stub", "claude-code-stub.vsix")
function packClaudeCodeStandIn(): void {
  const dir = dirname(claudeCodeStandIn)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "claude-code", publisher: "anthropic", version: "0.0.1", displayName: "Claude Code (e2e stand-in)",
    description: "Claude Code's id and its Alt+K, for Frizz's end-to-end run.", engines: { vscode: "^1.90.0" },
    contributes: { keybindings: [{ command: "editor.action.selectAll", key: "alt+k", mac: "alt+k", when: "editorTextFocus" }] },
  }, null, 2))
  const packed = spawnSync("nubx", ["-y", "-p", "@vscode/vsce@3.9.2", "vsce", "package", "--no-dependencies", "--allow-missing-repository", "--skip-license", "--out", claudeCodeStandIn], { cwd: dir, stdio: "inherit" })
  if (packed.status !== 0) throw new Error("packaging the Claude Code stand-in failed")
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────────────

let exitCode = 1
let survivors: string[] = []
try {
  version = vscodeVersion()

  // The extension: as it ships (the .vsix, unpacked) unless --dev. The e2e build comes after the package,
  // because scripts/build.ts empties dist/ first.
  let extensionPath = pkg
  if (!devMode) {
    const packaged = spawnSync("nub", ["run", "package"], { cwd: pkg, stdio: "inherit" })
    if (packaged.status !== 0) throw new Error("packaging the .vsix failed")
    const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { name: string; version: string }
    const vsix = join(pkg, "dist", `${manifest.name}-${manifest.version}.vsix`)
    execFileSync("unzip", ["-q", vsix, "-d", join(scratch, "vsix")])
    extensionPath = join(scratch, "vsix", "extension")
    notes.vsix = { file: vsix, contents: execFileSync("unzip", ["-Z1", vsix], { encoding: "utf8" }).trim().split("\n") }
  }
  const built = spawnSync("nub", ["scripts/build.ts", "--e2e"], { cwd: pkg, stdio: "inherit" })
  if (built.status !== 0) throw new Error("building the e2e bundle failed")
  // c11's stand-in for Claude Code, packed NOW: a synchronous pack once the editor is up blocks this
  // process's event loop, the agent inside VS Code cannot reach the harness for that long, and it quits.
  if (wanted("c11")) packClaudeCodeStandIn()
  log(`extension under test: ${devMode ? "the source tree" : "the packaged .vsix"} at ${extensionPath}`)

  // ── the stack, seeded ──
  stack = await bootStack({ scratch, projects: ["acme-api", "marketing-site"], log, onSpawn: (teardown) => (stackTeardown = teardown) })
  origin = stack.origin
  const workspace = stack.info.tenants.find((tenant) => tenant.slug === "marketing-site")!
  seeded = await seedSidebarStack({ stack, workspace, scratch, log })
  const files = seeded.files
  // c12: a thread working in a worktree of the workspace, and (--worktree) the window opened on it.
  const worktreeThread = worktreeWindow ? await seedWorktreeThread({ stack, workspace, log }) : undefined
  const windowFolder = worktreeThread?.dir ?? workspace.dir
  log(`stack up at ${origin}; the window's folder is ${worktreeThread ? `the worktree of ${worktreeThread.slug}` : "the tenant"} ${workspace.slug} (${windowFolder})`)

  // A cold dev server optimizes its dependencies on the first page load, which can take a minute — a
  // stall no installed Frizz has (it serves a build). One headless load first, so the sidebar's first
  // page is the one a human would get.
  warmBrowser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"], userDataDir: join(scratch, "warm-profile") })
  {
    const warm = await warmBrowser.newPage()
    await warm.goto(`${origin}/?project=${workspace.slug}`, { waitUntil: "domcontentloaded", timeout: 180_000 })
    await warm.waitForSelector('textarea[data-surface="newComposer"]', { timeout: 180_000 })
    await warmBrowser.close()
    warmBrowser = undefined
  }
  log("the page has been loaded once (the dev server is warm)")

  // ── the editor ──
  const agentOrigin = await startAgentServer()
  mkdirSync(join(userData, "User"), { recursive: true })
  writeFileSync(join(userData, "User", "settings.json"), JSON.stringify({
    "frizz.serverUrl": origin,
    "workbench.colorTheme": "Default Dark Modern",
    "workbench.startupEditor": "none",
    "workbench.activityBar.location": "default",
    "workbench.secondarySideBar.defaultVisibility": "hidden",
    "workbench.tips.enabled": false,
    "chat.disableAIFeatures": true,
    "chat.commandCenter.enabled": false,
    "window.restoreWindows": "none",
    "window.titleBarStyle": "custom",
    "security.workspace.trust.enabled": false,
    "update.mode": "none",
    "extensions.autoUpdate": false,
    "extensions.autoCheckUpdates": false,
    "extensions.ignoreRecommendations": true,
    "telemetry.telemetryLevel": "off",
    "git.enabled": false,
    "typescript.tsserver.log": "off",
  }, null, 2))
  // VS Code's own openExternal ends in `xdg-open` on Linux: the stubs come first on its PATH too.
  process.env.PATH = stubbedPath(stack.stubs)
  delete process.env.BROWSER
  const debuggingPort = await freePort()
  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version, cachePath: join(homedir(), ".cache", "frizz-vscode-e2e") })
  log(`VS Code ${version} at ${vscodeExecutablePath}, debugging port ${debuggingPort}, DISPLAY=${process.env.DISPLAY}`)
  suite = runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: extensionPath,
    extensionTestsPath: join(pkg, "dist", "e2e", "sidebar-agent.cjs"),
    launchArgs: [
      windowFolder,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${join(scratch, "extensions")}`,
      "--disable-extension=GitHub.copilot",
      "--disable-extension=GitHub.copilot-chat",
      "--password-store=basic",
      "--disable-gpu",
      "--disable-telemetry",
      "--skip-welcome",
      "--skip-release-notes",
      `--remote-debugging-port=${debuggingPort}`,
    ],
    extensionTestsEnv: { FRIZZ_E2E_AGENT: agentOrigin },
  }).catch((error: unknown) => {
    log(`VS Code did not run the agent: ${(error as Error).message}`)
    return 1
  })
  finishAgent = () => {
    agentQueue.push({ seq: ++agentSeq, op: { op: "done" } })
    flushAgent()
  }
  await Promise.race([agentUp, suite.then(() => Promise.reject(new Error("VS Code exited before its agent asked for anything"))), sleep(180_000).then(() => Promise.reject(new Error("VS Code's agent never asked for anything within 180s")))])
  const first = await status()
  version = first.version
  log(`the editor is up: ${first.appName} ${first.version}; Frizz connection ${first.status.kind}`)

  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debuggingPort}`, defaultViewport: null, protocolTimeout: 180_000 })
  page = await waitFor("the workbench page", async () => (await browser!.pages()).find((candidate) => /workbench(\.esm)?\.html/u.test(candidate.url())), 60_000)
  cdp = await page.createCDPSession()
  // No window manager under Xvfb gives the window focus, and a page that thinks it is unfocused routes no keys.
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true })
  notes.window = await inWorkbench(() => ({ inner: [innerWidth, innerHeight], dpr: devicePixelRatio }))
  page.on("console", (message) => {
    const url = message.location()?.url ?? ""
    if (message.type() === "error" && url.startsWith(origin) && !/control\/status/u.test(message.text())) pageErrors.push(`${message.text()} (${url})`)
  })
  page.on("pageerror", (error) => pageErrors.push(String(error)))
  await waitFor("the extension connected to Frizz", async () => (await status()).status.kind === "connected" || undefined, 60_000)

  const run = async (id: string, title: string, fn: () => Promise<void>) => {
    if (!wanted(id)) return
    log(`── ${id}: ${title}`)
    try {
      await fn()
    } catch (error) {
      expect(id, `${title} — ran to the end`, false, (error as Error).stack?.split("\n").slice(0, 4).join(" | "))
      await shot(`${id}-failure`, { window: true }).catch(() => undefined)
    }
  }

  // ── c1: the icon ──
  await run("c1", "the Frizz icon renders in the activity bar", async () => {
    const before = flag("icon-before")
    try {
      for (const layout of [
        { location: "default", theme: "Default Dark Modern", name: "side-dark" },
        { location: "top", theme: "Default Dark Modern", name: "top-dark" },
        { location: "top", theme: "Default Light Modern", name: "top-light" },
        { location: "default", theme: "Default Light Modern", name: "side-light" },
      ]) {
        await agent({ op: "config", section: "workbench", key: "activityBar.location", value: layout.location })
        await agent({ op: "config", section: "workbench", key: "colorTheme", value: layout.theme })
        const wantLight = layout.theme.includes("Light")
        const strip = await waitFor(`the activity bar ${layout.name}`, async () => {
          const state = await inWorkbench(() => {
            const bar = [...document.querySelectorAll(".composite-bar")].find((candidate) => candidate.querySelector('.action-label[aria-label^="Frizz"]'))
            const items = bar ? [...bar.querySelectorAll<HTMLElement>(".action-item")].map((item) => item.querySelector<HTMLElement>(".action-label")).filter((label): label is HTMLElement => !!label && label.getBoundingClientRect().width > 0) : []
            const rects = items.map((label) => {
              const r = label.getBoundingClientRect()
              const cs = getComputedStyle(label)
              // The active item wears VS Code's indicator bar beside its glyph, which is not glyph ink.
              return { label: label.getAttribute("aria-label") ?? "", x: r.x, y: r.y, w: r.width, h: r.height, mask: cs.webkitMaskImage || cs.maskImage || "", active: label.closest(".action-item")?.classList.contains("checked") ?? false }
            })
            return {
              top: !!bar?.closest(".part.sidebar, .part.auxiliarybar") || !bar?.closest(".part.activitybar"),
              light: document.querySelector(".monaco-workbench")?.classList.contains("vs") ?? false,
              items: rects,
            }
          })
          return state.items.some((item) => item.label.startsWith("Frizz")) && state.top === (layout.location === "top") && state.light === wantLight ? state : undefined
        }, 30_000)
        await sleep(600)
        const frizz = strip.items.find((item) => item.label.startsWith("Frizz"))!
        // A codicon at rest beside it (Explorer is the active one, drawn brighter).
        const explorer = strip.items.find((item) => /^Search/u.test(item.label)) ?? strip.items[1]!
        // The mask is the icon file: it must load, and be the SVG the package carries.
        const mask = /url\("?([^")]+)"?\)/u.exec(frizz.mask)?.[1] ?? ""
        const file = await page.evaluate(async (url) => {
          try {
            const response = await fetch(url)
            const text = await response.text()
            return { status: response.status, svg: text.trimStart().startsWith("<svg"), bytes: text.length }
          } catch (error) {
            return { status: 0, svg: false, bytes: 0, error: String(error) }
          }
        }, mask)
        expect("c1", `${layout.name}: the icon's mask file loads and is the SVG`, file.status === 200 && file.svg, { mask: mask.slice(-80), ...file })
        // The strip at 1x, enlarged 6x without smoothing: the BEFORE shot's own framing.
        const left = Math.min(...strip.items.map((item) => item.x))
        const top = Math.min(...strip.items.map((item) => item.y))
        const right = Math.max(...strip.items.map((item) => item.x + item.w))
        const bottom = Math.max(...strip.items.map((item) => item.y + item.h))
        const stripFile = join(out, `${version}-c1-icon-${layout.name}-1x.png`)
        await capture(stripFile, { x: left, y: top, width: right - left, height: bottom - top }, 1)
        const at6 = join(out, `${version}-c1-icon-${layout.name}-1x-at6.png`)
        execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", stripFile, "-vf", "scale=iw*6:ih*6:flags=neighbor", at6])
        rmSync(stripFile)
        shots.splice(shots.indexOf(stripFile), 1, at6)
        // The icon and its codicon neighbour at 8x, and their ink.
        const big = async (item: typeof frizz, name: string) => {
          const file = join(out, `${version}-c1-icon-${layout.name}-${name}-8x.png`)
          return { file, ink: inkOf(decodePng(await capture(file, { x: item.x, y: item.y, width: item.w, height: item.h }, 8)), 8) }
        }
        // A count badge sits over the icon's corner once the board has one; it is not the icon's ink.
        const unbadge = await page.addStyleTag({ content: ".monaco-workbench .composite-bar .badge { visibility: hidden !important; }" })
        await sleep(100)
        const mine = await big(frizz, "frizz")
        const theirs = await big(explorer, "search")
        // Every codicon at rest in the bar (Search, Source Control, Run and Debug, Extensions; Explorer is
        // the active one), unsaved.
        const neighbours: Record<string, number> = {}
        for (const item of strip.items.filter((candidate) => !candidate.label.startsWith("Frizz") && !candidate.active)) {
          neighbours[item.label] = inkOf(decodePng(await capture("", { x: item.x, y: item.y, width: item.w, height: item.h }, 8)), 8).mass
        }
        await unbadge.evaluate((el) => el.remove())
        rmSync(theirs.file)
        shots.splice(shots.indexOf(theirs.file), 1)
        const masses = Object.values(neighbours)
        const mean = masses.reduce((sum, mass) => sum + mass, 0) / Math.max(1, masses.length)
        const ink = { frizz: mine.ink, search: theirs.ink, box: [frizz.w, frizz.h], neighbours, ofMean: Math.round((mine.ink.mass / mean) * 100) / 100, ofSearch: Math.round((mine.ink.mass / theirs.ink.mass) * 100) / 100 }
        expect("c1", `${layout.name}: the icon draws a line mark — not blank, not a filled square`, mine.ink.peak >= 0.6 * theirs.ink.peak && mine.ink.fill < 0.5 && mine.ink.box[0] >= 10 && mine.ink.box[1] >= 10, ink)
        // The bound is the bar's own spread: against the mean of the four at rest, Explorer's glyph is
        // ~1.38x and Search's ~0.7x (headless Chrome over codicon.ttf, 2026-10-02). The mark at a codicon's
        // pen read ~1.9x that mean; at 0.7 of it, ~1.34x (media/frizz.svg).
        expect("c1", `${layout.name}: its ink is the weight of the codicons beside it (mass within 0.5–1.5x the mean of those at rest)`, masses.length > 0 && mine.ink.mass >= 0.5 * mean && mine.ink.mass <= 1.5 * mean, ink)
        if (layout.name === "top-dark" && before && existsSync(before)) {
          // BEFORE over AFTER, the same framing, for the eye.
          const compare = join(out, `${version}-c1-icon-top-dark-BEFORE-vs-now-at6.png`)
          // hstack wants one height: both padded to the taller, never scaled (nearest-neighbour pixels stay pixels).
          const height = Math.max(decodePng(readFileSync(before)).height, decodePng(readFileSync(at6)).height)
          execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", before, "-i", at6, "-filter_complex", `[0]pad=iw+24:${height}:0:0:white[a];[1]pad=iw:${height}:0:0:white[b];[a][b]hstack`, compare])
          shots.push(compare)
        }
      }
    } finally {
      // Back to the side bar, dark, whatever happened: every check after this one starts there.
      await agent({ op: "config", section: "workbench", key: "activityBar.location", value: "default" })
      await agent({ op: "config", section: "workbench", key: "colorTheme", value: "Default Dark Modern" })
      await until(async () => !(await inWorkbench(() => document.querySelector(".monaco-workbench")?.classList.contains("vs") ?? false)))
    }
  })

  // ── c2: the view frames the real page ──
  const started = Date.now()
  log("opening the Frizz view from its activity-bar icon, with the mouse")
  await waitFor("the Frizz item in the activity bar", () => page.$('.part.activitybar .action-label[aria-label^="Frizz"]'), 30_000)
  await clickInWorkbench('.part.activitybar .action-label[aria-label^="Frizz"]')
  const framed = await waitFor("the Frizz frame", frizzFrame, 60_000)
  await waitFor("frizz:ready", async () => (await status()).sidebar.ready || undefined, 90_000)
  notes.readyAfterMs = Date.now() - started
  await waitFor("the queue in the page", async () => (await inPage(() => document.querySelectorAll("[data-xq-thread-row]").length)) > 0 || undefined, 60_000)
  await sleep(1_000)
  // Where the page went on its own, before anything here moved it (c12): a thread only for a window on
  // that thread's worktree. The extension asks the board once the page is ready, which a second covers.
  notes.firstRoute = (await status()).sidebar.href ?? null
  await installFocusTrace()
  // What the first load cost: a dev server serves the page as hundreds of unbundled modules, where an
  // installed Frizz serves a build — so a slow first ready here is a fact about the stack, and the
  // number says how slow.
  notes.firstLoad = {
    readyAfterMs: notes.readyAfterMs,
    hintShown: /didn't say it was ready/u.test(frizzLog()),
    page: await inPage(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined
      const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[]
      return { domContentLoadedMs: Math.round(nav?.domContentLoadedEventEnd ?? 0), loadMs: Math.round(nav?.loadEventEnd ?? 0), requests: resources.length, scripts: resources.filter((r) => r.initiatorType === "script" || /\.(ts|tsx|js|mjs)(\?|$)/u.test(r.name)).length }
    }),
  }

  // The editor, driven as a human drives it.
  const selectLines23 = async () => {
    // Real keys in the editor: line 2's start, then down a line and to its end — lines 2-3.
    await press("Control+Home")
    await press("ArrowDown")
    await press("Home")
    await press("Home")
    await press("Shift+ArrowDown")
    await press("Shift+End")
  }
  const openInEditor = async (path: string, selection?: [number, number, number, number]) => {
    await agent({ op: "open", path, ...(selection ? { selection } : {}) })
    if (await until(async () => (await workbenchFocus()).editor, 5_000)) return
    // Shown but not focused (the sidebar's page took the keyboard, or a sash drag kept it): a human clicks in.
    notes.openInEditorClicks = ((notes.openInEditorClicks as number | undefined) ?? 0) + 1
    await clickInWorkbench(".editor-group-container .monaco-editor .view-lines")
    if (selection) await agent({ op: "select", selection })
    await waitFor(`${path} in front with the editor focused`, async () => (await workbenchFocus()).editor || undefined, 10_000)
  }
  await run("c2", "the view frames the real page, and VS Code's title row is its header", async () => {
    // The address the view framed (the page's router then drops the query, by design: lib/embed.ts).
    const snapshot = (await status()).sidebar
    const url = new URL(snapshot.url ?? "about:blank")
    expect("c2", "the frame is the real page, in embed mode, dark, on this window's project", url.origin === origin && new URL(framed.url()).origin === origin && url.searchParams.get("embed") === "vscode" && url.searchParams.get("theme") === "dark" && url.searchParams.get("project") === workspace.slug, { framed: snapshot.url, now: framed.url() })
    expect("c2", "the page said frizz:ready", snapshot.ready && snapshot.events.some((event) => event.type === "frizz:ready"), { readyAfterMs: notes.readyAfterMs, events: snapshot.events.slice(0, 6) })
    expect("c2", "no 'hasn't finished loading' bar over it", !snapshot.hinted)
    const boot = await inPage(() => ({
      embed: document.documentElement.dataset.embed,
      theme: document.documentElement.dataset.theme,
      font: document.documentElement.dataset.font,
      sidebarPage: !!document.querySelector("[data-sidebar-page]"),
      phone: document.querySelectorAll("[data-mobile-thread-row], [data-mobile-board-title]").length,
      statusTitle: !!document.querySelector("[data-status-title]"),
      gear: !!document.querySelector('[data-status-row] [aria-label="Settings"]'),
      // The ⌨ is in VS Code's title row (⋯ Keyboard shortcuts), and a status row with nothing left in it
      // is not drawn: it stood alone on a 36px row above the prompt box (2026-10-01).
      keyboard: !!document.querySelector('[data-status-row] [aria-label="Keyboard shortcuts"]'),
      emptyStatusRow: [...document.querySelectorAll<HTMLElement>("[data-status-row]")].some((row) => row.getClientRects().length > 0 && row.querySelectorAll("button, [data-quota-bar]").length === 0),
      header: [...document.querySelectorAll("header")].filter((h) => h.getClientRects().length > 0 && !h.closest("[role=dialog], .frizz-sheet-panel")).length,
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      rowTitlePx: (() => {
        const title = [...document.querySelectorAll("[data-xq-thread-row] span")].find((s) => s.className.includes("break-words"))
        return title ? getComputedStyle(title).fontSize : null
      })(),
    }))
    expect("c2", "the page knows it is in VS Code, in VS Code's dark theme, in sans", boot.embed === "vscode" && boot.theme === "dark" && boot.font === "sans", boot)
    expect("c2", "the desktop page narrowed, not the phone page", boot.sidebarPage && boot.phone === 0 && boot.rowTitlePx === "13px", boot)
    expect("c2", "no Frizz header: no title, no gear, no header bar", !boot.statusTitle && !boot.gear && boot.header === 0, boot)
    expect("c2", "no ⌨ over the prompt box, and no empty status row", !boot.keyboard && !boot.emptyStatusRow, boot)
    expect("c2", "nothing overflows sideways", boot.scrollWidth <= boot.width, { width: boot.width, scrollWidth: boot.scrollWidth })

    // The row says Frizz and nothing the page names: VS Code re-cases a view's title ("Frizz: Marketing-Site"
    // on 1.140, all caps on 1.90) and drops its description in a one-view container, so the counts ride the
    // badge's tooltip and the names stay in the page (src/sidebar.ts applyRoute).
    const queueRow = await waitFor("the queue's buttons in the title row", async () => {
      const row = await titleRow()
      return row.buttons.includes("New thread") ? row : undefined
    }, 15_000).catch(async () => titleRow())
    const queueSnapshot = await waitFor("the queue's counts on the badge", async () => {
      const snapshot = (await status()).sidebar
      return snapshot.view === "queue" && /ready|need/iu.test(snapshot.badgeTooltip ?? "") ? snapshot : undefined
    }, 15_000).catch(async () => (await status()).sidebar)
    expect("c2", "queue: the page's counts ride the badge's tooltip", /ready|need/iu.test(queueSnapshot.badgeTooltip ?? ""), { badge: queueSnapshot.badge, badgeTooltip: queueSnapshot.badgeTooltip })
    expect("c2", "queue: the title row reads Frizz, with no page name in it to re-case", /frizz/iu.test(queueRow.text) && !/marketing-site/iu.test(queueRow.text), { shown: queueRow.text, words: queueRow.words, transform: queueRow.transform })
    expect("c2", "queue: the buttons are New thread, Jump to a thread, Settings — no Back to queue", JSON.stringify(queueRow.buttons) === JSON.stringify(["New thread", "Jump to a thread", "Settings"]), queueRow.buttons)
    notes.titleRowQueue = queueRow
    await shot("c2-queue-dark-w300", { window: true })

    // A thread, opened with the mouse from its row.
    await openThreadRow()
    const threadRow = await waitFor("the thread's buttons in the title row", async () => {
      const row = await titleRow()
      return row.buttons.includes("Back to queue") ? row : undefined
    }, 10_000).catch(async () => titleRow())
    const named = await inPage((handle) => [...document.querySelectorAll<HTMLElement>(".frizz-sheet-panel")].some((panel) => panel.getClientRects().length > 0 && panel.innerText.includes(handle)), seeded!.thread.handle)
    expect("c2", "thread: the drawer names the thread, and the title row still reads Frizz (no handle for VS Code to re-case)", named && !threadRow.text.toLowerCase().includes(seeded!.thread.handle.toLowerCase()), { named, shown: threadRow.text, words: threadRow.words, transform: threadRow.transform })
    expect("c2", "thread: the buttons are Back to queue, Jump to a thread, Settings — no New thread", JSON.stringify(threadRow.buttons) === JSON.stringify(["Back to queue", "Jump to a thread", "Settings"]), threadRow.buttons)
    notes.titleRowThread = threadRow
    await shot("c2-thread-dark-w300", { window: true })

    // Each button, clicked.
    await clickInWorkbench('.part.sidebar .title-actions .action-label[aria-label="Back to queue"]')
    expect("c2", "Back to queue closes the drawer and the title row is the queue's again", await until(async () => !(await drawerOpen()) && (await titleRow()).buttons.includes("New thread"), 8_000), await titleRow())

    // New thread, the way it is used: the human is in the editor and clicks the button. Five times —
    // where the keyboard lands is a race between VS Code's focus of the view and the page's focus of its
    // box, so one try proves little either way; the count is the finding.
    const tries: Record<string, unknown>[] = []
    for (let attempt = 1; attempt <= 5; attempt++) {
      await openInEditor(files.sample)
      const at = Date.now()
      await clickInWorkbench('.part.sidebar .title-actions .action-label[aria-label="New thread"]')
      const settled = await caretAfterPause("newComposer")
      const held = settled.box?.active === true && settled.box.frameFocused && settled.focus.sidebar
      tries.push({ attempt, held, ...(held ? {} : { after: settled, trace: await focusTraceSince(at) }) })
    }
    notes.newThreadTries = tries
    const heldCount = tries.filter((t) => t.held).length
    expect("c2", `New thread, clicked from the editor, puts the caret in the prompt box, still there 1.5s later (${heldCount}/5)`, heldCount === 5, tries.map((t) => ({ attempt: t.attempt, held: t.held, ...(t.after ? { after: t.after } : {}) })))
    // …and from a thread: Back to queue, then New thread at once — the order that lost the caret in
    // earlier runs, while the closing drawer hands focus back to its row.
    const afterBack: Record<string, unknown>[] = []
    for (let attempt = 1; attempt <= 3; attempt++) {
      await openThreadRow()
      await clickInWorkbench('.part.sidebar .title-actions .action-label[aria-label="Back to queue"]')
      await until(async () => (await titleRow()).buttons.includes("New thread"), 5_000)
      const at = Date.now()
      await clickInWorkbench('.part.sidebar .title-actions .action-label[aria-label="New thread"]')
      const settled = await caretAfterPause("newComposer")
      const held = settled.box?.active === true && settled.box.frameFocused && settled.focus.sidebar
      afterBack.push({ attempt, held, ...(held ? {} : { after: settled, trace: await focusTraceSince(at) }) })
    }
    notes.newThreadAfterBack = afterBack
    const heldAfterBack = afterBack.filter((t) => t.held).length
    expect("c2", `New thread, clicked just after Back to queue, puts the caret in the prompt box (${heldAfterBack}/3)`, heldAfterBack === 3, afterBack.map((t) => ({ attempt: t.attempt, held: t.held, ...(t.after ? { after: t.after } : {}) })))
    if (!(await box("newComposer"))?.active) {
      await shot("c2-new-thread-caret-lost", { window: true })
      await clickInPage('textarea[data-surface="newComposer"]')
    }
    await typeInto("newComposer", "typed after New thread")
    await sleep(300)
    const typed = await box("newComposer")
    expect("c2", "…and typing lands there", typed?.value.includes("typed after New thread") === true, typed?.value)
    await clearBox("newComposer")

    await clickInWorkbench('.part.sidebar .title-actions .action-label[aria-label="Jump to a thread"]')
    const palette = await until(async () => (await inPage(() => !!document.querySelector("[cmdk-root]"))), 5_000)
    expect("c2", "Jump to a thread opens Frizz's palette", palette)
    await shot("c2-jump-palette-w300")
    await press("Escape")
    await until(async () => !(await inPage(() => !!document.querySelector("[cmdk-root]"))), 3_000)

    const settingsAt = Date.now()
    await clickInWorkbench('.part.sidebar .title-actions .action-label[aria-label="Settings"]')
    const settings = await until(async () => (await inPage(() => !!document.querySelector('[data-settings-editor="appearance"]'))), 8_000)
    const settingsView = await until(async () => (await status()).sidebar.view === "settings", 3_000)
    expect("c2", "Settings opens Settings, and the page tells the title row so (its view is settings)", settings && settingsView, { settings, view: (await status()).sidebar.view, row: await titleRow() })
    await sleep(1_000)
    const settingsFocus = { workbench: await workbenchFocus(), page: await inPage(() => ({ hasFocus: document.hasFocus(), active: document.activeElement?.tagName ?? null, inDialog: !!document.activeElement?.closest("[role=dialog]") })) }
    await press("Escape")
    const closed = await until(async () => !(await inPage(() => !!document.querySelector('[data-settings-editor="appearance"]'))), 5_000)
    if (!closed) notes.settingsEscape = { focus: settingsFocus, trace: await focusTraceSince(settingsAt) }
    expect("c2", "…the keyboard is in it: Escape closes Settings", closed, settingsFocus)
    if (!closed) await resetPage()
  })

  // ── c3: the editor's context in the page ──
  /**
   * Lines 2-3 of sample.ts selected by keys and the add chord (Ctrl+L, the one the page names) pressed the
   * instant after — clicking back into the editor first when the keyboard is not there. `focused` says the
   * editor already has it (the first try then skips the click). Returns the try that put the chip in the
   * reply box, 0 for none.
   */
  const selectAndAdd = async (focused: boolean, chord = "Control+KeyL"): Promise<number> => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1 || !focused) {
        await clickInWorkbench(".editor-group-container .monaco-editor .view-lines")
        if (!(await until(async () => (await workbenchFocus()).editor, 3_000))) continue
      }
      await selectLines23()
      await press(chord)
      if (await until(async () => (await box("chatComposer").catch(() => null))?.value.includes("@sample.ts:2-3") === true, 6_000)) return attempt
    }
    return 0
  }
  await run("c3", "the context bar follows the editor", async () => {
    await command("workbench.action.closeAllEditors")
    await agent({ op: "open", path: files.a })
    await agent({ op: "open", path: files.b })
    await openInEditor(files.sample)
    await selectLines23()
    const selectedAt = Date.now()
    const editor = await editorState()
    expect("c3", "the editor holds lines 2-3 selected, by real keys", editor.path === files.sample && editor.selection?.start[0] === 1 && editor.selection.start[1] === 0 && editor.selection.end[0] === 2, editor)
    const selection = await waitFor("the bar in its selection state", async () => {
      const bar = await contextBar("newComposer")
      return bar?.kind === "selection" && bar.label?.includes("sample.ts:2-3") ? bar : undefined
    }, 5_000).catch(async () => contextBar("newComposer"))
    const latency = Date.now() - selectedAt
    notes.contextBarLatencyMs = latency
    expect("c3", "selection: the bar reads `sample.ts:2-3  2 lines` in the selection style, within 1.5s", selection?.kind === "selection" && /sample\.ts:2-3, 2 lines/u.test(selection.label ?? "") && latency < 1_500, { latency, selection })
    await shot("c3-bar-selection-w300")

    await press("ArrowRight")
    const file = await waitFor("the bar in its file state", async () => {
      const bar = await contextBar("newComposer")
      return bar?.kind === "file" ? bar : undefined
    }, 5_000).catch(async () => contextBar("newComposer"))
    expect("c3", "no selection: the bar names the file alone, quietly, with the Ctrl+L hint", file?.kind === "file" && /sample\.ts/u.test(file.text ?? "") && !/lines?/u.test(file.text ?? "") && /Ctrl\+L/u.test(file.hint ?? ""), file)
    await shot("c3-bar-file-w300")

    // Another editor, by its tab.
    await clickInWorkbench('.tabs-container .tab[aria-label^="a.ts"]')
    const other = await waitFor("the bar on a.ts", async () => {
      const bar = await contextBar("newComposer")
      return bar?.text?.includes("a.ts") ? bar : undefined
    }, 5_000).catch(async () => contextBar("newComposer"))
    expect("c3", "switching editors: the bar follows to a.ts", /a\.ts/u.test(other?.text ?? ""), other)

    // The open files, behind the chevron.
    const tabs = await agent<{ label: string; path: string | null; active: boolean }[]>({ op: "tabs" })
    await clickInComposer("newComposer", "[data-editor-open-files]")
    const listed = await waitFor("the open-files menu", async () => {
      const labels = await inPage(() => [...document.querySelectorAll<HTMLElement>("[data-editor-open-file]")].filter((item) => item.getClientRects().length > 0).map((item) => item.dataset.editorOpenFile ?? ""))
      return labels.length ? labels : undefined
    }, 5_000).catch(() => [] as string[])
    const others = tabs.filter((tab) => !tab.active && tab.path).map((tab) => tab.label).sort()
    expect("c3", "the open-files menu lists the other open tabs", JSON.stringify(listed.map((label) => label.split("/").pop()).sort()) === JSON.stringify(others), { listed, tabs })
    await shot("c3-open-files-menu-w300")
    await press("Escape")
  })

  // ── c4: Ctrl+L, the chip, a send to a simulated worker ──
  await run("c4", "Ctrl+L puts the selection in the front composer as a pill, and it sends", async () => {
    // The thread in the drawer is the front composer; the Explorer takes the side bar, so Ctrl+L must reveal Frizz.
    await resetPage()
    await openThreadRow()
    await command("workbench.view.explorer")
    await waitFor("the Frizz view hidden", async () => !(await status()).sidebar.visible || undefined, 10_000)
    const editorAt = Date.now()
    await openInEditor(files.sample)
    await selectLines23()
    // A human's beat with the selection made: the keyboard must still be the editor's.
    await sleep(1_500)
    const held = { focus: await workbenchFocus(), editor: await editorState() }
    notes.focusBeforeCtrlL = { ...held, trace: await focusTraceSince(editorAt) }
    expect("c4", "with a thread open in the (hidden) sidebar, the editor keeps the keyboard after a selection is made in it", held.focus.editor, held)
    // Ctrl+L. If the keyboard is gone by now (the check above failed and says where it went), Ctrl+L is
    // pressed the instant the selection is made, before the page can take it: what follows tests the rest
    // of the path, which is otherwise unreachable.
    const eventsBefore = (await status()).sidebar.events.length
    notes.ctrlLTries = await selectAndAdd(held.focus.editor)
    const landed = await waitFor("the chip in the thread's reply box", async () => {
      const state = await box("chatComposer").catch(() => null)
      return state?.value.includes("@sample.ts:2-3") ? state : undefined
    }, 15_000).catch(async () => box("chatComposer").catch(() => null))
    const view = (await status()).sidebar
    notes.ctrlLEvents = view.events.slice(eventsBefore)
    notes.focusCtrlL = await focusTraceSince(editorAt)
    expect("c4", "Ctrl+L reveals the sidebar", view.visible, { visible: view.visible, events: notes.ctrlLEvents })
    expect("c4", "the chip `@sample.ts:2-3` is in the thread's reply box", landed?.value.startsWith("@sample.ts:2-3") === true, landed)
    const pill = landed?.pills.find((p) => p.token === "@sample.ts:2-3")
    expect("c4", "…drawn as a pill (a filled, ringed token in the box's backdrop)", !!pill && pill.background !== "rgba(0, 0, 0, 0)" && pill.ring !== "none", pill)
    const afterPause = await caretAfterPause("chatComposer")
    expect("c4", "…with the caret after it, in the focused box, still there 1.5s later", !!afterPause.box && afterPause.box.active && afterPause.box.frameFocused && afterPause.box.caret >= "@sample.ts:2-3".length, afterPause)
    expect("c4", "…and the keyboard is in the sidebar", afterPause.focus.sidebar, afterPause.focus)
    await typeInto("chatComposer", "why does this loop?")
    await sleep(300)
    const typed = await box("chatComposer")
    expect("c4", "typing lands after the chip", typed?.value === "@sample.ts:2-3 why does this loop?", typed?.value)
    const bar = await contextBar("chatComposer")
    expect("c4", "the reply box's context bar shows the live selection", bar?.kind === "selection" && /sample\.ts:2-3/u.test(bar.label ?? ""), bar)
    await shot("c4-thread-selection-chip-w300", { window: true })

    // Send. The worker is simulated: it records what reached it and writes it into the transcript.
    const before = readFileSync(seeded!.inputs, "utf8").trim().split("\n").filter(Boolean).length
    await press("Enter")
    const input = await waitFor("the follow-up at the simulated worker", () => {
      const lines = readFileSync(seeded!.inputs, "utf8").trim().split("\n").filter(Boolean)
      return lines.length > before ? (JSON.parse(lines.at(-1)!) as { id: string; text: string }) : undefined
    }, 20_000)
    const parsed = parseSentContext(input.text)
    const lines = SAMPLE.split("\n").slice(1, 3).join("\n")
    expect("c4", "the message reached the worker with the context serialized: the chip in the prose, lines 2-3 defined", !!parsed && parsed.body.startsWith("@sample.ts:2-3 why does this loop?") && parsed.items.length === 1 && parsed.items[0]!.token === "@sample.ts:2-3" && parsed.items[0]!.startLine === 2 && parsed.items[0]!.endLine === 3 && parsed.items[0]!.text === lines, { text: input.text.slice(0, 600), parsed })
    const chip = await waitFor("the chip in the transcript", async () => {
      const chips = await inPage(() => [...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].filter((b) => b.getClientRects().length > 0 && /sample\.ts:2-3/u.test(b.textContent ?? "")).map((b) => ({ text: b.textContent, title: b.title })))
      return chips.length ? chips : undefined
    }, 20_000).catch(() => [])
    expect("c4", "the transcript shows the sent message with the chip", chip.length > 0, chip)
    await sleep(2_000)
    await shot("c4-transcript-chip-w300")
    // The chip unfolds its quote, as in the browser.
    await clickTextInPage("button[aria-expanded]", "sample.ts:2-3")
    const unfolded = await until(async () => (await inPage(() => document.body.innerText.includes("lines 2-3"))), 3_000)
    expect("c4", "the transcript's chip unfolds the lines it carried", unfolded)
    await shot("c4-transcript-chip-open-w300")

    // The context bar's own click does the same, into this box.
    // The selection set through the editor API: the keyboard is not what this step tests, and it would
    // not stay in the editor long enough to select by keys (see above).
    await openInEditor(files.sample)
    await agent({ op: "select", selection: [1, 0, 2, -1] })
    await waitFor("the reply box's bar on the selection", async () => (await contextBar("chatComposer"))?.kind === "selection" || undefined, 5_000)
    const barAt = Date.now()
    await clickInComposer("chatComposer", "[data-editor-context=selection]")
    const viaBar = await waitFor("the chip from the bar's click", async () => {
      const state = await box("chatComposer")
      return state?.value.includes("@sample.ts:2-3") ? state : undefined
    }, 8_000).catch(async () => box("chatComposer"))
    // The caret follows the chip a beat later (the compose goes out to the extension and back).
    await until(async () => (await box("chatComposer"))?.active === true, 2_000)
    const barCaret = await caretAfterPause("chatComposer", 500)
    expect("c4", "clicking the context bar puts the same chip in the box", viaBar?.value.startsWith("@sample.ts:2-3") === true && !!viaBar.pills.some((pill) => pill.token === "@sample.ts:2-3"), viaBar)
    expect("c4", "…and leaves the caret after it, in the box", !!barCaret.box?.active && barCaret.box.frameFocused && barCaret.box.caret >= "@sample.ts:2-3".length, barCaret)
    if (!barCaret.box?.active) {
      notes.barClickFocus = { after: barCaret, trace: await focusTraceSince(barAt) }
      // The human clicks into the box to go on.
      await clickInPage('textarea[data-surface="chatComposer"]')
      await press("End")
    }
    await typeInto("chatComposer", "x")
    await sleep(200)
    expect("c4", "…and typing lands after it", (await box("chatComposer"))?.value.trimEnd().endsWith("x") === true, (await box("chatComposer"))?.value)
    await clearBox("chatComposer")

    // Alt+K, Claude Code's chord, with only a caret in the editor: the whole file, `@sample.ts`.
    await openInEditor(files.sample)
    await agent({ op: "select", selection: [1, 2, 1, 2] })
    await sleep(500)
    await press("Alt+KeyK")
    const wholeFile = await waitFor("the file's chip from Alt+K", async () => {
      const state = await box("chatComposer")
      return state?.value.includes("@sample.ts") ? state : undefined
    }, 8_000).catch(async () => box("chatComposer"))
    expect("c4", "Alt+K with only a caret puts the whole file in the reply box as a pill, `@sample.ts`", /^@sample\.ts(?!:)/u.test(wholeFile?.value ?? "") && !!wholeFile?.pills.some((pill) => pill.token === "@sample.ts"), wholeFile)
    await clearBox("chatComposer")

    // CTRL+L BOTH WAYS, as Cursor's: pressed in the reply box it goes back to the editor — even with a
    // selection standing there, it adds nothing (that is the editor's Ctrl+L, and the bar's click).
    await openInEditor(files.sample)
    await agent({ op: "select", selection: [1, 0, 2, -1] })
    await waitFor("the reply box's bar on the selection", async () => (await contextBar("chatComposer"))?.kind === "selection" || undefined, 5_000)
    await clickInPage('textarea[data-surface="chatComposer"]')
    await until(async () => (await box("chatComposer"))?.active === true, 3_000)
    const keysBefore = (await status()).sidebar.events.filter((event) => event.type === "frizz:key").length
    await press("Control+KeyL")
    const backToEditor = await until(async () => (await workbenchFocus()).editor, 5_000)
    await sleep(500)
    const forwarded = (await status()).sidebar.events.filter((event) => event.type === "frizz:key").slice(keysBefore)
    const leftBox = await box("chatComposer")
    expect("c4", "Ctrl+L pressed in the reply box goes back to the editor, adding nothing", backToEditor && forwarded.some((event) => event.outcome === "workbench.action.focusActiveEditorGroup") && leftBox?.value === "", { focus: await workbenchFocus(), forwarded, box: leftBox?.value })

    // …and in the editor with NOTHING selected, to the prompt box — revealing the sidebar when the Explorer
    // has it — with the caret in the box and nothing added.
    await agent({ op: "select", selection: [1, 2, 1, 2] })
    await command("workbench.view.explorer")
    await waitFor("the Frizz view hidden", async () => !(await status()).sidebar.visible || undefined, 10_000)
    await openInEditor(files.sample)
    await agent({ op: "select", selection: [1, 2, 1, 2] })
    // The empty selection crosses to the renderer, where `editorHasSelection` is kept, on its own channel.
    await sleep(800)
    await press("Control+KeyL")
    const toPrompt = await until(async () => {
      const state = await box("chatComposer").catch(() => null)
      return !!state?.active && state.frameFocused && (await workbenchFocus()).sidebar
    }, 8_000)
    const there = { box: await box("chatComposer").catch(() => null), focus: await workbenchFocus(), editor: await editorState(), visible: (await status()).sidebar.visible }
    expect("c4", "Ctrl+L in the editor with nothing selected reveals the sidebar and puts the caret in the reply box, adding nothing", toPrompt && there.visible && there.box?.value === "" && there.editor.selection?.start[0] === 1 && there.editor.selection.start[1] === 2, there)
    await shot("c4-ctrl-l-to-prompt-w300")
  })

  // ── c5: Ask Frizz to fix ──
  await run("c5", "Ask Frizz to fix on a real TypeScript error", async () => {
    await resetPage()
    await openThreadRow()
    // A draft an earlier check left (the drawer keeps it) would ride along in front of the chip.
    await clearBox("chatComposer")
    const fixAt = Date.now()
    await openInEditor(files.broken)
    const diagnostics = await waitFor("TypeScript's error in broken.ts", async () => {
      const found = await agent<{ message: string; source: string | null; code: string | number | null; range: number[] }[]>({ op: "diagnostics", path: files.broken })
      return found.find((d) => d.source === "ts") ? found : undefined
    }, 90_000)
    const problem = diagnostics.find((d) => d.source === "ts")!
    notes.diagnostic = problem
    // The caret on the error, then the quick-fix chord, and the item clicked like a human picks it.
    await agent({ op: "select", selection: [problem.range[0]!, problem.range[1]!, problem.range[0]!, problem.range[1]!] })
    await sleep(1_000)
    const kept = await workbenchFocus()
    notes.focusBeforeQuickFix = { focus: kept, trace: await focusTraceSince(fixAt) }
    expect("c5", "the editor keeps the caret while the human reads the error (nothing pulls it into the sidebar)", kept.editor, notes.focusBeforeQuickFix)
    // The menu waits on every provider, tsserver's fixes included, which are slow on a first request. The
    // chord goes the instant the caret is set: a beat later the page may hold the keyboard (above).
    const menuShows = () => until(async () => (await inWorkbench(() => [...document.querySelectorAll(".action-widget")].some((w) => (w as HTMLElement).offsetHeight > 0 && /Ask Frizz to fix/u.test(w.textContent ?? "")))), 20_000)
    let menu = false
    for (let attempt = 1; attempt <= 3 && !menu; attempt++) {
      if (!(await workbenchFocus()).editor) {
        // Back into the editor the way a human would: a click.
        await clickInWorkbench(".editor-group-container .monaco-editor .view-lines")
        await until(async () => (await workbenchFocus()).editor, 3_000)
      }
      await agent({ op: "select", selection: [problem.range[0]!, problem.range[1]!, problem.range[0]!, problem.range[1]!] })
      await press("Control+Period")
      menu = await menuShows()
      if (!menu) {
        notes[`quickFixTry${attempt}`] = { focus: await workbenchFocus(), widget: await inWorkbench(() => (document.querySelector(".context-view") as HTMLElement | null)?.innerText.slice(0, 300) ?? "no context view") }
        if ((await workbenchFocus()).editor) await press("Escape")
      }
    }
    if (!menu) throw new Error(`no quick-fix menu with Ask Frizz to fix after Ctrl+. three times: ${JSON.stringify(notes.quickFixTry3)}`)
    const widget = await rectOf(".action-widget")
    if (widget) await capture(join(out, `${version}-c5-quick-fix-menu.png`), { x: widget.x - 8, y: widget.y - 8, width: widget.width + 16, height: widget.height + 16 }, 2)
    const item = (await page.evaluateHandle(() => [...document.querySelectorAll(".action-widget .monaco-list-row, .action-widget li")].find((row) => /Ask Frizz to fix/u.test(row.textContent ?? "")) ?? null)).asElement() as ElementHandle | null
    await clickHandle(item, "the Ask Frizz to fix item")
    const line = problem.range[0]! + 1
    const fixed = await waitFor("the chip and the note", async () => {
      const state = await box("chatComposer").catch(() => null)
      return state?.value.includes(`@broken.ts:${line}`) ? state : undefined
    }, 15_000).catch(async () => box("chatComposer").catch(() => null))
    const want = `@broken.ts:${line} Fix: ${problem.message} ts(${problem.code})`
    expect("c5", "the chip and the problem land in the thread's reply box", fixed?.value.trim() === want && fixed.pills.some((pill) => pill.token === `@broken.ts:${line}`), { want, got: fixed?.value })
    const afterFix = await caretAfterPause("chatComposer")
    expect("c5", "…with the caret after them, in the sidebar, 1.5s later", !!afterFix.box?.active && afterFix.box.frameFocused && afterFix.box.caret >= want.length && afterFix.focus.sidebar, afterFix)
    await shot("c5-ask-to-fix-w300", { window: true })
    await clearBox("chatComposer")
  })

  // ── c6: links out of the transcript ──
  await run("c6", "links in the real transcript", async () => {
    await resetPage()
    await openThreadRow()
    await command("workbench.action.closeAllEditors")
    await clickInPage(`[data-local-path="${files.a}"]`, "the a.ts link")
    const opened = await waitFor("a.ts in the editor at lines 2-3", async () => {
      const editor = await editorState()
      return editor.path === files.a && editor.selection?.start[0] === 1 && editor.selection.end[0] === 2 ? editor : undefined
    }, 10_000).catch(() => editorState())
    expect("c6", "a code-file link opens the file in the editor, lines 2-3 selected", opened.path === files.a && opened.selection?.start[0] === 1 && opened.selection.end[0] === 2, opened)
    expect("c6", "…in THIS window, over the sidebar's own wire, not through an opener", !/code|cursor/u.test(stack!.openers()), stack!.openers())
    await shot("c6-code-link-opened", { window: true })

    // The web link: VS Code's openExternal, which ends at the stub xdg-open.
    await clickInPage('a[href="https://example.com/spec"]', "the web link")
    let dialog: string | null = null
    await sleep(1_500)
    dialog = await inWorkbench(() => {
      const box = document.querySelector<HTMLElement>(".monaco-dialog-box")
      return box && box.offsetHeight > 0 ? box.innerText.replace(/\s+/gu, " ").slice(0, 300) : null
    })
    if (dialog) {
      notes.openExternalDialog = dialog
      await shot("c6-open-external-dialog", { window: true })
      const open = (await page.evaluateHandle(() => [...document.querySelectorAll(".monaco-dialog-box .monaco-button")].find((b) => /^Open$/u.test((b.textContent ?? "").trim())) ?? null)).asElement() as ElementHandle | null
      await clickHandle(open, "the dialog's Open")
    }
    // VS Code's link protection asks before an untrusted domain opens. The test runner refuses every dialog
    // (DialogService: "refused to show dialog in tests"), and the extension logs the refusal: that line is
    // the proof the link reached VS Code's opener. A trusted domain would go on to `xdg-open` (a stub).
    const reached = await until(() => /xdg-open https:\/\/example\.com\/spec/u.test(stack!.openers()) || /open the external website/u.test(frizzLog()), 10_000)
    const outcome = (await status()).sidebar.events.filter((event) => event.type === "frizz:open-external").at(-1)
    const line = frizzLog().split("\n").find((entry) => /frizz:open-external/u.test(entry)) ?? null
    notes.openExternal = { openers: stack!.openers(), outcome, dialog, log: line }
    expect("c6", "a web link goes to VS Code's openExternal — no window from the frame (VS Code's own 'open the external website?' prompt comes first)", reached, notes.openExternal)

    // The drawer's ↗ (Open in browser): the page asks the host to open the thread's own page. Frizz's
    // address is loopback, which VS Code's link protection trusts, so this one goes all the way to the
    // system opener — the stub `xdg-open`, which only writes down what it was asked.
    const fullUrl = `/thread/${seeded!.thread.slug}/full`
    const expand = (await (await frame()).evaluateHandle((slug) => document.querySelector(`[role=dialog] a[data-expand-thread="${slug}"]`), seeded!.thread.slug)).asElement() as ElementHandle | null
    await clickHandle(expand, "the drawer's Open in browser")
    const toOpener = await until(() => stack!.openers().split("\n").some((line) => line.startsWith("xdg-open ") && line.includes(fullUrl)), 10_000)
    expect("c6", "the drawer's Open in browser goes through VS Code's openExternal to the system opener (a stub xdg-open)", toOpener, stack!.openers())

    // A Markdown link: Frizz's own reader.
    await clickInPage(`[data-local-path="${files.readme}"]`, "the README link")
    const reader = await until(async () => (await inPage((path) => !!document.querySelector(`button[aria-label="Open"][title^="Open ${path}"]`), files.readme)), 8_000)
    const front = (await editorState()).path
    expect("c6", "a Markdown link opens Frizz's reader, and nothing in the editor", reader && front !== files.readme, { reader, front })
    await shot("c6-markdown-reader-w300")
    notes.titleRowReader = await titleRow()
    await press("Escape")
    await until(async () => !(await inPage((path) => !!document.querySelector(`button[aria-label="Open"][title^="Open ${path}"]`), files.readme)), 4_000)
  })

  // ── c8: keys with the frame focused ──
  const focusPageBody = async () => {
    // A click on the sidebar page's own background, not on a control or a box: the keyboard is the page's.
    const spot = await inPage(() => {
      const root = document.querySelector<HTMLElement>("[data-sidebar-page]")
      const r = root?.getBoundingClientRect()
      return r ? { x: r.left + 4, y: r.bottom - 6 } : null
    })
    const frameBox = await (await (await frame()).frameElement())?.boundingBox()
    if (!spot || !frameBox) throw new Error("no page background to click")
    await page.mouse.click(frameBox.x + spot.x, frameBox.y + Math.min(spot.y, frameBox.height - 6))
    await inPage(() => (document.activeElement as HTMLElement | null)?.blur?.())
  }
  await run("c8", "keys with the frame focused", async () => {
    await resetPage()
    await focusPageBody()
    const keysBefore = (await status()).sidebar.events.filter((event) => event.type === "frizz:key").length
    await press("Control+Shift+KeyP")
    const vsPalette = await until(paletteOpen, 5_000)
    const keyEvents = (await status()).sidebar.events.filter((event) => event.type === "frizz:key").slice(keysBefore)
    expect("c8", "Ctrl+Shift+P from the frame opens VS Code's command palette (forwarded)", vsPalette && keyEvents.some((event) => event.outcome === "workbench.action.showCommands"), keyEvents)
    await shot("c8-vscode-palette", { window: true })
    await press("Escape")
    await until(async () => !(await paletteOpen()), 3_000)

    await focusPageBody()
    const before = (await status()).sidebar.events.filter((event) => event.type === "frizz:key").length
    await press("Control+KeyK")
    const frizzPalette = await until(async () => (await inPage(() => !!document.querySelector("[cmdk-root]"))), 5_000)
    await sleep(500)
    const forwarded = (await status()).sidebar.events.filter((event) => event.type === "frizz:key").slice(before)
    expect("c8", "Ctrl+K opens Frizz's palette and is not forwarded to VS Code", frizzPalette && forwarded.length === 0 && !(await paletteOpen()), forwarded)
    await press("Escape")
    await until(async () => !(await inPage(() => !!document.querySelector("[cmdk-root]"))), 3_000)

    await focusPageBody()
    await page.keyboard.type("?")
    const sheet = await until(async () => (await inPage(() => !!document.querySelector("[data-shortcut-list]"))), 5_000)
    const sheetState = await inPage(() => ({
      note: document.querySelector("[data-shortcut-sidebar-note]")?.textContent ?? null,
      hints: [...document.querySelectorAll("[data-shortcut-hint]")].map((h) => h.textContent),
      editor: [...document.querySelectorAll<HTMLElement>("[data-shortcut-editor] li")].map((row) => ({ label: row.innerText.split("\n")[0], keys: row.querySelector("[aria-label]")?.getAttribute("aria-label") ?? "" })),
      // The Editor group leads: it is the first group after the notes.
      editorFirst: document.querySelector("[data-shortcut-list] section")?.matches("[data-shortcut-editor]") ?? false,
      host: document.querySelector<HTMLElement>("[data-shortcut-host]")?.innerText.replace(/\s+/gu, " ").slice(0, 400) ?? null,
    }))
    expect("c8", "? opens the shortcuts sheet, with its sidebar hints and its VS Code group", sheet && !!sheetState.note && sheetState.hints.length >= 3 && /VS Code/u.test(sheetState.host ?? "") && /Ctrl/u.test(sheetState.host ?? ""), sheetState)
    expect("c8", "…led by the Editor group: Ctrl+L adds the selection or with none goes to the prompt box, Alt+K the selection or the file", sheetState.editorFirst && JSON.stringify(sheetState.editor.map((row) => row.keys)) === JSON.stringify(["Ctrl+L", "Ctrl+L", "Alt+K"]) && /prompt box/u.test(sheetState.editor[1]?.label ?? ""), sheetState.editor)
    await shot("c8-shortcuts-w300")
    await press("Escape")
    await until(async () => !(await inPage(() => !!document.querySelector("[data-shortcut-list]"))), 3_000)

    // The same sheet from VS Code's title row: its ⋯, Keyboard shortcuts — clicked, as a human does.
    await clickInWorkbench('.part.sidebar .title-actions .action-label[aria-label^="More Actions"]')
    const menuItem = await waitFor("Keyboard shortcuts in the ⋯ menu", async () => {
      const items = await inWorkbench(() => [...document.querySelectorAll<HTMLElement>(".monaco-menu .action-item .action-label")].filter((label) => label.getClientRects().length > 0).map((label) => label.getAttribute("aria-label") ?? label.textContent ?? ""))
      return items.some((label) => /Keyboard shortcuts/u.test(label)) ? items : undefined
    }, 5_000).catch(() => null)
    if (menuItem) {
      const item = await page.evaluateHandle(() => [...document.querySelectorAll<HTMLElement>(".monaco-menu .action-item .action-label")].find((label) => /Keyboard shortcuts/u.test(label.getAttribute("aria-label") ?? label.textContent ?? "")) ?? null)
      await clickHandle(item.asElement() as ElementHandle | null, "Keyboard shortcuts in the ⋯ menu")
    } else {
      // A native context menu (no DOM to click): the same command the item runs.
      notes.shortcutsMenu = "the ⋯ menu was not in the workbench's DOM; ran frizz.sidebar.shortcuts"
      await press("Escape")
      await command("frizz.sidebar.shortcuts")
    }
    const fromRow = await until(async () => (await inPage(() => !!document.querySelector("[data-shortcut-list]"))), 5_000)
    const sheetFocus = await inPage(() => ({ hasFocus: document.hasFocus(), inSheet: !!document.activeElement?.closest("[role=dialog]") }))
    expect("c8", "the title row's ⋯ Keyboard shortcuts opens the sheet, with the keyboard in it", fromRow && sheetFocus.inSheet, { menu: menuItem, ...sheetFocus })
    await shot("c8-shortcuts-from-title-row-w300")
    await press("Escape")
    await until(async () => !(await inPage(() => !!document.querySelector("[data-shortcut-list]"))), 3_000)

    await focusPageBody()
    await press("Control+Digit1")
    const back = await until(async () => (await workbenchFocus()).editor, 5_000)
    expect("c8", "Ctrl+1 from the frame returns to the editor", back, await workbenchFocus())
  })

  // ── c7: theme ──
  await run("c7", "a VS Code theme switch re-themes the page live", async () => {
    const urlBefore = (await frame()).url()
    const at = Date.now()
    await agent({ op: "config", section: "workbench", key: "colorTheme", value: "Default Light Modern" })
    const light = await until(async () => (await inPage(() => document.documentElement.dataset.theme)) === "light", 8_000)
    notes.themeSwitchMs = Date.now() - at
    const bg = await inPage(() => getComputedStyle(document.body).backgroundColor)
    expect("c7", "light: the page turns light, without reloading", light && (await frame()).url() === urlBefore && (await status()).sidebar.ready, { ms: notes.themeSwitchMs, bg })
    await shot("c7-queue-light-w300", { window: true })
    await agent({ op: "config", section: "workbench", key: "colorTheme", value: "Default Dark Modern" })
    const dark = await until(async () => (await inPage(() => document.documentElement.dataset.theme)) === "dark", 8_000)
    expect("c7", "dark again: the page follows back", dark)
  })

  // ── c9: the gallery, at ~300px and ~450px ──
  const sidebarWidth = async () => (await rectOf(".part.sidebar"))?.width ?? 0
  const dragSidebarTo = async (width: number) => {
    const sash = await inWorkbench(() => {
      const part = document.querySelector(".part.sidebar")!.getBoundingClientRect()
      const sashes = [...document.querySelectorAll<HTMLElement>(".monaco-sash.vertical")].map((s) => s.getBoundingClientRect()).filter((r) => r.height > 100 && Math.abs(r.left + r.width / 2 - part.right) < 6)
      const r = sashes[0]
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: part.right, y: part.top + part.height / 2 }
    })
    const delta = width - (await sidebarWidth())
    await page.mouse.move(sash.x, sash.y)
    await page.mouse.down()
    for (let step = 1; step <= 10; step++) await page.mouse.move(sash.x + (delta * step) / 10, sash.y)
    await page.mouse.up()
    await sleep(800)
  }
  const gallery = async (tag: string) => {
    await command("workbench.view.extension.frizz")
    await waitFor("the Frizz view", async () => (await status()).sidebar.visible || undefined, 10_000)
    await resetPage()
    await openInEditor(files.sample)
    await selectLines23()
    const frameWidth = await inPage(() => innerWidth)
    notes[`gallery-${tag}`] = { sidebar: await sidebarWidth(), frame: frameWidth, scrollWidth: await inPage(() => document.documentElement.scrollWidth) }
    await shot(`c9-queue-dark-${tag}`, { window: true })
    await agent({ op: "config", section: "workbench", key: "colorTheme", value: "Default Light Modern" })
    await until(async () => (await inPage(() => document.documentElement.dataset.theme)) === "light", 8_000)
    await shot(`c9-queue-light-${tag}`)
    await agent({ op: "config", section: "workbench", key: "colorTheme", value: "Default Dark Modern" })
    await until(async () => (await inPage(() => document.documentElement.dataset.theme)) === "dark", 8_000)

    await openThreadRow()
    await openInEditor(files.sample)
    notes[`ctrlLTries-${tag}`] = await selectAndAdd(true)
    await waitFor("the chip", async () => (await box("chatComposer"))?.value.includes("@sample.ts:2-3") || undefined, 15_000)
    await sleep(1_000)
    if (!(await box("chatComposer"))?.active) await clickInPage('textarea[data-surface="chatComposer"]')
    await press("End")
    await typeInto("chatComposer", "why does this loop?")
    await shot(`c9-thread-selection-chip-dark-${tag}`, { window: true })
    await agent({ op: "config", section: "workbench", key: "colorTheme", value: "Default Light Modern" })
    await until(async () => (await inPage(() => document.documentElement.dataset.theme)) === "light", 8_000)
    await shot(`c9-thread-selection-chip-light-${tag}`)
    await agent({ op: "config", section: "workbench", key: "colorTheme", value: "Default Dark Modern" })
    await until(async () => (await inPage(() => document.documentElement.dataset.theme)) === "dark", 8_000)

    await clickInComposer("chatComposer", "[data-editor-open-files]")
    const menuOpen = async () => (await inPage(() => [...document.querySelectorAll("[data-editor-open-file]")].some((item) => item.getClientRects().length > 0)))
    if (await until(menuOpen, 5_000)) {
      await shot(`c9-open-files-menu-${tag}`)
      // Escape only with the menu up: with nothing over the drawer it would close the drawer.
      await press("Escape")
      await until(async () => !(await menuOpen()), 3_000)
      await sleep(500)
      const stillOpen = await drawerOpen()
      expect("c9", `${tag}: Escape on the open-files menu closes the menu and leaves the thread open`, stillOpen, { drawerOpen: stillOpen })
      if (!stillOpen) await openThreadRow()
    }
    await sleep(300)
    await clearBox("chatComposer")

    await clickInWorkbench('.part.sidebar .title-actions .action-label[aria-label="Settings"]')
    await until(async () => (await inPage(() => !!document.querySelector('[data-settings-editor="appearance"]'))), 8_000)
    await sleep(800)
    // Opened from a thread: Settings must be what the human sees, not something under the drawer.
    const onTop = await inPage(() => {
      const settings = document.querySelector<HTMLElement>('[data-settings-editor="appearance"]')
      const r = settings?.getBoundingClientRect()
      if (!settings || !r) return { onTop: false, hit: null }
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 10))
      const panel = settings.closest<HTMLElement>("[class*='translate-x']") ?? settings.parentElement
      return { onTop: !!hit && (settings.contains(hit) || !!panel?.contains(hit)), hit: hit ? `${hit.tagName.toLowerCase()}.${String((hit as HTMLElement).className).slice(0, 60)}` : null }
    })
    expect("c9", `${tag}: Settings, opened from the title row over a thread, is drawn on top of the thread`, onTop.onTop, { ...onTop, titleRow: (await titleRow()).text })
    await shot(`c9-settings-${tag}`)
    await press("Escape")
    if (!(await until(async () => !(await inPage(() => !!document.querySelector('[data-settings-editor="appearance"]'))), 5_000))) await resetPage()
    if (await drawerOpen()) await clickInWorkbench('.part.sidebar .title-actions .action-label[aria-label="Back to queue"]')
    await until(async () => !(await drawerOpen()), 5_000)
    await focusPageBody()
    await page.keyboard.type("?")
    await until(async () => (await inPage(() => !!document.querySelector("[data-shortcut-list]"))), 5_000)
    await shot(`c9-shortcuts-${tag}`)
    await press("Escape")
    const overflow = await inPage(() => document.documentElement.scrollWidth - innerWidth)
    expect("c9", `${tag}: the gallery was drawn, and nothing overflows sideways`, overflow <= 0, notes[`gallery-${tag}`])
  }
  await run("c9", "the gallery at ~300px and ~450px", async () => {
    const start = await sidebarWidth()
    if (Math.abs(start - 300) > 12) await dragSidebarTo(300)
    await gallery(`w${Math.round(await sidebarWidth())}`)
    await dragSidebarTo(450)
    await gallery(`w${Math.round(await sidebarWidth())}`)
  })

  // ── c10: one switch ──
  /** The worker's `editor` tool, run for real (frizz-mcp.mjs, as a worker of this window's project runs it). */
  const toolReads = () => workerTool({ node: process.execPath, mcp: join(repo, "cc-worker", "bin", "frizz-mcp.mjs"), serverLock: stack!.info.launcher.serverLock, projectId: workspace.id, home: stack!.info.home })
  const sharing = () => agent<SettingState>({ op: "inspect", section: "frizz", key: "shareEditorState" })
  const eye = () => inPage(() => [...document.querySelectorAll<HTMLElement>("[data-editor-context-toggle]")].find((toggle) => toggle.getClientRects().length > 0)?.getAttribute("aria-pressed") ?? null)
  /** Type and send from the reply box; what reached the simulated worker. */
  const sendFromReply = async (text: string) => {
    const before = readFileSync(seeded!.inputs, "utf8").trim().split("\n").filter(Boolean).length
    await clickInPage('textarea[data-surface="chatComposer"]')
    await until(async () => (await box("chatComposer"))?.active === true, 3_000)
    await typeInto("chatComposer", text)
    await press("Enter")
    return waitFor(`"${text}" at the simulated worker`, () => {
      const lines = readFileSync(seeded!.inputs, "utf8").trim().split("\n").filter(Boolean)
      return lines.length > before ? (JSON.parse(lines.at(-1)!) as { id: string; text: string }) : undefined
    }, 20_000)
  }
  await run("c10", "one switch: the eye is frizz.shareEditorState, for the block a send carries and for the agents' tool", async () => {
    await resetPage()
    await openThreadRow()
    await openInEditor(files.sample, [1, 0, 2, -1])
    await waitFor("the reply box's bar on the selection", async () => (await contextBar("chatComposer"))?.kind === "selection" || undefined, 5_000)
    const on = await waitFor("the tool reading lines 2-3", async () => {
      const text = await toolReads()
      return /lines 2-3 selected/u.test(text) ? text : undefined
    }, 20_000).catch(toolReads)
    expect("c10", "sharing on: the agents' tool reads the selection, lines 2-3 with their text", /lines 2-3 selected/u.test(on) && on.includes("let total = 0"), on.slice(0, 500))

    // The eye, clicked off: the setting, the tool, the bar and the next send all follow.
    await clickInComposer("chatComposer", "[data-editor-context-toggle]")
    const off = await waitFor("the setting off", async () => {
      const state = await sharing()
      return state.value === false ? state : undefined
    }, 8_000).catch(sharing)
    expect("c10", "the eye, clicked off, turns frizz.shareEditorState off (the user's value, so every window)", off.value === false && off.globalValue === false, off)
    const offText = await waitFor("the tool reading nothing", async () => {
      const text = await toolReads()
      return /turned off sharing/u.test(text) ? text : undefined
    }, 10_000).catch(toolReads)
    expect("c10", "…the agents' tool reads nothing, and says the human turned sharing off", /turned off sharing/u.test(offText) && !offText.includes("let total = 0"), offText.slice(0, 400))
    expect("c10", "…the eye shows off", (await eye()) === "false", await contextBar("chatComposer"))
    await shot("c10-eye-off-w300")
    const unshared = await sendFromReply("what does this do?")
    expect("c10", "…and a send carries no editor context", unshared.text.startsWith("what does this do?") && parseSentEditorContext(unshared.text) === null && !unshared.text.includes("let total = 0"), unshared.text.slice(0, 400))

    // On again from VS Code's side (Settings, another window): the eye follows, and so does everything else.
    await agent({ op: "config", section: "frizz", key: "shareEditorState", value: true })
    expect("c10", "the setting turned on in VS Code turns the eye on", await until(async () => (await eye()) === "true", 8_000), await contextBar("chatComposer"))
    const back = await waitFor("the tool reading lines 2-3 again", async () => {
      const text = await toolReads()
      return /lines 2-3 selected/u.test(text) ? text : undefined
    }, 20_000).catch(toolReads)
    expect("c10", "…the agents' tool reads the selection again", /lines 2-3 selected/u.test(back), back.slice(0, 300))
    const shared = await sendFromReply("and now?")
    const block = parseSentEditorContext(shared.text)
    const lines23 = SAMPLE.split("\n").slice(1, 3).join("\n")
    expect("c10", "…a send carries the block: lines 2-3 of sample.ts, quoted", block?.editor.kind === "selection" && block.editor.startLine === 2 && block.editor.endLine === 3 && block.editor.text === lines23 && block.body === "and now?", { text: shared.text.slice(0, 600), block })
    // The same selection again: named, not quoted a second time (the agent has it, one message up). The
    // page reads "one message up" from the thread's transcript, so the sent message must be in it first.
    await until(async () => (await inPage(() => document.body.innerText.includes("and now?"))), 15_000)
    await sleep(500)
    const again = await sendFromReply("and again?")
    const repeat = parseSentEditorContext(again.text)
    expect("c10", "…and the same selection on the next send is named, not quoted again", repeat?.editor.kind === "selection" && repeat.editor.repeat === true && repeat.editor.startLine === 2 && !again.text.includes("let total = 0"), { text: again.text.slice(0, 600), repeat })
    await agent({ op: "config", section: "frizz", key: "shareEditorState", value: null })
  })

  // ── c11: Claude Code's Alt+K ──
  await run("c11", "with Claude Code's extension installed, Alt+K is its: Frizz steps aside, and takes it back when it goes", async () => {
    await resetPage()
    await openThreadRow()
    await clearBox("chatComposer")
    await agent({ op: "install", vsix: claudeCodeStandIn }, 120_000)
    const installed = await until(async () => await agent<boolean>({ op: "extension", id: "anthropic.claude-code" }), 20_000)
    expect("c11", "the stand-in with Claude Code's id installs live, with no reload", installed)
    await sleep(1_000)
    await openInEditor(files.sample, [3, 1, 3, 1])
    await sleep(800)
    await press("Alt+KeyK")
    await sleep(1_500)
    const theirs = { box: await box("chatComposer"), editor: await editorState() }
    const lastLine = SAMPLE.split("\n").length - 1
    expect("c11", "Alt+K adds nothing to Frizz's prompt box", !/sample\.ts/u.test(theirs.box?.value ?? ""), theirs.box)
    expect("c11", "…it is Claude Code's: the stand-in's binding answered (Select All)", theirs.editor.selection?.start.join() === "0,0" && theirs.editor.selection.end[0] === lastLine, theirs.editor)
    await focusPageBody()
    await page.keyboard.type("?")
    await until(async () => (await inPage(() => !!document.querySelector("[data-shortcut-list]"))), 5_000)
    const rows = await inPage(() => [...document.querySelectorAll<HTMLElement>("[data-shortcut-editor] li")].map((row) => row.querySelector("[aria-label]")?.getAttribute("aria-label") ?? ""))
    expect("c11", "…and the ? sheet no longer lists Alt+K", rows.length > 0 && !rows.includes("Alt+K"), rows)
    await shot("c11-shortcuts-with-claude-code-w300")
    await press("Escape")

    await command("workbench.extensions.uninstallExtension", "anthropic.claude-code")
    const gone = await until(async () => !(await agent<boolean>({ op: "extension", id: "anthropic.claude-code" })), 20_000)
    expect("c11", "the stand-in uninstalls, live", gone)
    if (!(await drawerOpen())) await openThreadRow()
    await openInEditor(files.sample, [3, 1, 3, 1])
    await sleep(800)
    await press("Alt+KeyK")
    // A whole file with no text lands as a reference to it (lib/editorCompose.ts), `src/sample.ts`.
    const ours = await waitFor("the file from Alt+K", async () => {
      const state = await box("chatComposer")
      return /sample\.ts/u.test(state?.value ?? "") ? state : undefined
    }, 8_000).catch(async () => box("chatComposer"))
    expect("c11", "…and Alt+K is Frizz's again: the whole file into the reply box", /sample\.ts(?!:)/u.test(ours?.value ?? ""), ours)
    await clearBox("chatComposer")
  })

  // ── c12: the window's own thread ──
  await run("c12", "a window opened on a thread's worktree opens the sidebar on that thread", async () => {
    const first = notes.firstRoute as string | null
    if (!worktreeThread) {
      expect("c12", "a window on the project itself opens on the queue, not on a thread", first !== null && !/\/thread\//u.test(first), { firstRoute: first })
      return
    }
    const onIt = (href: string | null | undefined) => !!href && new URL(href).pathname.endsWith(`/thread/${worktreeThread.slug}`)
    const href = await waitFor(`the sidebar on ${worktreeThread.slug}`, async () => {
      const now = (await status()).sidebar.href
      return onIt(now) ? now : undefined
    }, 20_000).catch(async () => (await status()).sidebar.href)
    expect("c12", "the sidebar's page is on the worktree's thread, with nothing here asking it to be", onIt(href), { firstRoute: first, href })
    const shown = await waitFor("the thread's drawer", async () => {
      const read = await inPage((title) => {
        const drawer = [...document.querySelectorAll<HTMLElement>("[data-drawer-layer]")].at(-1)
        return drawer && drawer.innerText.includes(title) ? { title, composer: !!drawer.querySelector('textarea[data-surface="chatComposer"]') } : undefined
      }, worktreeThread.title)
      return read
    }, 15_000).catch(() => undefined)
    expect("c12", "the page shows that thread, its title and its reply box", !!shown?.composer, shown)
    const said = frizzLog().split("\n").find((line) => line.includes(`worktree of thread ${worktreeThread.slug}`))
    expect("c12", "the extension says why it opened there", !!said, said?.trim())
    await shot("c12-worktree-window-thread", { window: true })
    // A link the thread wrote into its worktree, to a file only the main checkout has (as every link is
    // once Done removed the worktree): clicked in the sidebar, the extension finds it missing, asks Frizz
    // (settleLocalPath) and opens the main checkout's copy at the linked line — not "doesn't exist".
    const { linked, main } = worktreeThread.onlyMain
    await clickTextInPage("[data-local-path]", "only-main.ts")
    const opened = await waitFor("the main checkout's copy in the editor", async () => {
      const now = await editorState()
      return now.path === main && now.selection?.start[0] === 1 ? now : undefined
    }, 15_000).catch(async () => editorState())
    const settledLine = frizzLog().split("\n").find((line) => line.includes(`${linked} is gone`))
    expect("c12", "a link into the worktree to a file it doesn't have opens the main checkout's copy, at its line", opened.path === main && opened.selection?.start[0] === 1, { linked, opened, log: settledLine?.trim() })
    await shot("c12-settled-link", { window: true })
  })

  // ── c13: a restart and a window reload (LAST: it ends the agent's VS Code) ──
  await run("c13", "a restart and a window reload keep what the page stored, and the eye", async () => {
    // A value in the framed page's own storage — where it keeps what the human set in it (its shortcuts,
    // drafts) — and the eye off, with a file in front so the bar (and its eye) is drawn.
    await openInEditor(files.sample)
    const probe = `reload-probe-${Date.now()}`
    await inPage((value) => localStorage.setItem("frizz-e2e-reload-probe", value), probe)
    const keysBefore = await inPage(() => Object.keys(localStorage).sort())
    await agent({ op: "config", section: "frizz", key: "shareEditorState", value: false })
    await until(async () => (await eye()) === "false", 8_000)
    // Under the test runner a window reload ENDS the run: VS Code exits with its extension host (seen:
    // "Test run failed with code 1" the moment Reload Window ran). So the agent is told it is done, that
    // VS Code closes, and the same profile — user data, extensions, settings — is opened again by a VS Code
    // of this harness's own, without the runner, where a reload is just a reload.
    finishAgent?.()
    await Promise.race([suite, sleep(60_000)])
    await killAll(editors)
    await browser?.disconnect().catch(() => undefined)
    const port = await freePort()
    spawn(vscodeExecutablePath, [
      workspace.dir, `--user-data-dir=${userData}`, `--extensions-dir=${join(scratch, "extensions")}`, `--extensionDevelopmentPath=${extensionPath}`,
      "--disable-extension=GitHub.copilot", "--disable-extension=GitHub.copilot-chat", "--password-store=basic", "--disable-gpu",
      "--disable-telemetry", "--skip-welcome", "--skip-release-notes", "--no-sandbox", "--disable-gpu-sandbox", "--disable-updates",
      "--disable-workspace-trust", `--remote-debugging-port=${port}`,
    ], { stdio: "ignore", env: process.env })
    browser = await waitFor("the relaunched VS Code's debugging port", () => puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null, protocolTimeout: 180_000 }), 60_000)
    page = await waitFor("the relaunched workbench", async () => (await browser!.pages()).find((candidate) => /workbench(\.esm)?\.html/u.test(candidate.url())), 60_000)
    cdp = await page.createCDPSession()
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true })
    page.on("pageerror", (error) => pageErrors.push(String(error)))
    // The side bar comes back on Frizz's view when the workspace remembers it; else, its icon, clicked.
    if (!(await until(async () => !!frizzFrame(), 30_000))) {
      await waitFor("the Frizz item in the activity bar", () => page.$('.part.activitybar .action-label[aria-label^="Frizz"]'), 30_000)
      await clickInWorkbench('.part.activitybar .action-label[aria-label^="Frizz"]')
    }
    const pageUp = async (not?: Frame) => waitFor("the page framed and drawn", async () => {
      const framedNow = frizzFrame()
      if (!framedNow || framedNow === not || framedNow.detached) return undefined
      return (await framedNow.evaluate(() => !!document.querySelector("[data-sidebar-page]")).catch(() => false)) ? framedNow : undefined
    }, 120_000)
    // No agent now: a file is opened as a human opens one, Quick Open typed — the eye is drawn only beside
    // a reading of what is in front. (A restart reopens no editors here; a reload keeps them.)
    const inFront = async () => {
      if (await until(async () => (await eye()) !== null, 3_000)) return
      await press("Control+KeyP")
      await until(paletteOpen, 5_000)
      await page.keyboard.type("sample.ts", { delay: 15 })
      await sleep(800)
      await press("Enter")
    }
    const restarted = await pageUp()
    await inFront()
    const afterRestart = await inPage(() => ({ probe: localStorage.getItem("frizz-e2e-reload-probe"), keys: Object.keys(localStorage).sort() }))
    expect("c13", "a restart: the page's own storage is still there", afterRestart.probe === probe, { before: keysBefore, after: afterRestart.keys })
    const eyeRestart = await waitFor("the eye", async () => (await eye()) ?? undefined, 20_000).catch(() => null)
    expect("c13", "…and the eye is still off: it is the VS Code setting", eyeRestart === "false", { eye: eyeRestart })

    // A window reload, as a human does it: the palette's Developer: Reload Window, typed.
    await press("Control+Shift+KeyP")
    await until(paletteOpen, 5_000)
    await page.keyboard.type("Developer: Reload Window", { delay: 15 })
    await sleep(800)
    await press("Enter")
    // Puppeteer keeps the workbench's page across a reload; the frame inside it is a new one.
    await pageUp(restarted)
    await inFront()
    const afterReload = await inPage(() => ({ probe: localStorage.getItem("frizz-e2e-reload-probe"), keys: Object.keys(localStorage).sort() }))
    expect("c13", "a window reload: the page's own storage is still there", afterReload.probe === probe, { before: keysBefore, after: afterReload.keys })
    const eyeReload = await waitFor("the eye", async () => (await eye()) ?? undefined, 20_000).catch(() => null)
    expect("c13", "…and the eye is still off", eyeReload === "false", { eye: eyeReload })
    await shot("c13-after-reload-w300", { window: true })
  })

  expect("all", "no page errors in the framed page", pageErrors.length === 0, pageErrors.slice(0, 10))
  expect("all", "no opener spawned but the web link's and Open in browser's xdg-open", stack.openers().split("\n").filter(Boolean).every((line) => /^xdg-open (https:\/\/example\.com\/spec|http:\/\/127\.0\.0\.1:\d+\/\S*\/thread\/[^/\s]+\/full)$/u.test(line)), stack.openers())
  exitCode = results.every((result) => result.ok) ? 0 : 1
} catch (error) {
  log((error as Error).stack ?? String(error))
  expect("run", "the run reached its end", false, String(error))
  if (page) await capture(join(out, `${version || "unknown"}-run-failure-window.png`)).catch(() => undefined)
  exitCode = 1
} finally {
  survivors = await teardown()
  if (survivors.length) {
    expect("run", "nothing survives the teardown", false, survivors)
    exitCode = 1
  }
  const passed = results.filter((result) => result.ok).length
  const file = join(out, `${version || "unknown"}-results.json`)
  writeFileSync(file, JSON.stringify({ version, extension: devMode ? "source tree" : "packaged .vsix", passed, failed: results.length - passed, results, notes, shots: shots.map((s) => s.slice(out.length + 1)), pageErrors, survivors }, null, 2))
  log(`${passed}/${results.length} passed; results ${file}; screenshots in ${out}`)
  if (exitCode === 0 && process.env.FRIZZ_E2E_KEEP !== "1" && !out.startsWith(scratch)) rmSync(scratch, { recursive: true, force: true })
  else log(`scratch kept: ${scratch}`)
}
process.exit(exitCode)
