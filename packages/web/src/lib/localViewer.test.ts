import assert from "node:assert/strict"
import { test } from "node:test"
import { isRasterImagePath, localViewerFor } from "./localViewer.ts"

test("a picture opens in the picture viewer — raster and SVG alike, in either path spelling", () => {
  for (const path of ["/tmp/shot.png", "/tmp/SHOT.JPG", "/tmp/a.jpeg", "/tmp/a.gif", "/tmp/a.webp", "/repo/diagram.svg", "C:\\Users\\me\\shot.png"]) {
    assert.equal(localViewerFor(path), "image", path)
  }
  // Only the raster set goes through `/local-image`; the viewer reads an SVG as text instead.
  assert.equal(isRasterImagePath("/tmp/shot.png"), true)
  assert.equal(isRasterImagePath("/repo/diagram.svg"), false)
})

test("Markdown is rendered; code, data-as-text and files with no extension are read as source", () => {
  assert.equal(localViewerFor("/repo/README.md"), "markdown")
  assert.equal(localViewerFor("/repo/post.mdx"), "markdown")
  // An editor cursor suffix names the same file.
  assert.equal(localViewerFor("/repo/README.md:12"), "markdown")
  for (const path of [
    "/repo/src/App.tsx", "/repo/src/App.tsx:40:2", "/tmp/run.log", "/repo/data.csv", "/repo/package.json", "/repo/index.html",
    // The reason "text" is the default rather than a list: none of these is on any text-extension list,
    // and every one of them is a file a worker writes.
    "/repo/Makefile", "/repo/Dockerfile", "/repo/.gitignore", "/repo/.env.example", "/repo/src/App.vue", "/repo/Cargo.lock",
    "D:\\repo\\src\\main.rs",
  ]) {
    assert.equal(localViewerFor(path), "text", path)
  }
})

test("formats the page cannot draw stay with the desktop opener", () => {
  for (const path of [
    "/repo/contract.pdf", "/repo/budget.xlsx", "/repo/deck.pptx", "/repo/notes.docx", "/repo/dump.parquet", "/repo/app.sqlite3",
    // A notebook is JSON, but its source is escaped cells; a notebook app is what shows it.
    "/repo/analysis.ipynb",
    "/tmp/build.zip", "/tmp/release.tar.gz", "/tmp/clip.mp4", "/tmp/voice.m4a", "/tmp/font.woff2", "/tmp/a.out.wasm", "/tmp/model.safetensors",
    // A raster the image proxy does not serve.
    "/tmp/scan.tiff", "/tmp/photo.HEIC",
  ]) {
    assert.equal(localViewerFor(path), null, path)
  }
})
