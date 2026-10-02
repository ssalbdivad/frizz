import { test } from "node:test"
import assert from "node:assert/strict"
import { writeTarget } from "./project-scope.ts"

test("writeTarget names the one table a plain write touches", () => {
  assert.equal(writeTarget("UPDATE session SET x = 1 WHERE project_id = @project_id"), "session")
  assert.equal(writeTarget("\n  INSERT INTO tail_state (project_id) VALUES (@project_id)"), "tail_state")
  assert.equal(writeTarget("INSERT OR REPLACE INTO settings (project_id) VALUES (@project_id)"), "settings")
  assert.equal(writeTarget("REPLACE INTO thread_done (project_id) VALUES (@project_id)"), "thread_done")
  assert.equal(writeTarget("DELETE FROM codex_app_server_session WHERE project_id = @project_id"), "codex_app_server_session")
  assert.equal(writeTarget("-- why\nUPDATE OR IGNORE session SET a = 1 WHERE project_id = @project_id"), "session")
})

test("writeTarget: reads are null, and anything it cannot attribute counts against every table", () => {
  assert.equal(writeTarget("SELECT * FROM session WHERE project_id = @project_id"), null)
  assert.equal(writeTarget("WITH x AS (SELECT 1) UPDATE session SET a = 1 WHERE project_id = @project_id"), "*")
  assert.equal(writeTarget("PRAGMA user_version = 3"), "*")
})
