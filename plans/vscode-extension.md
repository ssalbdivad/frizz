# The VS Code extension (`packages/vscode`) and the editor bridge

Status: implemented 2026-10-01. The extension and Frizz talk in both directions:

- **Editor → Frizz.** Select code and either **ask Frizz** about it (a new thread, from an input box in
  the editor), **send it to a thread** (a follow-up to a thread picked from the project's list), or
  **add it to the prompt box** (a reference chip in the Frizz page's composer, for a longer prompt
  written in Frizz).
- **Frizz → editor.** A file link clicked in Frizz opens in the editor window that has the file's
  folder open, at the line the link names, and that window comes to the front. "Open in editor"
  (`e`) on a thread raises the window that already has the thread's folder open.

The extension also works in Cursor and Windsurf (they run VS Code extensions), on any base from the
manifest's VS Code 1.90 up. Raising the window is best-effort: `workbench.action.focusWindow` arrived
in 1.128, so on an older base (Cursor 3.11 is 1.125) a clicked file still opens and the answer is still
ok. A `focus` request is nothing but the raise, so there it answers that it could not, and the server
falls back to the editor's command line on the folder, which raises the window that has it open.

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
- Limits: 64 KiB per frame (128 KiB for compose), 64 folders, 32 windows. The extension fits itself to
  them rather than be refused on every redial: it reports at most 64 folders, none over 4096 characters
  and within 32 KiB encoded, and a compose whose text would pass 96 KiB once JSON-encoded (NUL-padded
  text encodes at six bytes a character) is sent as its range alone.

### What the server sends

| frame | when | extension does |
| --- | --- | --- |
| `welcome {bootId}` | after hello | logs it; a changed bootId means Frizz restarted |
| `projects {projects}` | after hello, and on any change (2s in-memory diff) | maps files to projects; status bar counts |
| `open {id, path, line?, column?, endLine?}` | a file link was clicked | opens + reveals, raises the window, answers `result` |
| `focus {id, path}` | "Open in editor" on a folder this window has open | raises the window, answers `result` (not ok where it cannot raise itself) |
| `composed {id, ok, error?}` | after a `compose` | says it was added (with an "Open Frizz" button), or why not |

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
  (`code -g path:line:col`, `cursor -g …`; on macOS the app bundle's own CLI,
  `<App>.app/Contents/Resources/app/bin/code -g …`, and `open -a <App>` without the line when that is
  missing — never `open vscode://file…`, which VS Code answers with a confirmation dialog by default).
  A window that ANSWERS `ok:false` is an error the page toasts, not a reason to spawn a second opener.

`openThreadFolder` / `openProjectFolder` send `focus` to a window whose workspace folder IS that
folder (realpath-equal), else — or when that window cannot raise itself — spawn as before.

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
| Add to Frizz prompt (`Ctrl+Alt+P`, `⌘⌥P`) | the selection as a chip in the Frizz page's prompt box |
| Open Frizz | the page, focused on this workspace's project (also the status bar item) |
| Frizz: Show log | the connection log |

A new thread uses the operator's saved model and effort (`dispatchPreferencesGet`), like the page's
composer. The message is the ⌘I serialization: `@a.ts:12-20 <question>` then `Selected context:`
and the quoted selection, so the transcript shows the chip.

Finding Frizz (no configuration): the published launcher's address record
(`<state>/frizz-server/address.json`), trusted only as the desktop app trusts it — the owner record
beside it must name the same token, pid and process start, and that process generation must be alive
(`readStableServerOwner`, replicated in `discovery.ts` with async spawns and no writes, and tested
against the real one) — then the well-known ports (9393, 19393, 9494, 19494) with the same ownership
proof the desktop app uses, then frizz-dev's public port (`<data>/projects/<id>/dev-supervisor.lock`),
and last the port in `<data>/server.lock`. Behind the restart supervisor that last one is the control
plane's private port: RPC and the editor socket work there, but a page opened on it is a different
origin, with its own tab state, that dies on the next restart. Without a supervisor it IS the public
port. The steps before it win whenever a supervisor is up, so it is reached only in narrow windows, and
pages are still opened on it; the log says which kind of address each page was opened on.
`frizz.serverUrl` overrides.

A command that needs the connection and has none says the connection's own reason (a Frizz that refused
the socket is told to update, not reported as stopped), and Open Frizz opens the discovered address even
then. A dispatch or follow-up that got no answer (a timeout, a connection dropped mid-request) says to
check Frizz before asking again, since it may have started the thread.
The extension declares `extensionKind: ["workspace"]` so in a Remote-WSL/SSH window it runs where
the files and Frizz are.

## Verification

- Unit: `file-position.test.ts`; the bridge against real `ws` clients (`editor-bridge.test.ts`);
  opener argv with positions (`local-file.test.ts`); page link parsing; the extension's discovery
  (its address-record verdict run beside `readStableServerOwner` over files the server's own writer
  wrote), project matching, message format (pinned to the page's `parseSentContext`) and compose size;
  its connection against an in-process server that judges every frame with the server's own
  `EditorClientMessageSchema` and frame ceilings. `nub --test packages/vscode/src/*.test.ts`.
- End to end, `packages/vscode/scripts/e2e.ts` downloads a real VS Code (`@vscode/test-electron`) and
  runs it under Xvfb with the extension, never on the real display:
  - `nub packages/vscode/scripts/e2e.ts` — FAKE mode, against an in-process fake Frizz (which also
    judges frames with the server's schema): opens at a line and a range, focus answering whether the
    window came to the front, a folder answering ok, the status bar's count, Ask, Send to thread (and its refusal of an untitled selection), Add to
    Frizz prompt, the open-links setting, and a dropped connection coming back.
  - `FRIZZ_E2E_VSCODE=oldest nub packages/vscode/scripts/e2e.ts` — the same on the oldest VS Code the
    manifest's `engines.vscode` admits (1.90.0), where `focusWindow` does not exist.
  - `nub packages/vscode/scripts/e2e.ts --stack` — boots a disposable two-project Frizz itself
    (`scripts/adhoc-stack.mjs`: sandbox HOME, a free port, two throwaway git repos) and runs REAL mode
    against the TENANT project: `openLocalFile` with a line landing in the editor over the bridge, the
    window listed in `editorWindows`, and "Add to Frizz prompt" landing as a chip in the new-thread box
    of a headless page open on the tenant (`e2e/page-claim.ts`). Every opener the server could spawn
    (`code`, `cursor`, `xdg-open` …) is a stub on its PATH, and the run fails if one was spawned. The
    stack is stopped by its process group and anything still carrying its HOME is killed, pass or fail.
    Ask and Send start real agents, so they run only with `FRIZZ_E2E_DISPATCH=1` (which adds `--creds`).
