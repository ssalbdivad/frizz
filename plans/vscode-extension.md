# The VS Code extension (`packages/vscode`) and the editor bridge

Status: implemented 2026-10-01. The extension and Frizz talk in both directions:

- **Editor → Frizz.** Select code and either **ask Frizz** about it (a new thread, from an input box in
  the editor), **send it to a thread** (a follow-up to a thread picked from the project's list), or
  **add it to the prompt box** (a reference chip in the Frizz page's composer, for a longer prompt
  written in Frizz).
- **Frizz → editor.** A file link clicked in Frizz opens in the editor window that has the file's
  folder open, at the line the link names, and that window comes to the front. "Open in editor"
  (`e`) on a thread raises the window that already has the thread's folder open.

The extension also works in Cursor and Windsurf (they run VS Code extensions).

## Why a live connection, and why the extension dials Frizz

Frizz already opened files with `code <path>`. That spawn has three problems the bridge removes: it
carries no line, it takes seconds over WSL (a remote handshake per click), and it guesses the window.
A connected extension knows its window's folders and focus, so the server can pick the right window
and the extension can reveal a range in-process.

The extension connects OUT to the server, not the other way round (the Claude Code IDE pattern of a
per-editor server and lock file): Frizz is a singleton with a known way to find it, every editor
window is a client of it, and one machine-wide socket endpoint is far less machinery than the
server scanning lock files and dialling N editors.

## The socket: `/_frizz/editor`

- Machine-wide, answered in `index.ts`'s upgrade handler BEFORE tenant routing (a project prefix
  would only activate a tenant for nothing). `editor` is a reserved project slug.
- Same origin gate as `/_frizz/ws`: an upgrade must carry `Origin: http://127.0.0.1:<port>` matching
  its Host. The extension uses the `ws` package, which can set Origin (the WHATWG client cannot).
  Through the restart supervisor an upgrade without an Origin is destroyed with no status line.
- Text JSON frames. Shapes: `packages/shared/src/editor-protocol.ts` (plain types, which the extension
  bundles) and `EditorClientMessageSchema` in `packages/shared/src/index.ts` (zod, which the server
  validates every frame with; the two are pinned to each other at compile time).
- The first frame must be `hello` (`v: 1`). The server answers `welcome`, then `projects`.
- The server sends `{t:"hb"}` every 15s; the extension reconnects when it hears nothing for 45s. The
  server reaps a socket that misses two protocol pings.
- Limits: 64 KiB per frame (128 KiB for compose), 64 folders, 32 windows.

### What the server sends

| frame | when | extension does |
| --- | --- | --- |
| `welcome {bootId}` | after hello | logs it; a changed bootId means Frizz restarted |
| `projects {projects}` | after hello, and on any change (2s in-memory diff) | maps files to projects; status bar counts |
| `open {id, path, line?, column?, endLine?}` | a file link was clicked | opens + reveals, raises the window, answers `result` |
| `focus {id, path}` | "Open in editor" on a folder this window has open | raises the window, answers `result` |
| `composed {id, ok, error?}` | after a `compose` | reports failure; success is silent |

### Which window gets an open

`openLocalFile` (the RPC every opener click reaches) tries the bridge first when the **External app**
setting names an editor family a connected window belongs to:

- `vscode` → windows whose `appName` is VS Code; `cursor` → Cursor; `editor` → the family of
  `$VISUAL`/`$EDITOR`'s executable (`code` → VS Code, `cursor` → Cursor, `windsurf` → Windsurf).
  `system`, `finder` and `copy` never use the bridge.
- Among windows that accept opens (the extension's `frizz.openFileLinks` setting), the one whose
  workspace folder CONTAINS the file wins (longest folder first, then the most recently focused).
- No folder contains it: the most recently focused window that shares the server's filesystem
  (same `home` and `platform` in its hello) — what `code -g` would do.
- No window, a timeout (5s), or a dropped socket: the old spawn, now with the position
  (`code -g path:line:col`, `cursor -g …`; `open vscode://file…` on macOS when there is a line).
  A window that ANSWERS `ok:false` is an error the page toasts, not a reason to spawn a second opener.

`openThreadFolder` / `openProjectFolder` send `focus` to a window whose workspace folder IS that
folder (realpath-equal), else spawn as before.

### Prompt-box inserts (`compose`)

The extension sends `{t:"compose", id, item:{projectId?, path, text?, startLine?, endLine?}}`. The
server holds it (10 min, 20 items), answers `composed`, and publishes `compose-pending {id}` on EVERY
open project's bus. A page claims items with the `composeTake` RPC — when the event arrives while it
has focus, on window focus, and on boot — so the tab the human switches to is the one that inserts.

The page inserts into the composer in front: the topmost thread drawer's reply box if one is open,
else the new-thread box of `projectId`'s project (switching the view to it, as the project switcher
would). A selection becomes an `@file:12-20` context chip — the ⌘I format, so the transcript renders
it as a chip; a reference with no text becomes a plain `` `path:line` `` in the prose.

### What the page learns

- `editorWindows()` (query) and the `editors` event: the connected windows' app names and families.
  The settings drawer marks the External app option that is connected, and the first time an editor
  connects in a browser whose code files do not go to it, a toast offers to send them there (one
  click sets "Open code files: In external app" and External app to that editor).

## Positions in links

`packages/shared/src/file-position.ts` is the one grammar: `a.ts:12`, `a.ts:12:3`, `a.ts:12-20`,
`a.ts#L12`, `a.ts#L12-L20`. The page reads it off Markdown links, editor deep links
(`vscode://file/…:12:3`), inline-code paths and Codex review findings, carries it beside the path
(`data-local-line` …) and sends it to `openLocalFile` as `line`/`column`/`endLine`. The reader is
handed the bare path. The server also strips a trailing position from a path that does not exist
as written, which fixed `[x](vscode://file/repo/a.ts:12)` opening a reader that said "not found".

## The extension

Commands (editor context menu under **Frizz**, the command palette, and the explorer for files):

| command | what it does |
| --- | --- |
| Ask Frizz… | input box → new thread in the file's project, the selection (or file) as context |
| Send to Frizz thread… | pick one of the project's open threads → input box → follow-up |
| Add to Frizz prompt | the selection as a chip in the Frizz page's prompt box |
| Open Frizz | the page, focused on this workspace's project (also the status bar item) |
| Frizz: Show log | the connection log |

A new thread uses the operator's saved model and effort (`dispatchPreferencesGet`), like the page's
composer. The message is the ⌘I serialization: `@a.ts:12-20 <question>` then `Selected context:`
and the quoted selection, so the transcript shows the chip.

Finding Frizz (no configuration): the published launcher's owner record
(`<state>/frizz-server/address.json`), then the well-known ports (9393, 19393, 9494, 19494) with the
same ownership proof the desktop app uses, then `<data>/server.lock`. `frizz.serverUrl` overrides.
The extension declares `extensionKind: ["workspace"]` so in a Remote-WSL/SSH window it runs where
the files and Frizz are.

## Verification

- Unit: `file-position.test.ts`; the bridge against real `ws` clients (`editor-bridge.test.ts`);
  opener argv with positions (`local-file.test.ts`); page link parsing; the extension's discovery,
  project matching and message format (pinned to the page's `parseSentContext`).
- End to end: `packages/vscode/scripts/e2e.ts` boots a disposable Frizz (`scripts/adhoc-stack.mjs`),
  downloads a real VS Code (`@vscode/test-electron`), runs it under Xvfb with the extension, and drives
  both directions — `openLocalFile` with a line landing in the editor, and a compose landing in a real
  page's prompt box.
