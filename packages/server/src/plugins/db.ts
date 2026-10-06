import { mkdirSync } from "node:fs"
import { join } from "node:path"
import Database from "../sqlite.ts"
import type { PluginDatabase } from "./api.ts"

// A PLUGIN'S OWN DATABASE: `<data>/plugin-data/<id>.db`, one file per plugin, on the server's own driver
// (sqlite.ts, node:sqlite under better-sqlite3's shape).
//
// Its own file rather than tables in the shared database, on purpose: plugins never touch base tables, so
// neither the server's data epoch nor its importer/purge (`STORAGE_TABLES`) ever has to know a plugin
// exists, and removing a plugin is deleting its directory and, if wanted, this one file. The schema is
// the plugin's, migrated by `PRAGMA user_version` — the count of migrations that have run — so a plugin
// ships its migrations as an append-only list and every file catches up on open, exactly once each.

export function pluginDataDir(data: string): string {
  return join(data, "plugin-data")
}

export function openPluginDatabase(file: string, migrations: readonly string[]): { db: PluginDatabase; close(): void } {
  mkdirSync(join(file, ".."), { recursive: true })
  const raw = new Database(file)
  try {
    raw.pragma("busy_timeout = 5000")
    const [row] = (raw.pragma("user_version") as { user_version: number }[] | undefined) ?? []
    const at = row?.user_version ?? 0
    for (let index = at; index < migrations.length; index++) {
      // One transaction per step, version bumped inside it: a migration that throws leaves the file at
      // the last one that ran, and the next open retries from there rather than skipping it.
      raw.transaction(() => {
        raw.exec(migrations[index]!)
        raw.exec(`PRAGMA user_version = ${index + 1}`)
      })()
    }
  } catch (error) {
    raw.close()
    throw error
  }
  const db: PluginDatabase = {
    prepare: (sql) => raw.prepare(sql),
    exec: (sql) => void raw.exec(sql),
    transaction: (fn) => raw.transaction(fn)(),
  }
  return { db, close: () => raw.close() }
}
