import assert from "node:assert/strict"
import test from "node:test"
import {
  abbreviateHome,
  basename,
  dirnameLike,
  isRooted,
  joinLike,
  pathPrefixPattern,
  pathSeparatorOf,
  relativeTo,
  splitPath,
  tildePath,
} from "./paths.ts"

// The four spellings every case below is run against (Windows audit 2026-09-11, finding 12): a Windows
// path as Claude Code and Codex report it, the same drive with forward slashes as some tools write it,
// the POSIX shape, and a mixed one — a `C:\` project dir joined to a `/`-relative link is the everyday
// mixed case, not an edge.
const WIN = "C:\\Users\\x\\proj\\src\\a.ts"
const WIN_FWD = "C:/Users/x/proj/src/a.ts"
const POSIX = "/Users/x/proj/src/a.ts"
const MIXED = "C:\\Users\\x/proj\\src/a.ts"

test("splitPath splits on either separator, drops empties, and keeps a drive letter as a segment", () => {
  for (const path of [WIN, WIN_FWD, MIXED]) assert.deepEqual(splitPath(path), ["C:", "Users", "x", "proj", "src", "a.ts"], path)
  assert.deepEqual(splitPath(POSIX), ["Users", "x", "proj", "src", "a.ts"])
  assert.deepEqual(splitPath("//repo///docs/"), ["repo", "docs"])
  assert.deepEqual(splitPath(""), [])
})

test("isRooted: a leading separator or a drive plus separator; a bare drive is drive-relative", () => {
  for (const path of [WIN, WIN_FWD, POSIX, MIXED, "/", "\\", "C:\\", "c:/", "\\\\server\\share"]) assert.equal(isRooted(path), true, path)
  for (const path of ["src/a.ts", "src\\a.ts", "C:", "C:src", "a.ts", "", "~/x", "./x", "../x"]) assert.equal(isRooted(path), false, path)
})

test("pathSeparatorOf reads the first separator the path uses, defaulting to /", () => {
  assert.equal(pathSeparatorOf(WIN), "\\")
  assert.equal(pathSeparatorOf(WIN_FWD), "/")
  assert.equal(pathSeparatorOf(POSIX), "/")
  assert.equal(pathSeparatorOf(MIXED), "\\")
  assert.equal(pathSeparatorOf("a.ts"), "/")
})

test("joinLike keeps the base's separator and drive, and folds . and ..", () => {
  const cases: [base: string, rel: string, expected: string][] = [
    ["C:\\Users\\x\\proj\\docs", "guide.md", "C:\\Users\\x\\proj\\docs\\guide.md"],
    ["C:\\Users\\x\\proj\\docs", "./guide.md", "C:\\Users\\x\\proj\\docs\\guide.md"],
    ["C:\\Users\\x\\proj\\docs", "../AGENTS.md", "C:\\Users\\x\\proj\\AGENTS.md"],
    ["C:\\Users\\x\\proj\\docs", "a/../b/c.md", "C:\\Users\\x\\proj\\docs\\b\\c.md"],
    ["C:/Users/x/proj", "docs/guide.md", "C:/Users/x/proj/docs/guide.md"],
    ["/Users/x/proj/docs", "../AGENTS.md", "/Users/x/proj/AGENTS.md"],
    ["/Users/x/proj/docs/", "guide.md", "/Users/x/proj/docs/guide.md"],
    ["C:\\Users\\x/proj", "src/a.ts", "C:\\Users\\x\\proj\\src\\a.ts"],
    // A `..` escape climbs no higher than the root, and the drive survives the climb.
    ["C:\\Users\\x\\proj", "../../../../etc/passwd", "C:\\etc\\passwd"],
    ["/Users/x/proj", "../../../../etc/passwd", "/etc/passwd"],
    // An empty rel is the normalised base; a rooted rel ignores the base.
    ["C:\\Users\\x", "", "C:\\Users\\x"],
    ["/Users/x", "", "/Users/x"],
    ["/repo/docs", "/abs/b.md", "/abs/b.md"],
    ["/repo/docs", "D:\\abs\\b.md", "D:\\abs\\b.md"],
    ["\\\\server\\share\\docs", "../a.md", "\\\\server\\share\\a.md"],
  ]
  for (const [base, rel, expected] of cases) assert.equal(joinLike(base, rel), expected, `${base} + ${rel}`)
})

test("basename is the last segment in either spelling, or the path itself when it has none", () => {
  for (const path of [WIN, WIN_FWD, POSIX, MIXED]) assert.equal(basename(path), "a.ts", path)
  assert.equal(basename("/Users/x/proj/"), "proj")
  assert.equal(basename("C:\\Users\\x\\proj\\"), "proj")
  assert.equal(basename("a.ts"), "a.ts")
  assert.equal(basename("/"), "/")
  assert.equal(basename(""), "")
})

test("dirnameLike keeps the path's separator and root; a bare filename has no directory", () => {
  assert.equal(dirnameLike(WIN), "C:\\Users\\x\\proj\\src")
  assert.equal(dirnameLike(WIN_FWD), "C:/Users/x/proj/src")
  assert.equal(dirnameLike(POSIX), "/Users/x/proj/src")
  assert.equal(dirnameLike(MIXED), "C:\\Users\\x\\proj\\src")
  assert.equal(dirnameLike("/README.md"), "/")
  assert.equal(dirnameLike("C:\\README.md"), "C:\\")
  assert.equal(dirnameLike("docs/guide.md"), "docs")
  assert.equal(dirnameLike("guide.md"), "")
})

test("relativeTo: under the root in either spelling, drive letter case-insensitive, never the root itself", () => {
  assert.equal(relativeTo("C:\\Users\\x\\proj", WIN), "src\\a.ts")
  assert.equal(relativeTo("C:\\Users\\x\\proj", WIN_FWD), "src/a.ts")
  assert.equal(relativeTo("C:/Users/x/proj", WIN), "src\\a.ts")
  assert.equal(relativeTo("c:\\users\\x\\proj", WIN), null, "only the drive letter is case-insensitive")
  assert.equal(relativeTo("c:\\Users\\x\\proj", WIN), "src\\a.ts")
  assert.equal(relativeTo("C:\\Users\\x\\proj\\", WIN), "src\\a.ts", "a trailing separator on the root is not a segment")
  assert.equal(relativeTo("/Users/x/proj", POSIX), "src/a.ts")
  assert.equal(relativeTo("/Users/x/proj/", POSIX), "src/a.ts")
  assert.equal(relativeTo("C:\\Users\\x/proj", MIXED), "src/a.ts")
  // Not under: the root itself, a sibling that shares the prefix, another drive, a relative path.
  assert.equal(relativeTo("C:\\Users\\x\\proj", "C:\\Users\\x\\proj"), null)
  assert.equal(relativeTo("C:\\Users\\x\\proj", "C:\\Users\\x\\proj-old\\a.ts"), null)
  assert.equal(relativeTo("C:\\Users\\x\\proj", "D:\\Users\\x\\proj\\a.ts"), null)
  assert.equal(relativeTo("/Users/x/proj", "/Users/x/proj-old/a.ts"), null)
  assert.equal(relativeTo("/Users/x/proj", "src/a.ts"), null)
  // A degenerate root would claim every path; it claims none.
  for (const root of ["", "/", "C:\\", "C:", "  "]) assert.equal(relativeTo(root, WIN), null, JSON.stringify(root))
})

test("pathPrefixPattern matches the root at every position, and is null for a degenerate root", () => {
  const label = `Compare ${WIN} against c:/Users/x/proj/src/b.ts`
  assert.equal(label.replace(pathPrefixPattern("C:\\Users\\x\\proj")!, ""), "Compare src\\a.ts against src/b.ts")
  assert.equal(pathPrefixPattern("/"), null)
  assert.equal(pathPrefixPattern("C:\\"), null)
  assert.equal(pathPrefixPattern(""), null)
  // A root with regex metacharacters in a segment is quoted, not interpreted.
  assert.equal("/a+b/(c)/x.ts".replace(pathPrefixPattern("/a+b/(c)")!, ""), "x.ts")
})

test("abbreviateHome collapses the board's homeDir to ~ and keeps the separator that followed it", () => {
  assert.equal(abbreviateHome(WIN, "C:\\Users\\x"), "~\\proj\\src\\a.ts")
  assert.equal(abbreviateHome(WIN_FWD, "C:\\Users\\x"), "~/proj/src/a.ts")
  assert.equal(abbreviateHome(POSIX, "/Users/x"), "~/proj/src/a.ts")
  assert.equal(abbreviateHome(POSIX, "/Users/x/"), "~/proj/src/a.ts")
  assert.equal(abbreviateHome(`Compare ${POSIX} with /Users/x/b.ts`, "/Users/x"), "Compare ~/proj/src/a.ts with ~/b.ts")
  // Not home: a sibling user, another drive, no home at all.
  assert.equal(abbreviateHome("/Users/xy/a.ts", "/Users/x"), "/Users/xy/a.ts")
  assert.equal(abbreviateHome("D:\\Users\\x\\a.ts", "C:\\Users\\x"), "D:\\Users\\x\\a.ts")
  assert.equal(abbreviateHome(POSIX, undefined), POSIX)
  assert.equal(abbreviateHome(POSIX, ""), POSIX)
})

test("tildePath writes a LEADING home as ~ in the separator that followed it, and only a leading one", () => {
  assert.equal(tildePath(WIN, "C:\\Users\\x"), "~\\proj\\src\\a.ts")
  assert.equal(tildePath(WIN_FWD, "c:\\Users\\x"), "~/proj/src/a.ts")
  assert.equal(tildePath(MIXED, "C:/Users/x"), "~/proj\\src/a.ts")
  assert.equal(tildePath(POSIX, "/Users/x"), "~/proj/src/a.ts")
  assert.equal(tildePath(POSIX, "/Users/x/"), "~/proj/src/a.ts")
  // One path names one place: a home-shaped run further along it is another directory.
  assert.equal(tildePath("/Volumes/Backup/Users/x/a.ts", "/Users/x"), "/Volumes/Backup/Users/x/a.ts")
  // Not under the home: a sibling user, another drive, the home itself, no home at all.
  assert.equal(tildePath("/Users/xy/a.ts", "/Users/x"), "/Users/xy/a.ts")
  assert.equal(tildePath("D:\\Users\\x\\a.ts", "C:\\Users\\x"), "D:\\Users\\x\\a.ts")
  assert.equal(tildePath("/Users/x", "/Users/x"), "/Users/x")
  assert.equal(tildePath(POSIX, undefined), POSIX)
  assert.equal(tildePath(POSIX, ""), POSIX)
})
