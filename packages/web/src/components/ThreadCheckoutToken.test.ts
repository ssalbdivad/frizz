import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ThreadCheckoutToken, checkoutName, checkoutTitle } from "./ThreadCheckoutToken.tsx"
import { workingDirHint } from "./ThreadTerminals.tsx"

// The agent's checkout, "subtle but visible": absent in the ordinary case, one quiet token otherwise, and
// the Open terminal dialog saying the same fact in words.

const token = (checkout: Parameters<typeof ThreadCheckoutToken>[0]["checkout"]) =>
  renderToStaticMarkup(createElement(ThreadCheckoutToken, { checkout, homeDir: "/home/u", lead: createElement("span", { "data-lead": "" }, "·") }))

test("no checkout, no token — and no dangling separator", () => {
  assert.equal(token(undefined), "")
  assert.equal(token(null), "")
})

test("a worktree reads as its folder's name beside the git-folder glyph", () => {
  const html = token({ dir: "/home/u/frizz/.frizz/worktrees/rail-bands", kind: "worktree" })
  assert.match(html, /^<span data-lead="">·<\/span>/, "the lead comes first, and only with the token")
  assert.match(html, /data-thread-checkout="worktree"/)
  assert.match(html, /lucide-folder-git/)
  assert.match(html, />rail-bands<\/span>/)
  assert.match(html, /text-muted-60/, "a step quieter than the meta line around it")
  assert.match(html, /max-w-\[16ch\] truncate/)
  assert.match(html, /self-baseline translate-y-\[calc\(0\.5em_-_0\.5cap\)\]/, "the glyph sits on the cap band by the browser's own cap unit")
  assert.match(html, /-mt-\[1em\]/, "and adds no height above the text's line box")
})

test("a folder outside the project takes the plain folder glyph", () => {
  const html = token({ dir: "/srv/other/", kind: "folder" })
  assert.match(html, /data-thread-checkout="folder"/)
  assert.doesNotMatch(html, /lucide-folder-git/)
  assert.match(html, /lucide-folder/)
  assert.match(html, />other<\/span>/, "a trailing slash does not empty the name")
})

test("the tooltip says where, in home-relative form, and that new terminals open there", () => {
  assert.equal(
    checkoutTitle({ dir: "/home/u/frizz/.frizz/worktrees/rail-bands", kind: "worktree" }, "/home/u"),
    "Agent is working in a worktree\n~/frizz/.frizz/worktrees/rail-bands\nNew terminals open here",
  )
  assert.equal(checkoutTitle({ dir: "/home/u/other", kind: "folder" }, "/home/u"), "Agent is working in another folder\n~/other\nNew terminals open here")
  assert.equal(checkoutName("C:\\work\\probe"), "probe")
})

test("the dialog's hint names the kind of place the folder is", () => {
  assert.equal(workingDirHint({ source: "transcript", kind: "worktree" }), "Where the agent is working now — a worktree.")
  assert.equal(workingDirHint({ source: "transcript", kind: "folder" }), "Where the agent is working now — another folder.")
  assert.equal(workingDirHint({ source: "transcript", kind: "root" }), "Where the agent is working now — the project root.")
  assert.equal(workingDirHint({ source: "transcript" }), "Where the agent is working now.", "an older server's reply still reads")
  assert.equal(workingDirHint({ source: "session", kind: "root" }), "The folder the agent's session started in.")
  assert.equal(workingDirHint({ source: "project", kind: "root" }), "The project root.")
})

test("the drawer header sets the token between the time and the status, which still truncates first", () => {
  const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  const header = source.slice(source.indexOf("export function ThreadHeader("), source.indexOf("THREAD_HEADER_CONTROLS_CLASS}"))
  const at = (needle: string) => header.indexOf(needle)
  assert.ok(at("<LastActive") >= 0 && at("<ThreadCheckoutToken") > at("<LastActive"), "after the time")
  assert.ok(at("<ThreadStatusLine") > at("<ThreadCheckoutToken"), "before the status")
  assert.match(header, /<ThreadCheckoutToken checkout=\{thread\.checkout\}/)
})
