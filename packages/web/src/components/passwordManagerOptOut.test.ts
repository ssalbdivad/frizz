import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const COMPONENTS = fileURLToPath(new URL(".", import.meta.url))

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) tsxFiles(full, out)
    else if (entry.name.endsWith(".tsx")) out.push(full)
  }
  return out
}

/**
 * Every JSX `<textarea>` element in `source` — self-closing or not — with its 1-based line and whether
 * it carries `data-1p-ignore`. Read off the parsed tree, not a regex over the text: the regex this
 * replaced matched `<textarea>` inside a COMMENT (TextareaCodeFences.tsx, 2026-10-01: "Code-fence
 * highlighting for any plain <textarea>") and swallowed everything up to the next `/>` as its
 * attributes, and it never saw the `<textarea>…</textarea>` form at all.
 */
function textareas(fileName: string, source: string): { line: number; optedOut: boolean }[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: { line: number; optedOut: boolean }[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(file) === "textarea") {
      const optedOut = node.attributes.properties.some((attr) => ts.isJsxAttribute(attr) && attr.name.getText(file) === "data-1p-ignore")
      found.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, optedOut })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

// 1Password's browser extension treats a bare <textarea> as a place to paste a public key and pops
// "Create SSH key" the moment the prompt box takes focus. `data-1p-ignore` is its documented opt-out,
// and it only counts when present at mount, so it rides on the element itself rather than being set
// from an effect. Every textarea here is prose for an agent, never a credential.
test("every textarea in the app opts out of 1Password's inline menu", () => {
  const missing: string[] = []
  let seen = 0
  for (const path of tsxFiles(COMPONENTS)) {
    const source = readFileSync(path, "utf8")
    // Parse only the files that can hold one: parsing all of them costs seconds for nothing.
    if (!source.includes("<textarea")) continue
    for (const { line, optedOut } of textareas(path, source)) {
      seen++
      if (!optedOut) missing.push(`${path.slice(COMPONENTS.length)}:${line}`)
    }
  }
  assert.ok(seen >= 6, `expected to find the app's textareas, found ${seen}`)
  assert.deepEqual(missing, [])
})

// The scanner itself, so a rule that can no longer see a violation cannot pass by going blind.
test("the textarea scanner sees elements in either form, and ignores comments and strings", () => {
  const source = [
    `// a comment naming a plain <textarea> is not an element`,
    `const s = "<textarea />"`,
    `export const A = () => <textarea value="" />`,
    `export const B = () => <textarea data-1p-ignore value="" />`,
    `export const C = () => <textarea value="">{"x"}</textarea>`,
    `/* <textarea data-1p-ignore /> */`,
  ].join("\n")
  assert.deepEqual(textareas("probe.tsx", source), [
    { line: 3, optedOut: false },
    { line: 4, optedOut: true },
    { line: 5, optedOut: false },
  ])
})
