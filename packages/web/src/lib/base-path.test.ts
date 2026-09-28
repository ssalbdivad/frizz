import assert from "node:assert/strict"
import { test } from "node:test"
import { apiBase, basePath, crossProjectHref, everythingHref, innerPath, isCrossProjectPath, isRetiredAppPath, outerPath, prefixedAppRoute, projectSlug, setHomeFocus } from "./base-path.ts"

// The launching project's fullscreen page is still served unprefixed, so an empty base is a supported state.
test("an unprefixed page has no base and addresses the unprefixed API", () => {
  for (const path of ["/", "/thread/fix-auth", "/thread/fix-auth/full", "/status/active", "/thread/a%2Fb"]) {
    assert.equal(basePath(path), "", path)
    assert.equal(innerPath(path), path, path)
    assert.equal(apiBase(path), "/_frizz", path)
    assert.equal(projectSlug(path), undefined, path)
  }
})

test("a drawer's project lives under /all, and its API stays flat", () => {
  assert.equal(basePath("/all/nub/thread/fix-auth"), "/all/nub")
  assert.equal(projectSlug("/all/pullfrog-app/thread/x/full"), "pullfrog-app")
  // The API is already inside a reserved namespace, so it has no root to protect: `/all` would buy
  // nothing there, and the server's split stays a two-part one.
  assert.equal(apiBase("/all/nub/thread/fix-auth"), "/_frizz/nub")
})

// THERE IS NO PROJECT PAGE (2026-09-28): its old address is an unknown one, naming no project, so
// nothing on the way home addresses that project's API or feed.
test("/project/<slug> names nothing", () => {
  for (const path of ["/project/nub", "/project/nub/thread/fix-auth", "/project/nub/thread/x/full"]) {
    assert.equal(projectSlug(path), undefined, path)
    assert.equal(basePath(path), "", path)
    assert.equal(apiBase(path), "/_frizz", path)
    assert.equal(isCrossProjectPath(path), false, path)
  }
})

// …but it is still an address Frizz minted, so a link to one is in-app (markdownTargets.ts isFrizzRoute)
// and is left exactly as written: re-pointed under a drawer's prefix it would name a route that never
// existed there, and it lands on the page either way.
test("a retired address is recognised, and never re-pointed", () => {
  for (const path of ["/project/nub", "/project/nub/thread/fix-auth", "/project/nub/thread/x/full", "/project/nub/status/active", "/status/active", "/status/active/"]) {
    assert.equal(isRetiredAppPath(path), true, path)
    assert.equal(prefixedAppRoute(path, "/all/zod/thread/x"), null, path)
  }
  for (const path of ["/project", "/project/acme/src/main.rs", "/project/acme/thread/x/notes.md", "/status", "/status/a/b", "/thread/x", "/all/nub"])
    assert.equal(isRetiredAppPath(path), false, path)
})

// The router reasons about the inner path, so a prefixed and an unprefixed page look identical to it.
test("inner and outer paths round-trip", () => {
  assert.equal(innerPath("/all/nub/thread/fix-auth"), "/thread/fix-auth")
  assert.equal(innerPath("/all/nub"), "/")
  assert.equal(outerPath("/thread/fix-auth", "/all/nub/thread/other"), "/all/nub/thread/fix-auth")
  // Closing the last drawer goes home: the page's root is `/` whichever project the drawer named.
  assert.equal(outerPath("/", "/all/nub/thread/other"), "/")
  // Unprefixed, outer is a no-op — which is what keeps the launching project's /full working.
  assert.equal(outerPath("/thread/fix-auth/full", "/thread/other/full"), "/thread/fix-auth/full")
  assert.equal(outerPath("/", "/"), "/")
})

// THE POINT of moving projects under a segment of their own: the root namespace stays Frizz's.
test("only /all/<slug> names a project, so the root is free for other pages", () => {
  assert.equal(basePath("/thread/nub"), "", "a thread called `nub` is not a project")
  assert.equal(basePath("/status/blocked"), "")
  // A future top-level page cannot be shadowed by a directory somebody happens to have.
  assert.equal(basePath("/settings"), "")
  assert.equal(basePath("/docs/getting-started"), "")
  assert.equal(projectSlug("/settings"), undefined)
  // …and `/all` with nothing after it is not a project either.
  assert.equal(basePath("/all"), "")
  assert.equal(projectSlug("/all/"), undefined)
  // The machine pages name no project.
  for (const path of ["/", "/projects", "/queues", "/all"]) {
    assert.equal(projectSlug(path), undefined, path)
    assert.equal(isCrossProjectPath(path), false, path)
  }
})

// THE CROSS-PROJECT PAGE'S FOCUS IS THE PAGE PROJECT. `/all/nub/thread/x` must answer every "which
// project" question for `nub` — the same API, the same feed, the same cache scope — so the drawer stack
// and composer work for it; and closing that drawer lands on `/`, the page itself.
test("the cross-project page is focused on a project", () => {
  const page = "/all/nub/thread/fix-auth"
  assert.equal(projectSlug(page), "nub")
  assert.equal(apiBase(page), "/_frizz/nub")
  assert.equal(basePath(page), "/all/nub")
  assert.equal(innerPath(page), "/thread/fix-auth")
  assert.equal(innerPath("/all/nub"), "/")
  assert.equal(outerPath("/thread/other", page), "/all/nub/thread/other")
  assert.equal(outerPath("/", page), "/")
  assert.equal(isCrossProjectPath(page), true)
  assert.equal(crossProjectHref("nub"), "/all/nub")
  // An agent's `/thread/<slug>` link opens in place, on this page.
  assert.equal(prefixedAppRoute("/thread/other", page), "/all/nub/thread/other")
  assert.equal(prefixedAppRoute("/all/zod/thread/x", page), null, "already names its project")
})

// A worker writes `[label](/thread/<slug>)` — the shape from when one server meant one project. Under
// a prefix that raw href addresses whichever project LAUNCHED the server, so every modified click
// (⌘, middle, "open in new tab") on an agent's own cross-reference landed on a stranger's thread.
test("an agent's unprefixed in-app link is re-pointed at the project the page is showing", () => {
  const page = "/all/nub/thread/fix-auth"
  assert.equal(prefixedAppRoute("/thread/other", page), "/all/nub/thread/other")
  assert.equal(prefixedAppRoute("/thread/other/full", page), "/all/nub/thread/other/full")
  // Query and fragment ride along rather than being dropped or re-pointed at the base.
  assert.equal(prefixedAppRoute("/thread/other?x=1#y", page), "/all/nub/thread/other?x=1#y")

  // Everything that must be left exactly as written.
  assert.equal(prefixedAppRoute("/all/other/thread/x", page), null, "already names its project")
  assert.equal(prefixedAppRoute("/", page), null, "the cross-project page is the same page everywhere")
  assert.equal(prefixedAppRoute("/Users/me/notes.md", page), null, "a filesystem path is not a route")
  assert.equal(prefixedAppRoute("//cdn.example/a", page), null, "protocol-relative is a web URL")
  assert.equal(prefixedAppRoute("docs/x", page), null)
  assert.equal(prefixedAppRoute(null, page), null)
  // On the launching project there is nothing to add, so the href is left alone rather than churned.
  assert.equal(prefixedAppRoute("/thread/other", "/thread/fix-auth/full"), null)
})

// AT `/` THE FOCUS IS NOT IN THE ADDRESS. Where a new thread goes is the prompt box's own setting; the
// route hands it over with `setHomeFocus`, and from then on `/` answers every "which project" question
// as a drawer's `/all/<focus>/…` would — while the address bar stays `/`.
test("the cross-project page at / is focused on a project the URL does not name", () => {
  try {
    setHomeFocus("nub")
    assert.equal(projectSlug("/"), "nub")
    assert.equal(apiBase("/"), "/_frizz/nub")
    assert.equal(isCrossProjectPath("/"), true)
    assert.equal(innerPath("/"), "/")
    assert.equal(outerPath("/", "/"), "/")
    assert.equal(outerPath("/thread/x", "/"), "/all/nub/thread/x", "a drawer's address names its project")
    assert.equal(prefixedAppRoute("/thread/x", "/"), "/all/nub/thread/x")
    // Only `/` — every other machine page still names nothing.
    assert.equal(projectSlug("/projects"), undefined)
    assert.equal(everythingHref("zod"), "/?focus=zod")
    assert.equal(everythingHref(), "/")
  } finally {
    setHomeFocus(undefined)
  }
  assert.equal(projectSlug("/"), undefined)
  assert.equal(isCrossProjectPath("/"), false)
})
