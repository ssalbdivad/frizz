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
| `welcome {bootId, features?}` | after hello | logs it; a changed bootId means Frizz restarted; `features` names what this Frizz takes beyond v1 (`editor-state`) |
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
  The settings drawer marks the External app option that is connected.
- Where a code-file click goes. A browser that has not chosen in "Open code files" sends it to the
  External app while that app is an editor with a window connected that takes opens, and to the reader
  otherwise; never from the phone layout or a remote session (`codeFilesDestination`,
  `lib/editorWindows.ts`). A choice in Settings is final either way. Until 2026-10-01 only the offer
  below switched a browser over, and a human who missed its 12s toast got the reader with VS Code
  connected.
- The first time an editor connects in a browser whose code files do not go to it — External app is
  something else, or the browser chose the reader — a toast offers to send them there (one click sets
  "Open code files: In external app" and External app to that editor).

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

## The sidebar

A Frizz icon in the activity bar opens a view that IS the Frizz page: one iframe of the discovered origin
with `?embed=vscode&theme=<light|dark>&project=<this window's project slug>`. The queue, threads, question
cards, approvals, handoffs and the reply box are the app's own, live over its own socket, so the sidebar
is in sync with every other Frizz surface by construction and nothing in it is drawn twice.

Why the real page and not a rebuild, a tree or a chat participant (measured 2026-10-01, in real VS Code
1.90 and 1.140 under Xvfb, against a disposable Frizz):

- Framing works. The server sends no `X-Frame-Options` or `frame-ancestors`; the frame's RPC (writes
  included) and both sockets pass the origin gate, because the frame's own requests are same-origin to
  Frizz; a card archived elsewhere left the sidebar in about half a second; the queue and a thread read
  cleanly at 297px.
- A native rebuild is a second renderer for the question tree, typed approvals that must fail closed,
  delivery states and chips. It would drift, and a drifted approval button is a safety bug.
- A TreeView cannot hold a card, markdown or a composer.
- A chat participant (`@frizz`) cannot reach Cursor, which registers no `chatParticipants` extension
  point, and is request/response only: a worker cannot put a question in front of the human there.

The wire between the extension and the page is `packages/shared/src/embed-protocol.ts`, relayed by the
webview document: host → page `frizz:theme`, `frizz:compose`, `frizz:navigate`; page → host
`frizz:ready`, `frizz:composed`, `frizz:open-file`, `frizz:open-external`, `frizz:key`. It never goes
through the server.

What embedding needed, each found by the spike:

- **Embed mode in the page** (`lib/embed.ts`). The narrow layout at any width, so a widened sidebar does
  not flip to the desktop page. A code-file link opens in the window that holds the sidebar
  (`frizz:open-file`), whatever External app says: the phone layout's "the desk is not here" gate is
  false in an editor, and so is the server's choice of window. The theme is VS Code's, for the session, never persisted (the frame's
  storage is partitioned from the browser's anyway). Web links go out through `env.openExternal`, since
  a webview cannot open a window. Browser notifications, which a frame cannot raise, are not attempted.
- **Selections reach the sidebar directly.** A held item is claimed by whichever page has FOCUS, and a
  sidebar does not have it while the human works in the editor: the item waited, a browser tab could take
  it, and the click that finally claimed it interleaved the chip with what was being typed. So once the
  sidebar has been opened in a window (and its page said `frizz:ready`), "Add to Frizz prompt" posts the
  chip into it and reveals it, keeping focus in the editor; "Ask Frizz…" opens its new-thread box with
  the chip and the caret, and "Send to Frizz thread…" opens the picked thread with the chip in its reply
  box — a real multi-line composer instead of a one-line input box. A window that never opened the
  sidebar keeps the browser path.
- **Keys.** While the frame has focus no VS Code keybinding sees a key, and an untrusted re-dispatch is
  dropped by the workbench. The page forwards the Ctrl/Cmd chords it does not handle; the extension runs
  the command an allowlist maps each to.
- **Addressing.** The frame loads the plain discovered origin. Every Frizz gate requires the request's
  port to be Frizz's own, so a remapped port would refuse every request; the view says so instead of
  showing a broken page. Under Remote-WSL the frame loads from the Windows side, where WSL's localhost
  forwarding reaches the same port.
- `retainContextWhenHidden`, so hiding the view is not a cold boot of the app, its socket and its drafts.

The view's badge is the Ready count the status bar shows, and the status bar item reveals the sidebar.

### The editor in the sidebar, and the app's own feel

The maintainer, after using the first cut in a Remote-WSL window (2026-10-01): the sidebar must show what
the editor has open and what is highlighted, with a visual indicator; a Cursor-style shortcut must drop
the highlighted code into the current prompt as a pill; everything else — the UI, text sizes, shortcuts —
must match the core app, with a hint wherever the sidebar differs; and no Frizz header.

- **The context bar.** Along the top of the thread's reply box and the new-thread box, inside the box (where
  Cursor and Copilot put their context pills), a quiet strip names the file in front and its selection
  (`r2-private.ts:91-116`, `26 lines`), live from `frizz:editor-context`: a selection lights up in the
  accent, a file alone is an outline. A click adds it as a chip (`frizz:add-context` → `frizz:compose`)
  in THAT box — the page remembers which box asked, since the host answers "front" — and the split
  control's chevron lists the other open files. With nothing selected it spells out ⌘L / Ctrl+L. It
  shows paths and line numbers only; the text crosses when the human adds it. Nothing is attached
  implicitly — a chip in the box is the only way context rides a message, as in the browser.
  (components/EditorContextBar.tsx, lib/editorContext.ts.)
- **The chords people already know, in the editor** (maintainer 2026-10-02: *"there is a standard
  shortcut for adding a pill for highlighted snippet to a message … look at cursor, claude code vscode
  extension and take the best parts of each"*). Each adds a chip to the sidebar's front prompt box and
  puts the caret after it:
  - **⌘L / Ctrl+L**, Cursor's "add selection to chat" — the one the page names (the context bar's hint,
    the `?` sheet's Editor group first). Only with a selection, so VS Code's own Ctrl+L (select the line)
    works without one; a second Ctrl+L to grow a line selection is the price.
  - **⌘I / Ctrl+I**, the core app's own chord for staging a selection (FileViewerPanel's ⌘I). It replaced
    the first cut's Ctrl+Alt+P, and also fires only with a selection, so VS Code's Ctrl+I (suggest,
    inline chat) is untouched everywhere else.
  - **⌥K / Alt+K**, Claude Code's @-mention: the selection, or with only a caret the whole file
    (`frizz.addSelectionOrFile`, which is Add to Frizz prompt or Add file to Frizz prompt). Bound with or
    without a selection, as Claude Code binds it.

  ⌘L is listed after ⌘I in the manifest on purpose: VS Code shows a command's LAST contributed binding in
  its menus and the palette. In Cursor, which binds ⌘L and ⌘I to its own chat and agent, the two compete;
  the README says to rebind. Pressed in the sidebar's prompt box, ⌘L and ⌘I do the same as from the
  editor (into that box; ⌘L with a thread open and the caret elsewhere, into its reply box), so the chord
  the hint names works on both sides of the frame.
- **More ways in:** an editor tab's context menu and the explorer add a whole file; a problem's quick
  fix, "Ask Frizz to fix", adds its lines with the message after the chip (`note`); the terminal's
  context menu adds its selection as `@terminal`.
- **The page is the desktop app, narrowed — not the phone app.** The phone layout gave the sidebar its
  one-column structure, and with it touch-only variants the browser app never shows (the answer sheet in
  place of inline question cards, a floating button, no keyboard). In the sidebar those take the
  desktop's variant: inline cards, the desktop type scale, every shortcut the `?` sheet lists. Where the
  sidebar must differ — a chord VS Code keeps, a setting that cannot apply in a frame — the page says so
  where it happens.
- **No Frizz header.** VS Code's title row carries the header's doors as buttons (`frizz:command`), shown
  by the page's view (`frizz:route` → a context key), and the badge's tooltip carries the counts. Not the
  view's `title`/`description`: a single-view container's row reads "Frizz: <title>" re-cased by VS Code
  ("Frizz: Tidy-The-Sample-Loop" on 1.140, all caps on 1.90) and drops the description (measured in real
  VS Code, scripts/e2e-sidebar.ts), so names stay in the page. The keyboard shortcuts sheet is under the
  row's ⋯ (`shortcuts`): the page's status row drops its ⌨ in the sidebar, and is not drawn at all when
  nothing else is in it (no supervisor to restart, no quota) — the ⌨ alone on a 36px row above the prompt
  box read as debris (scripts/e2e-sidebar.ts, 2026-10-01).
  The count is the desktop's READY count — every card, a question included — so a tab and the sidebar
  never disagree (`7 ready · 2 working`); a file's reader over a thread names the file and keeps Back. The
  route also carries the page's own address (`href`, kept only on the frame's origin), so ⋯ Open in
  browser opens what the sidebar shows — a thread as that thread — rather than the window's project.
- **The column, scroll box and all.** The prompt box stays put and the list scrolls in its own box under it,
  with the app's 7px inner scrollbar and the desktop's column-head spacing; a project dragged to the edge
  scrolls it; the project cords are drawn. An empty view says the desktop's own sentence under the list.
- **The thread keys with no drawer open.** In the sidebar the drawer is the card, so `r`, `d`, `s` … with
  none open first OPEN the thread you're on (the row the marker holds, else the first queued one) and stop
  there; `r` also puts the caret in its reply box. Nothing acts on a thread the human has not seen. `j`/`k`
  step every queued row, pinned ones included, as the desktop's cards do. `e` with nothing queued shows the
  project's folder in VS Code; a folder outside the window's folders opens in a window of its own.

### What the sidebar keeps apart

The frame's storage is PARTITIONED from the browser's: the same origin framed inside a `vscode-webview://`
document gets its own localStorage, so everything Frizz keeps per browser starts at its defaults in the
sidebar and stays there — the project folds, the open quiet bands, the prompt box's pick, the density, the
queue's order, the keybindings and the snooze preset. That is by design rather than a gap: each is the
state of ONE browser (lib/crossProject.ts says "per browser"), and the frame is another browser. The `?`
sheet says it for the keys, where it surprises ("Changes here stay in the sidebar"); sessionStorage lives
only as long as the webview does.

Code-file links in the sidebar open in VS Code even for a file OUTSIDE Frizz's trusted roots, on purpose.
The roots gate the server's own opener, because that launches an application with the path (an editor, a
shell's default handler); a VS Code tab is inert, the extension opens it in the window that holds the
sidebar, and the human clicked the link.

## What the agents can read: `mcp__frizz__editor`

The maintainer, after asking an agent in the sidebar "can you see the highlighted code in vscode?" and
being told no (2026-10-02): *"the only reason this is useful is if it has full context on the editor"*.
Until then a selection reached a worker only as a chip the human added. Claude Code's IDE integration
gives its agent the editor through MCP tools it calls on demand (getCurrentSelection, getOpenEditors,
getDiagnostics); Frizz now does the same for every worker, Claude, Codex and ACP alike, through the
socket it already had.

- **The frame.** Each window sends `editor` (`EditorSnapshot`, editor-protocol.ts): the text editor in
  front — path (an untitled buffer's label), language, unsaved, line count, caret, the lines on screen,
  the primary selection with its text — the other tabs most recent first, the errors and warnings, and
  the full problem counts. Only `file` and `untitled` documents: never an output pane, a git revision or
  a settings UI. Focus in an output pane or the debug console makes that the active text editor in VS
  Code, so the last file editor still on screen stands in rather than blank the selection.
- **When.** Debounced 250ms after any change of the active editor, selection, visible range, tabs, a
  document's text or dirty state, or the diagnostics; at once when the setting changes; and once on
  every connect. An unchanged picture is not resent (packages/vscode editor-state-feed.ts).
- **Version skew.** The server closes a socket on any frame it does not know (4401), on every redial,
  so the protocol stays v1 and grows by advertisement: the welcome names `features: ["editor-state"]`
  and the extension sends the frame only to a Frizz that named it. An older Frizz never hears it, and the
  log says its agents cannot read the editor.
- **Fitting.** Capped to the server's schema — 50 tabs, 100 diagnostics (every error before any warning,
  the file in front first within each, so 200 lint warnings cannot push out an error elsewhere), messages
  at 300 characters, selected text at 32 Ki characters flagged `truncated` — and the whole frame fitted
  into 56 KiB encoded (`EDITOR_STATE_MAX_BYTES`, under the 64 KiB frame ceiling) by trimming the
  diagnostics, then the tabs, then the selected text, by ENCODED size (packages/vscode editor-state.ts).
- **The opt-out.** `frizz.shareEditorState` (default on). Off, the window sends `shared: false` with
  nothing else, and the server forgets what it had: a worker is told the human turned it off, which is a
  different next move from "no editor".
- **The server** keeps each window's latest frame with its arrival time and drops it with the window.
  `editorState` (project-prefixed, a mutation only because the worker's MCP server POSTs everything)
  answers the windows that have the project open — a workspace folder that holds `workDirOf(project)`,
  one inside it (a package, a thread's worktree opened with "Open in editor"), or a loose window whose
  file in front is under it — most recently focused first, with how many windows are connected and what
  the others have open.
- **The tool.** `editor` (cc-worker/bin/frizz-mcp.mjs, `readOnlyHint`, no arguments: the window is the
  one on the caller's project) renders the window used last as text: the file, the selected lines and
  text in a fence, the caret and screen, the tabs, the problems grouped by file. Every way of having
  nothing to read says why — no editor, none on this project, an extension too old to report, sharing
  off, a Frizz too old for the procedure ("restart Frizz to enable this") — and ends on asking the human
  to paste it. Its description names the words humans use ("this", "the selected code", "the error"),
  and the worker contract names the tool in one sentence, since a worker's MCP tools are deferred.

Nothing is attached to a message implicitly: the chip is still the only context that rides one. The
agent READS the editor when it decides to, which is the Claude Code model rather than Cursor's
always-attached context.

## Verification

- Unit: `file-position.test.ts`; the bridge against real `ws` clients (`editor-bridge.test.ts`);
  opener argv with positions (`local-file.test.ts`); page link parsing; the extension's discovery
  (its address-record verdict run beside `readStableServerOwner` over files the server's own writer
  wrote), project matching, message format (pinned to the page's `parseSentContext`) and compose size;
  its connection against an in-process server that judges every frame with the server's own
  `EditorClientMessageSchema` and frame ceilings; the sidebar's relay, CSP and routing (`embed.test.ts`,
  `sidebar-html.test.ts`); the editor's context for the sidebar — the column-1 line rule, the selection's
  characters, labels, open-file order, dedupe and cap, the fix note and titles, a terminal selection's
  bounds (`editor-context.test.ts`); the agents' picture of the editor — caps, order, the line rule, the
  fitting by encoded size with every result judged by the server's schema (`editor-state.test.ts`), the
  frame sent only to a Frizz that advertises it, resent on reconnect, never refused
  (`connection.test.ts`), the bridge keeping and answering it across windows (`editor-bridge.test.ts`),
  and the real `frizz-mcp.mjs` rendering it (`frizz-mcp.test.ts`); and what the `.vsix` carries — every file the manifest names admitted
  by `.vscodeignore`, the activity-bar mark's pen at 1/16 of its box (`package-contents.test.ts`).
  `nub --test packages/vscode/src/*.test.ts`.
- End to end, `packages/vscode/scripts/e2e.ts` downloads a real VS Code (`@vscode/test-electron`) and
  runs it under Xvfb with the extension, never on the real display:
  - `nub packages/vscode/scripts/e2e.ts` — FAKE mode, against an in-process fake Frizz (which also
    judges frames with the server's schema): opens at a line and a range, focus answering whether the
    window came to the front, a folder answering ok, the status bar's count, Ask, Send to thread (and its refusal of an untitled selection), Add to
    Frizz prompt, the open-links setting, and a dropped connection coming back. Then the sidebar,
    framing the fake's own page, which speaks the embed contract: Add opening it in a window that never
    had it, the embed params on the frame, the badge, Add (target front, focus true), Ask (new) and Send
    (the thread) landing in the page instead of the server, a file the page links opening at its
    position, a forwarded chord running its command, unknown messages doing nothing, a theme change, the
    fallbacks (a silent page, the setting off), and a re-frame when Frizz moves to another port. Then the
    editor in the sidebar: the `frizz:editor-context` payload (lines with the column-1 rule, characters
    across selections, the other open files once each and most recent first, null for an untitled
    buffer and a diff, no text anywhere), a drag as one message and an unchanged context as none, a
    reloaded page told at once; `frizz:add-context` for the selection and a whole file, and nothing when
    either is gone; Ctrl+L and Ctrl+I PRESSED with a selection landing a chip with the caret and pressed
    with a caret landing nothing (Ctrl+L selecting the line instead), Alt+K landing the selection and,
    with a caret, the whole file (trusted keys through the workbench's debugging port, `e2e/cdp.ts`); the quick fix
    offered for a diagnostic with its lines and `note`, two problems told apart, none with the setting
    off; a tab's and the explorer's files; a terminal selection as `@terminal` with the clipboard
    restored; `frizz:route` as the buttons the title row really shows and the badge's tooltip, with
    the row still reading Frizz; and every title-row command (Keyboard shortcuts in the ⋯), and a real click on one, reaching the page as `frizz:command`.
    And the agents' picture: a selection, a tab and a problem from a real diagnostic collection reaching
    Frizz as the `editor` frame, an edit marking it dirty, and sharing off sending nothing else.
    `FRIZZ_E2E_ONLY=<part of a step's name>` runs just those steps.
  - `FRIZZ_E2E_VSCODE=oldest nub packages/vscode/scripts/e2e.ts` — the same on the oldest VS Code the
    manifest's `engines.vscode` admits (1.90.0), where `focusWindow` does not exist.
  - `nub packages/vscode/scripts/e2e.ts --stack` — boots a disposable two-project Frizz itself
    (`scripts/adhoc-stack.mjs`: sandbox HOME, a free port, two throwaway git repos) and runs REAL mode
    against the TENANT project: `openLocalFile` with a line landing in the editor over the bridge, the
    window listed in `editorWindows`, and "Add to Frizz prompt" landing as a chip in the new-thread box
    of a headless page open on the tenant (`e2e/page-claim.ts`), and a worker's `editor` tool — the real
    `frizz-mcp.mjs`, stamped with the tenant's id — reading the window's selection and problem through the
    real server. Every opener the server could spawn
    (`code`, `cursor`, `xdg-open` …) is a stub on its PATH, and the run fails if one was spawned. The
    stack is stopped by its process group and anything still carrying its HOME is killed, pass or fail.
    Ask and Send start real agents, so they run only with `FRIZZ_E2E_DISPATCH=1` (which adds `--creds`).
