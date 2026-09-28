import assert from "node:assert/strict"
import test from "node:test"
import { QueryClient } from "@tanstack/react-query"
import { localFileQueryKey } from "./localFileQuery.ts"

test("a file read through another project is cached apart from the page's read of the same path", () => {
  // Two projects' gates can answer the same path differently — one admits an out-of-home checkout, the
  // other refuses it — so neither may be served the other's answer.
  assert.notDeepEqual(localFileQueryKey("/opt/b/run.log", "project-b"), localFileQueryKey("/opt/b/run.log"))
  assert.deepEqual(localFileQueryKey("/opt/b/notes.md", "project-b"), ["localMarkdown", "/opt/b/notes.md", "project-b"])
})

test("the socket's file-changed key still invalidates a read made through another project", async () => {
  // api/socket.ts invalidates by the two-element key it knows; the project rides LAST so that key is a
  // prefix of the scoped one. Reordering the key would leave another project's reader silently stale.
  const client = new QueryClient()
  const scoped = localFileQueryKey("/opt/b/run.log", "project-b")
  client.setQueryData(scoped, { path: "/opt/b/run.log", markdown: "12:00 booted", truncated: false })
  await client.invalidateQueries({ queryKey: localFileQueryKey("/opt/b/run.log") })
  assert.equal(client.getQueryState(scoped)?.isInvalidated, true)
})
