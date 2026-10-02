import { test } from "node:test"
import assert from "node:assert/strict"
import { enabledPatterns, globMatcher, globToRegExp, rankFiles, type IndexedFile } from "./file-picks.ts"

test("VS Code's default exclude globs read as VS Code reads them", () => {
  const excluded = globMatcher(["**/.git", "**/node_modules", "**/*.code-search", "dist/**", "**/{bower_components,.svn}", "*.lo[gc]"])
  for (const path of [".git/config", "packages/web/node_modules/react/index.js", "node_modules/x.js", "saved.code-search", "a/b/saved.code-search", "dist/extension.js", "x/bower_components/y", "app.log", "app.loc"]) {
    assert.equal(excluded(path), true, path)
  }
  for (const path of ["src/git.ts", "src/node_modules.ts", "packages/dist/a.ts", "app.lot", "a/app.log"]) {
    assert.equal(excluded(path), false, path)
  }
})

test("a glob is anchored to the folder, and a class negates with !", () => {
  assert.equal(globToRegExp("src/*.ts").test("src/a.ts"), true)
  assert.equal(globToRegExp("src/*.ts").test("src/x/a.ts"), false)
  assert.equal(globToRegExp("**/*.min.js").test("a.min.js"), true)
  assert.equal(globToRegExp("[!a]*.md").test("b.md"), true)
  assert.equal(globToRegExp("[!a]*.md").test("a.md"), false)
  assert.equal(globToRegExp("./build/**").test("build/out/x"), true)
})

test("only the patterns a setting turns on exclude; a `when` condition is not followed", () => {
  assert.deepEqual(enabledPatterns({ "**/.git": true, "**/out": false, "**/*.js": { when: "$(basename).ts" } }), ["**/.git"])
  assert.deepEqual(enabledPatterns(undefined), [])
})

const files: IndexedFile[] = [
  "packages/web/src/App.tsx",
  "packages/web/src/components/AppShell.tsx",
  "packages/web/src/lib/happy.ts",
  "packages/server/src/app.ts",
  "packages/web/src/components/Composer.tsx",
  "packages/shared/src/web-board.ts",
  "README.md",
].map((label) => ({ path: `/r/${label}`, label }))

const labels = (ranked: IndexedFile[]) => ranked.map((file) => file.label)

test("a query ranks the file's own name first — exactly, by its start, anywhere in it — then the path, then letters in order", () => {
  // The exact name first; letters in order in a name after it (`App` … `.tsx`), never along the path.
  assert.deepEqual(labels(rankFiles(files, "app.tsx", new Set(), 10)), ["packages/web/src/App.tsx", "packages/web/src/components/AppShell.tsx"])
  assert.deepEqual(labels(rankFiles(files, "app", new Set(), 10)), [
    "packages/web/src/App.tsx",
    "packages/server/src/app.ts",
    "packages/web/src/components/AppShell.tsx",
    "packages/web/src/lib/happy.ts",
  ])
  assert.deepEqual(labels(rankFiles(files, "web/src/comp", new Set(), 10)), ["packages/web/src/components/AppShell.tsx", "packages/web/src/components/Composer.tsx"])
  assert.deepEqual(labels(rankFiles(files, "wbo", new Set(), 10)), ["packages/shared/src/web-board.ts"])
  assert.deepEqual(rankFiles(files, "  ", new Set(), 10), [])
})

test("within a rank, a file open in a tab comes first", () => {
  const ranked = rankFiles(files, "app", new Set(["/r/packages/web/src/components/AppShell.tsx"]), 10)
  assert.equal(ranked[0]!.label, "packages/web/src/components/AppShell.tsx")
  assert.equal(rankFiles(files, "a", new Set(), 2).length, 2)
})
