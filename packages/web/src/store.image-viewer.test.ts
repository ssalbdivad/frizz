import assert from "node:assert/strict"
import test from "node:test"
import { closeImageViewer, openImageViewer, resetProjectState, stepImageViewer, store } from "./store.ts"

test("the picture viewer opens on the clicked picture and steps within its gallery, clamped at both ends", () => {
  openImageViewer("/b.png", ["/a.png", "/b.png", "/c.png"])
  assert.deepEqual(store.imageViewer, { paths: ["/a.png", "/b.png", "/c.png"], index: 1 })
  stepImageViewer(1)
  stepImageViewer(1)
  assert.equal(store.imageViewer?.index, 2, "the last picture does not wrap round to the first")
  stepImageViewer(-1)
  stepImageViewer(-1)
  stepImageViewer(-1)
  assert.equal(store.imageViewer?.index, 0)
  closeImageViewer()
  assert.equal(store.imageViewer, null)
})

test("a picture that is not among the rendered ones opens on its own", () => {
  // A Markdown LINK to a picture is text, not a rendered picture, so it is in no gallery.
  openImageViewer("/linked.png", ["/a.png", "/b.png"])
  assert.deepEqual(store.imageViewer, { paths: ["/linked.png"], index: 0 })
  openImageViewer("/alone.png")
  assert.deepEqual(store.imageViewer, { paths: ["/alone.png"], index: 0 })
})

test("pictures from another project's card carry that project, and only they do", () => {
  openImageViewer("/opt/b/shot.png", ["/opt/b/shot.png"], "project-b")
  assert.deepEqual(store.imageViewer, { paths: ["/opt/b/shot.png"], index: 0, project: "project-b" })
  openImageViewer("/a.png", ["/a.png"])
  assert.deepEqual(store.imageViewer, { paths: ["/a.png"], index: 0 })
  closeImageViewer()
})

test("switching projects closes the picture viewer with everything else", () => {
  openImageViewer("/a.png", ["/a.png"])
  resetProjectState()
  assert.equal(store.imageViewer, null)
})
