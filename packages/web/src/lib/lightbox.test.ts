import { test } from "node:test"
import assert from "node:assert/strict"
import { lightboxLabel, parseLightboxBody, resolveLightboxPath } from "./lightbox.ts"

test("a lightbox body is one picture per non-blank line, in order", () => {
  assert.deepEqual(parseLightboxBody("/tmp/a.png\n\n  /tmp/b.jpg  \n/tmp/c.webp\n"), [
    { target: "/tmp/a.png", caption: undefined },
    { target: "/tmp/b.jpg", caption: undefined },
    { target: "/tmp/c.webp", caption: undefined },
  ])
})

test("text after the path is its caption, with any leading separator or quotes stripped", () => {
  const lines = [
    "/tmp/a.png Before the fix",
    "/tmp/a.png    Before the fix",
    "/tmp/a.png — Before the fix",
    "/tmp/a.png - Before the fix",
    "/tmp/a.png | Before the fix",
    "/tmp/a.png: Before the fix",
    "/tmp/a.png—Before the fix",
    '/tmp/a.png "Before the fix"',
  ]
  for (const line of lines) {
    assert.deepEqual(parseLightboxBody(line), [{ target: "/tmp/a.png", caption: "Before the fix" }], line)
  }
})

test("a path with spaces ends at its image extension, not at its first space", () => {
  assert.deepEqual(parseLightboxBody("/Users/me/Desktop/Screen Shot 2026-10-02 at 1.23.45 PM.png  The settings page"), [
    { target: "/Users/me/Desktop/Screen Shot 2026-10-02 at 1.23.45 PM.png", caption: "The settings page" },
  ])
  assert.deepEqual(parseLightboxBody("/Users/me/My Project/shot.JPEG"), [
    { target: "/Users/me/My Project/shot.JPEG", caption: undefined },
  ])
})

test("backticked paths, list items and Markdown images are all accepted", () => {
  assert.deepEqual(parseLightboxBody("`/tmp/a b.png` After"), [{ target: "/tmp/a b.png", caption: "After" }])
  assert.deepEqual(parseLightboxBody("- /tmp/a.png\n* /tmp/b.png\n1. /tmp/c.png Third\n2) /tmp/d.png"), [
    { target: "/tmp/a.png", caption: undefined },
    { target: "/tmp/b.png", caption: undefined },
    { target: "/tmp/c.png", caption: "Third" },
    { target: "/tmp/d.png", caption: undefined },
  ])
  assert.deepEqual(parseLightboxBody("![Before the fix](/tmp/a.png)"), [{ target: "/tmp/a.png", caption: "Before the fix" }])
  assert.deepEqual(parseLightboxBody("![](</tmp/with space.png>)"), [{ target: "/tmp/with space.png", caption: undefined }])
  assert.deepEqual(parseLightboxBody('[After](/tmp/b.png "hover title")'), [{ target: "/tmp/b.png", caption: "After" }])
  assert.deepEqual(parseLightboxBody(String.raw`C:\Users\me\shot.png Windows`), [{ target: String.raw`C:\Users\me\shot.png`, caption: "Windows" }])
})

test("a line naming no image keeps the whole line, so the gallery can show what it could not draw", () => {
  assert.deepEqual(parseLightboxBody("/tmp/diagram.svg\nhttps://example.com/a.png?raw=1"), [
    { target: "/tmp/diagram.svg" },
    { target: "https://example.com/a.png?raw=1" },
  ])
})

test("a target resolves to the absolute path the image proxy serves, against the project and home", () => {
  const base = { dir: "/repo", home: "/Users/me" }
  assert.equal(resolveLightboxPath("/tmp/a.png", base), "/tmp/a.png")
  assert.equal(resolveLightboxPath(".frizz/threads/t1/after.png", base), "/repo/.frizz/threads/t1/after.png")
  assert.equal(resolveLightboxPath("~/Desktop/a.png", base), "/Users/me/Desktop/a.png")
  assert.equal(resolveLightboxPath("file:///tmp/a.png", base), "/tmp/a.png")
  assert.equal(resolveLightboxPath(String.raw`C:\shots\a.png`, base), String.raw`C:\shots\a.png`)
  // Before the board arrives there is no base, and a relative path names nothing yet.
  assert.equal(resolveLightboxPath("shots/a.png", { dir: "", home: "" }), null)
})

test("only a LOCAL raster image resolves — remote URLs and non-image files never reach the proxy", () => {
  const base = { dir: "/repo", home: "/Users/me" }
  for (const target of ["https://example.com/a.png", "//cdn.example/a.png", "/tmp/diagram.svg", "/tmp/notes.pdf", "data:image/png;base64,AAAA"]) {
    assert.equal(resolveLightboxPath(target, base), null, target)
  }
})

test("a picture is labelled by its caption, else by its file name", () => {
  assert.deepEqual(lightboxLabel({ target: "/tmp/a.png", caption: "Before" }, "/tmp/a.png"), { label: "Before", captioned: true })
  assert.deepEqual(lightboxLabel({ target: "/tmp/shots/after.png" }, "/tmp/shots/after.png"), { label: "after.png", captioned: false })
  assert.deepEqual(lightboxLabel({ target: "shots/gone.png" }, null), { label: "gone.png", captioned: false })
})
