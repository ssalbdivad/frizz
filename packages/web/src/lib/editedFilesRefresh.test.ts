import { test } from "node:test"
import assert from "node:assert/strict"
import { newestFileChangeKey } from "./editedFilesRefresh.ts"

const bash = (command: string, status = "done") => ({ name: "Bash", detail: command, command, status })

test("no file-changing call is no key; reads and plain shells never make one", () => {
  assert.equal(newestFileChangeKey([]), undefined)
  assert.equal(newestFileChangeKey([{ sourceId: "a", tools: [{ name: "Read", detail: "/p/a.ts" }, bash("grep -rn x src | head")] }]), undefined)
})

test("the key moves when a newer write lands, and again when that write settles", () => {
  const first = [{ sourceId: "m1", tools: [{ name: "Edit", edit: { file: "/p/a.ts" }, status: "done" }] }]
  const pending = [...first, { sourceId: "m2", tools: [bash("cat > notes.md <<'MD'\nx\nMD", "pending")] }]
  const settled = [...first, { sourceId: "m2", tools: [bash("cat > notes.md <<'MD'\nx\nMD", "done")] }]
  const later = [...settled, { sourceId: "m3", tools: [bash("npm test")] }]
  const keys = [first, pending, settled, later].map(newestFileChangeKey)
  assert.equal(new Set(keys.slice(0, 3)).size, 3)
  // A later call that changes nothing leaves the key where it was.
  assert.equal(keys[3], keys[2])
})

test("a shell removal counts, so a deleted file can leave the rail mid-turn", () => {
  for (const command of ["rm -f a.md", "cd x && rm -rf build", "git rm old.ts", "mv a b", "git checkout -- a.ts"]) {
    assert.ok(newestFileChangeKey([{ sourceId: "m", tools: [bash(command)] }]), command)
  }
  assert.equal(newestFileChangeKey([{ sourceId: "m", tools: [bash("npm run format:check")] }]), undefined)
})
