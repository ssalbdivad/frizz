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
| `welcome {bootId, features?}` | after hello | logs it; a changed bootId means Frizz restarted; `features` names what this Frizz takes beyond v1 (`editor-state`, `sidebar`, `attention`) |
| `projects {projects}` | after hello, and on any change (2s in-memory diff) | maps files to projects; status bar counts |
| `open {id, path, line?, column?, endLine?}` | a file link was clicked | opens + reveals, raises the window, answers `result` |
| `focus {id, path}` | "Open in editor" on a folder this window has open | raises the window, answers `result` (not ok where it cannot raise itself) |
| `composed {id, ok, error?}` | after a `compose` | says it was added (with an "Open Frizz" button), or why not |
| `review {id, title, checkouts}` | a browser tab's Review changes, to a window that said it can | opens the multi-file diff, raises the window, answers `result` |
| `attention {projectId, thread, needs, body?}` | a thread came to rest needing the human, to ONE listening window (below) | a VS Code notification while the sidebar is out of sight |

### Which window is told a thread needs you

The page's own notifications cannot fire inside an editor (a framed page is refused the permission), so
without this a question asked while the human was in their code waited for them to glance at the badge.
The server takes the board's needs-you edge (`board.ts notifyNeedsYou`, the one the page's notification
rides) and sends `attention` to one window: of those that sent `listen {attention: true}` — a window
whose `frizz.notify` is on, from an extension that knows the frame (it is gated on the welcome's
`attention` feature, since an unknown client frame closes the socket) — and have the thread's project
open, the one focused most recently. An old extension or a window with notifications off can then never
swallow the one notification. The edge is published inside the board's assembly, before its snapshot is
kept, so the bridge reads the thread one task later. The bus is subscribed only while some window listens.

The extension says nothing while the sidebar is in sight (the card is in front of the human already), and
paces a burst (`attention.ts AttentionGate`): one toast at most every 20s, the rest held and said
together ("3 threads need you: …"), and the same thread again within 2m not said twice. The words are the
board's: the thread's handle, what it needs ("has a question", "needs your approval", "is ready for you")
and the line the page's notification would show. **Open** reveals the sidebar on the thread (the queue,
for several), or with the sidebar off, opens it in the browser.

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

### The editor beside a browser tab

In the sidebar the bar reads the editor live and every send carries it. A human talking to a thread from a
BROWSER TAB beside VS Code had neither: the agent learned what was selected only if it called its tool,
and the human could not see whether there was anything for it to read. So the tab's thread reply box and
new-thread box end their footer with one quiet line — `VS Code: a.ts:12-20`, or the file alone with only a
caret — naming exactly what `mcp__frizz__editor` would read: `editorFront` answers from the window
`editorState` ranks first for the project, the file and the selection's LINES, never the text, and nothing
while that window does not share. Its tooltip says agents can read it with their editor tool; a click asks
again with `text: true` and adds the chip an editor's own "Add to Frizz prompt" would (a truncated or
withheld selection as its lines alone, an untitled buffer not at all). It sends nothing on its own: a tab is
not where the human points at code, and context sent from a surface that cannot show the switch is context
they cannot stop. Live from `editor-front`, a payload-free machine-wide ping the bridge publishes after a
100ms burst when some window's folders or front changed; the page asks only while a window is connected,
never in the sidebar or on a phone. In the footer, not along the top: here it is a side note, and costs the
box no height. (server editor-bridge.ts front/frontItem; web components/EditorLine.tsx, lib/editorFront.ts.)

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
(`<state>/frizz-server/address.json`), trusted only as the launcher trusts it — the owner record
beside it must name the same token, pid and process start, and that process generation must be alive
(`readStableServerOwner`, replicated in `discovery.ts` with async spawns and no writes, and tested
against the real one) — then the well-known ports (9393, 19393, 9494, 19494) with the launch-token ownership
proof, then frizz-dev's public port (`<data>/projects/<id>/dev-supervisor.lock`),
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

### Which build a window runs

Every build said `0.1.0`, so "is this window running the fix?" had no answer. `scripts/build.ts` stamps
the bundle (esbuild `define`) and `dist/build.json` (shipped in the `.vsix`) with the version, the short
commit, whether `packages/vscode` or `packages/shared` had uncommitted changes, the build time and a
random id. The label (`0.1.0+1a2b3c4d`, `-dirty` when it was) goes in the hello's `extensionVersion`
(which the server now keeps, and Settings' editor hint lists), the log's first line and the status
bar's tooltip. A window keeps running the code it loaded, so every 4s it compares the build on disk
with its own (`build-info.ts installedBuild`: the same version reinstalled in place is a new id in its own
folder; a new version is a sibling folder the old one's `.obsolete` entry points away from) and offers
**Reload window**, once per build.

A Frizz from before the sidebar frames a page that never says it is ready. Its welcome names neither
`sidebar` nor `editor-state` (which came after the embed mode), or its editor socket answers 404 (before
the bridge), so the sidebar says the real cause from the first paint — "This Frizz is older than the
sidebar. Update Frizz to use it here, or open it in your browser." — instead of "still loading" 20s later.

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
webview document: host → page `frizz:theme`, `frizz:compose`, `frizz:navigate`, `frizz:editor-context`,
`frizz:command`, `frizz:host-state`; page → host `frizz:ready`, `frizz:composed`, `frizz:open-file`,
`frizz:open-external`, `frizz:key`, `frizz:add-context`, `frizz:route`, `frizz:share-editor`. It never goes
through the server.

What embedding needed, each found by the spike:

- **Embed mode in the page** (`lib/embed.ts`). The narrow layout at any width, so a widened sidebar does
  not flip to the desktop page. A code-file link opens in the window that holds the sidebar
  (`frizz:open-file`), whatever External app says: the phone layout's "the desk is not here" gate is
  false in an editor, and so is the server's choice of window. The theme is VS Code's, for the session, never persisted (the frame's
  storage is partitioned from the browser's anyway) — its kind AND its colours (`frizz.matchEditorTheme`, on
  by default; 2026-10-02, after a blue-black theme's #080d17 side bar framed Frizz's #0d0e10 as a foreign
  panel). VS Code's API names only the kind, so the RELAY reads the colours off the `--vscode-*` properties
  VS Code writes on its webview document, adds them to every `frizz:theme`, re-posts on a theme switch (a
  MutationObserver), and puts the first on the frame's address as a fragment for the first paint; the page
  takes an allowlisted set of plain colour values and theme.css § The editor's colours maps them onto its
  tokens (surfaces derived from the theme's background, status colours kept). Web links go out through `env.openExternal`, since
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
  control's chevron lists the other open files. (components/EditorContextBar.tsx, lib/editorContext.ts.)
- **What the bar shows goes with the message.** Every send from a box with a bar carries an "Editor
  context (attached automatically … it may or may not be related)" block after the human's words: the
  selection, quoted up to 16 Ki characters, or with nothing selected the file and the caret's line — as
  Claude Code's extension and Cursor do (David 2026-10-02: *"the only reason this is useful is if it
  has full context on the editor"*). A chip is still how the human points at code mid-sentence; the block
  is what happened to be in front, and its header says so. The reading says what the agent can and cannot
  do with it: `(unsaved changes)` quotes the buffer, not the disk; past the ceiling an unsaved buffer says
  the copy on disk differs, an untitled one that there is no file to read, and a file that may hold
  secrets that it was not quoted for that reason. A selection the thread's last block already quoted —
  same lines, same text — is named, not quoted again ("Still selected in src/a.ts, lines 12-20 (quoted in
  an earlier message)"; `previousEditorQuote` reads the thread's transcript). A lazy thread carries no
  block, at saving or at launch: baked into its note it would be read hours later as the moment of launch,
  and at launch it would describe whatever the editor shows then, from a box with no bar to see or stop
  it; the agent reads the editor through its tool if the note means it. (lib/composerContext.ts
  serializeEditorContext, lib/editorContext.ts outgoingMessage; the transcript draws the block as a chip
  under the bubble, components/SentEditorContext.tsx.)
- **One switch, the eye.** The eye before the reading is `frizz.shareEditorState`, the extension's setting:
  on, sends carry the block and the agents can read the editor (below); off, neither — only what the human
  adds as a chip, and the page feed carries no selection text at all. The page shows it from
  `frizz:host-state` and flips it with `frizz:share-editor`; the extension writes it where it takes effect
  (the workspace's value when one is set, else the user's). Until 2026-10-02 the eye was the frame's own
  pref and governed the block alone, so with the eye off an agent could still read the selection through
  its tool. Being a VS Code setting, it holds across window reloads and in every window.
- **Leaving one out.** Claude Code's extension lets the human drop the selection in front from the next
  message without turning the feature off; the eye cannot be that, since it is a VS Code setting that holds
  in every window and also shuts the agents' tool out. So pointing at the bar's reading turns its file glyph
  into a × (Cursor's context pills do the same), and a click leaves THIS selection — or with nothing
  selected this file — out of every sidebar send until the editor shows something else. The key is the
  file, lines and size (the file alone with no selection, so caret moves keep it out); the leave-out is
  dropped, not shadowed, when the selection changes, so the same lines selected again later go. Left out,
  the reading wears the eye-off state (struck, dimmed), the hint says what brings it back, and the glyph
  offers the undo arrow. The page's alone: the agents' tool still reads the editor, because the eye is
  on and the human can see that it is. A hover affordance rather than a fourth control on the strip: at
  300px the hint already gets ~110px. (lib/editorContext.ts leaveOut, sentEditorFront.)
- **The hint** beside the reading says what goes on its own and what the chord is still for — "Selections
  go with your message · Ctrl+L puts one at the caret", "Goes with your message" over a selection, "Lines
  only: the file may hold secrets", "Not shared" with the eye off — the longest that fits. It said "Select
  code and press Ctrl+L" until the block made that step unnecessary for a plain question.
- **The chords people already know, in the editor** (David 2026-10-02: *"there is a standard
  shortcut for adding a pill for highlighted snippet to a message … look at cursor, claude code vscode
  extension and take the best parts of each"*). Each adds a chip to the sidebar's front prompt box and
  puts the caret after it:
  - **⌘L / Ctrl+L**, Cursor's chord, both halves of it — the one the page names (the context bar's hint,
    the `?` sheet's Editor group first). With a selection: add it as a chip at the prompt box's caret.
    With NOTHING selected: reveal the sidebar and put the caret at the end of the prompt box in front
    (`frizz.focusPrompt` → `frizz:command` `prompt`). Pressed in the sidebar: back to the editor (the page
    forwards it like VS Code's own chords; the extension's allowlist runs focusActiveEditorGroup). The
    trade: VS Code's own Ctrl+L (expand line selection) is Frizz's in the editor, with a selection or
    without, while `frizz.useSidebar` is on — the no-selection binding is gated on it, so with the sidebar
    off Ctrl+L selects the line again. Shift+↓ grows a selection by lines. Until 2026-10-02 ⌘L pressed in
    the page added the editor's selection again (⌘I does that there), which left no chord back out.
  - **⌘I / Ctrl+I**, the core app's own chord for staging a selection (FileViewerPanel's ⌘I). It replaced
    the first cut's Ctrl+Alt+P, and also fires only with a selection, so VS Code's Ctrl+I (suggest,
    inline chat) is untouched everywhere else. Pressed in a sidebar prompt box it adds the editor's
    selection (or its file) to that box.
  - **⌥K / Alt+K**, Claude Code's @-mention: the selection, or with only a caret the whole file
    (`frizz.addSelectionOrFile`, which is Add to Frizz prompt or Add file to Frizz prompt). Bound with or
    without a selection, as Claude Code binds it — and ONLY while Claude Code's own extension
    (`anthropic.claude-code`) is not installed: it binds Alt+K with the same `when`, so with both, which
    one answered depended on load order (the maintainer's machine has it). The extension sets
    `frizz.claudeCodeInstalled` at activation and on every extensions change and the binding is gated on
    it; `frizz:host-state` `altK` tells the page, and the `?` sheet drops the row. Claude Code's
    Ctrl+Escape and Ctrl+Shift+Escape are not bound here.

  ⌘L is listed after ⌘I in the manifest on purpose: VS Code shows a command's LAST contributed binding in
  its menus and the palette. In Cursor, which binds ⌘L and ⌘I to its own chat and agent, the two compete;
  the README says to rebind.
- **The chord where the eye is: the selection hint** (2026-10-02, Cursor's "⌘L to chat"). A fresh selection
  shows `Ctrl+L to add to Frizz` (`⌘L` where the window's UI is a Mac — under a remote window that is not
  the extension host's platform, so the sidebar's relay says it) past the end of the selection's line
  nearest the caret, styled as VS Code's own inline blame (the git extension: `editorInlayHint.foreground`,
  50px from the code) — the editor's kind of note, not `editorGhostText`, which is an inline completion's
  and reads as a suggestion Tab would take. A
  decoration (`after.contentText`), so nothing takes focus or covers code (selection-hint.ts). It settles
  250ms after the last change and clears at once on any change, so a drag shows nothing until the hand
  stops. Not shown: in a diff (the group's tab must be a plain text tab of the file — the review diff is
  where an agent's change is read, and ghost text there reads as part of it); for a select-all (a step
  toward copy or replace, and the caret is on the file's last line, off screen); on a selection an
  extension or a jump set (VS Code reports `api`, `code.jump` and `code.navigation` as kind Command —
  Frizz's own links select lines); on one just added; while not connected; in Cursor and Windsurf, which
  draw their own hint for the same chord. `frizz.selectionHint` turns it off. Placement follows the chip's
  line count (lineSpan): a whole-line drag ending at column 1 puts it after the last line the chip reads.
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

### More ways in: `@` files, explorer drops, problems and the last command

What Cursor and Claude Code's extension taught the human to expect of a prompt box beside their code,
each answered by the extension, since the page has no index of the workspace, no diagnostics and no
terminal — and none of it goes through the server:

- **`@` files.** A prompt box's `@` menu offers the workspace's files after the threads (four threads
  while files show). The page asks `frizz:pick-context {id, query}` a beat after each keystroke; the
  extension answers `frizz:context-picks` under the id, always, so an extension that never answers (an
  old one) is stopped being asked after one timeout. The file query runs over a path's characters
  (`@src/web/App`) where a thread query stops at `/`. Choosing one writes `` `src/a.ts` `` — the whole-file
  reference Add file and the bar's open files write — so the agent reads one shape for "this file". The
  mention menu hosts it rather than a QuickPick: it is where the human's eyes are, it keeps the caret
  and the menu's keys, and a QuickPick would pull focus into the editor's chrome mid-sentence.
  The index (`workspace-files.ts`): git's list in a repository (tracked, plus untracked not ignored),
  `findFiles` elsewhere, then `files.exclude` and `search.exclude` applied by a glob matcher —
  `findFiles` alone honours neither ignore files nor `search.exclude`, and in a Frizz checkout every
  thread's worktree is a gitignored copy under `.frizz/worktrees/`. Rebuilt lazily after files come or
  go, at most every 3s. Ranked as quick open reads a query (`file-picks.ts rankFiles`).
- **Explorer drops.** A drag from VS Code's workbench carries resources (`ResourceURLs`, a uri-list),
  not File objects. The composer knows VS Code's own drag types — never a bare `text/uri-list`, which a
  desktop file carries too and which stays an upload — and asks the extension to resolve the URIs
  (`frizz:pick-context {id, uris}`); each lands as the same reference at the caret. VS Code lets a webview
  take a drop only with Shift held (`WebviewWindowDragMonitor` turns the webview's pointer events off
  for any drag without it), as Claude Code's docs say.
- **Problems and the last command.** `extras-feed.ts` tells the page what else there is
  (`frizz:editor-extras`: the file in front's problem counts, the last command's line and exit code —
  never the text, which crosses only when the human adds it), and the bar's chevron menu offers them
  above the open files. `@problems` carries the file, its counts and one problem a line as the Problems
  panel reads it; `@terminal` the command, the END of its output (where a failure says what failed) and
  its exit code. The terminal side uses shell integration's execution API, stable from VS Code 1.93 and
  a throwing proposal before it (only subscribed on 1.93+); on 1.90 the entry is offered while a
  terminal is open and adding it borrows the clipboard for the terminal's own Copy Last Command and Copy
  Last Command Output.

### What the sidebar keeps apart

The frame's storage is PARTITIONED from the browser's: the same origin framed inside a `vscode-webview://`
document gets its own localStorage, so everything Frizz keeps per browser starts at its defaults in the
sidebar and stays there — the project folds, the open quiet bands, the prompt box's pick, the density, the
queue's order, the keybindings and the snooze preset. That is by design rather than a gap: each is the
state of ONE browser (lib/crossProject.ts says "per browser"), and the frame is another browser. The `?`
sheet says it for the keys, where it surprises ("Changes here stay in the sidebar"); sessionStorage lives
only as long as the webview does.

What the human sets there LASTS: the partition is kept on disk in the editor's profile, so a window reload
and a restart both find it as it was (measured 2026-10-02, scripts/e2e-sidebar.ts c17, numbered c12 when measured: a value written
into the frame's localStorage read back after a restart and after Developer: Reload Window). The one
switch that must also reach the agents' tool is not kept there at all: the eye is `frizz.shareEditorState`.

Code-file links in the sidebar open in VS Code even for a file OUTSIDE Frizz's trusted roots, on purpose.
The roots gate the server's own opener, because that launches an application with the path (an editor, a
shell's default handler); a VS Code tab is inert, the extension opens it in the window that holds the
sidebar, and the human clicked the link.

### A thread in an editor tab

Claude Code's "open in new tab" (2026-10-02): a long conversation wants the editor's width, and the sidebar
stays the primary surface. **Frizz: Open thread in editor tab** — the title row's ⋯ while the sidebar shows
a thread (first in it), or the palette, which takes the thread the sidebar shows when it is in sight and
otherwise offers the project's threads — opens a webview panel (`frizz.thread`) beside the code (in the
active group when no code is in front).

- **The same page, on the thread's own address.** The tab frames `/all/<project>/thread/<slug>?embed=vscode
  &theme=…&project=…`, which the page opens as its drawer painted open on the first render the board arrives
  (a cold deep link) — no queue flashing under a sliding drawer, as a navigate after ready would draw. Embed
  mode makes the drawer full width, so the transcript and the reply box take the tab's width.
- **A full frame.** The relay and its origin checks are the sidebar's (frameDocument), and every page
  message is answered the way the sidebar answers it: the handling the sidebar had inline is shared
  (framed-page.ts `actOnPage`, `Composes`), and the editor's feeds (`frizz:editor-context`,
  `frizz:editor-extras`, `frizz:host-state`) go to every ready page. So code links open in the editor, `@`
  lists the workspace, the bar reads the editor and a reply carries the editor block, the eye is the same
  setting. Two things mean something else in a tab: Ctrl+L pressed in it goes back to the code (the
  sidebar's "focus the active editor group" would focus the tab's own group), and a click on its bar adds
  to its own box (`PageHost.addContext` takes the asking frame).
- **In the editor's colours, on the editor's surface.** With `frizz.matchEditorTheme` (on by default) the
  tab's relay hands its page the theme's colours as the sidebar's does, but names the `editor` surface, so
  the page takes the editor's background (theme.css `data-host-colors="editor"`): a tab among the code's
  tabs, not a piece of side bar dropped into the editor area.
- **One tab per thread, by what it shows.** A tab is the thread its page's last `frizz:route` names (its
  `href`), so a thread link followed inside it makes it that thread's; asking for a thread a tab shows
  brings that tab forward. Its title is the page's — VS Code does not re-case a tab's title as it does the
  sidebar's row. A tab whose page went back to the queue reads "Frizz" and is nobody's.
- **Ctrl+L goes to the Frizz used last.** The relay posts `{ view: "focused" }` when its page takes the
  keyboard; the editor's adds (Ctrl+L, Ctrl+I, Alt+K, a file, the quick fix, the terminal) and Ctrl+L with
  nothing selected go to the tab when it was used last and is on screen, else to the sidebar. Ask and Send
  keep the sidebar: they name their own box.
- **Restored after a reload.** The relay keeps `{ thread, project }` as the webview's state (`setState`,
  names only, JSON made safe for a script), and a serializer (`onWebviewPanel:frizz.thread`) frames it
  again; a tab restored before Frizz is found says "Looking for Frizz…" until it is.

## What the agents can read: `mcp__frizz__editor`

The maintainer, after asking an agent in the sidebar "can you see the highlighted code in vscode?" and
being told no (2026-10-02): *"the only reason this is useful is if it has full context on the editor"*.
Until then a selection reached a worker only as a chip the human added. Claude Code's IDE integration
gives its agent the editor through MCP tools it calls on demand (getCurrentSelection, getOpenEditors,
getDiagnostics); Frizz now does the same for every worker, Claude, Codex and ACP alike, through the
socket it already had.

- **One reading of "in front", for the bar, the block and the tool.** The extension had two observers of
  the editor, written by two builders, that disagreed about the same moment: the page's read `file:`
  documents only, went blank when the Output panel took focus and had no dirty flag; the tool's read
  untitled buffers, kept the last file editor on screen and knew about unsaved changes. Now one rule and
  one reading (packages/vscode editor-front.ts, pure) and one observer (editor-watcher.ts) feed both: a
  file on disk or an untitled buffer — the modified side of a diff included — the active one when it is,
  else the last one still on screen (focus in an output pane or the debug console makes THAT the active
  text editor in VS Code, which would blank the selection the human was pointing at). Each feed keeps only
  what is its own: the page's 16 Ki text ceiling and 100ms cadence (the text rides every send; a bar the
  human watches while selecting) against the tool's 32 Ki and 250ms (read once, when an agent asks; a frame
  that also carries diagnostics a language server re-publishes per keystroke).
- **Secrets stay home.** A selection's TEXT never leaves on its own — not in the block, not in the frame —
  from a file whose name says it holds credentials (`.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`,
  `*credentials*`, `*secret*`, `.netrc`, `.npmrc`, …; editor-front.ts secretFile, loose on the safe side)
  or that VS Code is told to hide (`files.exclude`, matched by VS Code's own glob engine). The path and
  lines are still named, and the human can still add the text on purpose as a chip. Gitignored files are
  not withheld: a build output is not a secret, and an agent told "not quoted" for every file under dist/
  would be told it for nothing.
- **The frame.** Each window sends `editor` (`EditorSnapshot`, editor-protocol.ts): the text editor in
  front — path (an untitled buffer's label), language, unsaved, line count, caret, the lines on screen,
  the primary selection with its text (or `withheld`) — the other tabs most recent first, the errors and
  warnings, and the full problem counts.
- **When.** Debounced 250ms after any change of the active editor, selection, visible range, tabs, a
  document's text or dirty state, or the diagnostics; at once when the setting changes; and once on
  every connect. An unchanged picture is not resent (packages/vscode editor-state-feed.ts).
- **Version skew.** The server closes a socket on any frame it does not know (4401), on every redial,
  so the protocol stays v1 and grows by advertisement: the welcome names `features: ["editor-state"]`
  and the extension sends the frame only to a Frizz that named it. An older Frizz never hears it, and the
  log says its agents cannot read the editor. The schema is strict, so a newer FIELD is advertised too:
  `editor-selection-withheld`; a Frizz that does not name it gets a withheld selection as `truncated`
  with no text (connection.ts forServer), which keeps the text home all the same.
- **Fitting.** Capped to the server's schema — 50 tabs, 100 diagnostics (every error before any warning,
  the file in front first within each, so 200 lint warnings cannot push out an error elsewhere), messages
  at 300 characters, selected text at 32 Ki characters flagged `truncated` — and the whole frame fitted
  into 56 KiB encoded (`EDITOR_STATE_MAX_BYTES`, under the 64 KiB frame ceiling) by trimming the
  diagnostics, then the tabs, then the selected text, by ENCODED size (packages/vscode editor-state.ts).
- **The opt-out** is the one switch, the bar's eye: `frizz.shareEditorState` (default on). Off, the
  window sends `shared: false` with nothing else, and the server forgets what it had: a worker is told
  the human turned it off, which is a different next move from "no editor".
- **The server** keeps each window's latest frame with its arrival time and drops it with the window.
  `editorState` (project-prefixed, a mutation only because the worker's MCP server POSTs everything)
  answers the windows that have the project open — a workspace folder that holds `workDirOf(project)`,
  one inside it (a package, a thread's worktree opened with "Open in editor"), or a loose window whose
  file in front is under it — most recently focused first, with how many windows are connected. The
  others are counted, not described: until 2026-10-02 their folders were listed (`elsewhere`) to any
  worker of any project, which told a worker of project A every other project the human had open.
- **The tool.** `editor` (cc-worker/bin/frizz-mcp.mjs, `readOnlyHint`, no arguments: the window is the
  one on the caller's project) renders the window used last as text: the file, the selected lines and
  text in a fence, the caret and screen, the tabs, the problems grouped by file. Every way of having
  nothing to read says why — no editor, none on this project, an extension too old to report, sharing
  off, a Frizz too old for the procedure ("restart Frizz to enable this") — and ends on asking the human
  to paste it. Its description names the words humans use ("this", "the selected code", "the error"),
  and the worker contract names the tool in one sentence, since a worker's MCP tools are deferred.

Both models, then, as the two products the maintainer named do it between them: what is in front rides
every sidebar send on its own (Cursor's always-attached context, Claude Code's selection indicator), and
the agent can READ the editor when it decides to (Claude Code's IDE tools) — including from a thread the
human talks to in a browser tab, and for what the block does not carry (the tabs, the problems, a
selection between the block's 16 Ki and the tool's 32 Ki).

## Threads in worktrees: the right copy

A thread that works in its own checkout (`.frizz/worktrees/<slug>`, or any folder the tailer lifts into
`thread.checkout`) and a human whose window shows the main checkout are looking at two copies of every
file, and the same relative path names both. Everything that crosses between them says which copy it
means (2026-10-02):

- **The `editor` tool** sends its thread's slug (`editorState({slug})`); the server answers the thread's
  checkout beside the windows. Paths stay absolute; a window on the main checkout gets one clause saying
  the selection is the human's copy and the same relative path under the worktree is the agent's, and
  the file in front gets `Your copy: <worktree path>`. A window opened on the worktree itself says its
  files are the agent's own.
- **What the sidebar sends** to such a thread (chips, the editor block) writes a worktree file relative
  to the worktree and a main-checkout file relative to the project, plus one trailing sentence naming
  both folders. Every parser peels that sentence first, and the bubble hides it.
- **Links the thread wrote** resolve against its checkout first, then the project: the transcript's
  relative Markdown links render with the checkout as their base, inline code asks
  `resolveLocalPaths({paths, base})`. A path into a worktree that is gone (Done removed it) settles to
  the main checkout's copy in every opener (`settleWorktreePath` on the server; the extension asks
  `settleLocalPath` only when a sidebar-opened path does not exist).
- **A window whose folder is a thread's worktree** opens its sidebar on that thread, once per page load,
  from the extension after `frizz:ready` (the frame's address is read once per frame and would be stale
  after a move); every wait for the page waits for that navigation, so a chip added by the command that
  opened the sidebar lands in the thread's box. Send to Frizz thread offers it first.
- **Done** is refused (completeThread, setThreadState archived, archiveThread) while any window that
  shares its state holds an unsaved file in a worktree Done would remove: "Save or close a.ts in VS Code
  first: it has unsaved changes." The cleanup checks the same thing as its first reason to keep a
  worktree. Best effort: sharing off, an extension too old to report, or a dirty tab past the frame's
  50-tab cap is not seen.
- **A worker never attaches to the human's editor.** Launched from an editor terminal, Frizz's own
  environment carries Claude Code's IDE address (`CLAUDE_CODE_SSE_PORT`, `ENABLE_IDE_INTEGRATION`,
  `FORCE_CODE_TERMINAL`, `CLAUDE_CODE_IDE_*`); `inheritWorkerEnvironment` drops them for every transport,
  and a Claude worker gets `CLAUDE_CODE_AUTO_CONNECT_IDE=false`.

## Reviewing a thread's changes

Claude Code and Cursor show an agent's edits as native diffs. A Frizz worker edits files directly, often
in a worktree of its own, so the Frizz form is: from a thread, open everything it changed as VS Code's
multi-file diff (`vscode.changes`, the editor Source Control's "View changes" opens — present and the
same in 1.90 and 1.140) against where it started. The left side is the base, read-only; the right side
is the real file, so the human fixes what they see in place, with the language server running.

**Where it is offered** — the diff is the editor's, so only where one can show it:

- The sidebar: the thread's ⋯ **Review changes**, always. The page posts `frizz:review {thread, project,
  title}` — names, never a folder — and the extension asks Frizz what the thread changed
  (`reviewTarget`) and opens it in that window.
- A browser tab: the thread's ⋯ **Review changes in VS Code** (the editor's name; "in your editor" when
  two kinds could take it), and **Review** on the fullscreen rail's Edited files heading — only while a
  window that can review is connected and takes opens. `reviewInEditor` pushes a `review` frame to the
  window holding the thread's checkout (deepest folder, first checkout first), else the project, else the
  one used last on this filesystem; it opens the diff and comes to the front. No editor, no item: an
  in-browser diff is a different feature, and an item that could only say "connect an editor" is a dead
  end.
- The palette: **Frizz: Review a thread's changes…**, a pick of the window's project's threads.

**What the server names** (server `review-target.ts`). Frizz records nothing about a thread's base, but it
knows where the thread WROTE — the rail's edited files, over the whole transcript, filtered to what git
carries — and where its agent works now. Those name the checkouts: a worktree of the project's
repository is the thread's own (scope `branch`, every change in it); the project folder is shared by
every agent and the human (scope `files`: the thread's own files and nothing else). A file in another
repository is left out. The worktree the agent works in counts even with no edit seen there (a codemod
writes no Edit record).

**What git answers** (extension `review.ts`). `files`: the thread's files against HEAD, i.e. their
uncommitted changes — a commit in the shared tree is as likely someone else's. `branch`: everything since
the branch LEFT the branch it came from, committed or not. Candidates: where the branch was created (its
reflog's `branch: Created from X`, which `git worktree add -b` writes), X at its current tip when X is a
branch, and the project folder's branch; a tip that already holds HEAD (the work merged back) is skipped,
and the merge-base with the fewest commits to HEAD wins. So main moving on after the fork shows nothing of
main's, a thread that merged main in is shown against that merge, and a branch merged back into main still
shows its work. `git diff <base>` against the working tree, renames paired for a whole branch (not for a
file list, where git would pair one of the thread's files with someone else's), untracked non-ignored files
as added, binaries left out (the diff shows text). Reads take no optional lock (`GIT_OPTIONAL_LOCKS=0`).
The base side is `frizz-base:<file>?repo&ref&path`, `git cat-file blob`; its parser refuses a non-sha ref
and an absolute or `..` path.

**Version skew.** The hello is strict and reaches every server, so a window cannot announce a new ability
there. The welcome names `review`; only then does the extension send a `features` frame saying it can,
and only a window that said so is ever sent `review`. `editorWindows` / `editors` carry `reviews: true`,
which is what the page offers the action by. A review waits 20s for its answer (git runs several commands
per checkout), an open still 5s.

What VS Code does with it, measured in 1.90 and 1.140: the tab reads "Changes in <title> (5 files)"; an
added file shows an empty base and a deleted one an empty file side; a rename pairs both names in its
header; `TabInputTextMultiDiff.textDiffs` lists only the two-sided entries.

Also fixed for it: the rail's edited files dropped EVERY file of a worktree thread — `check-ignore` ran in
the project root, which ignores `.frizz/`. Each path is now probed in the checkout that holds it
(`repo-files.ts`).

## Verification

- Unit: `file-position.test.ts`; the bridge against real `ws` clients (`editor-bridge.test.ts`);
  opener argv with positions (`local-file.test.ts`); page link parsing; the extension's discovery
  (its address-record verdict run beside `readStableServerOwner` over files the server's own writer
  wrote), project matching, message format (pinned to the page's `parseSentContext`) and compose size;
  its connection against an in-process server that judges every frame with the server's own
  `EditorClientMessageSchema` and frame ceilings; the sidebar's relay, CSP and routing (`embed.test.ts`,
  `sidebar-html.test.ts`); the one reading of the editor in front both feeds share — the front rule (the
  Output panel, a diff's sides, a closed editor), the flags, secret files by name, the text read only as
  far as a feed carries it and only through VS Code's own ranges, and the page and the tool agreeing
  (`editor-front.test.ts`); the editor's context for the sidebar — the column-1 line rule, the selection's
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
    across selections, the selection's text and no other, the other open files once each and most recent
    first, unsaved changes, an untitled buffer in front in its own right, the Output panel in focus
    keeping the file in front, a diff's working-tree side as the file, a `.env` selection told without
    its text), a drag as one message and an unchanged context as none, a reloaded page told at once; one
    switch — the page's eye writing `frizz.shareEditorState` (the workspace's value when it sets one) and
    the agents' frame, the page's feed and the eye following it either way; `frizz:add-context` for the
    selection and a whole file, and nothing when either is gone; Ctrl+L and Ctrl+I PRESSED with a
    selection landing a chip with the caret, Ctrl+L with a caret going to the prompt box and adding
    nothing (and selecting the line with `frizz.useSidebar` off), Ctrl+I with a caret staying VS Code's,
    Ctrl+L forwarded from the page going back to the editor, Alt+K landing the selection and,
    with a caret, the whole file (trusted keys through the workbench's debugging port, `e2e/cdp.ts`); the quick fix
    offered for a diagnostic with its lines and `note`, two problems told apart, none with the setting
    off; a tab's and the explorer's files; a terminal selection as `@terminal` with the clipboard
    restored; `frizz:route` as the buttons the title row really shows and the badge's tooltip, with
    the row still reading Frizz; and every title-row command (Keyboard shortcuts in the ⋯), and a real click on one, reaching the page as `frizz:command`.
    And the agents' picture: a selection, a tab and a problem from a real diagnostic collection reaching
    Frizz as the `editor` frame, an edit marking it dirty, sharing off sending nothing else, and a `.env`
    selection sent as its lines, `withheld`, with the key in no frame.
    And Review changes over a real worktree (`e2e/review-repo.ts`: committed and uncommitted edits, an add,
    a delete, a rename, an untracked file, an ignored one, a binary, and main moving on after the fork):
    pushed as a browser's ask, from the sidebar's page by thread name (and a folder in its place ignored),
    and from the palette — each the right files in git's order, the base side through the content
    provider and the file side from disk, the base at the fork, and the loop's diff DRAWN on both sides
    (the workbench's DOM); nothing to compare and not a repository refused in words with nothing opened.
    And the build in the hello and the tooltip, a new build on disk offered as Reload window; an
    `attention` frame as a notification only while the sidebar is out of sight, its Open (a real click on
    the toast) showing the thread, and `frizz.notify` off saying `listen false`; a Frizz from before the
    sidebar named at once; `@` answered from the workspace with both exclude settings held, and a drop's
    URIs resolved to a file and a folder; the problems and the last command (through shell integration
    on 1.93+, the borrowed clipboard on 1.90) each adding one chip.
    `FRIZZ_E2E_ONLY=<part of a step's name>` runs just those steps.
  - `FRIZZ_E2E_VSCODE=oldest nub packages/vscode/scripts/e2e.ts` — the same on the oldest VS Code the
    manifest's `engines.vscode` admits (1.90.0). Its three failures at 75bee49a were all the harness's
    (2026-10-02): a step reverted the active editor instead of the sample it dirtied, and 1.90 keeps a dirty
    buffer through closeAllEditors, so every later step read an extra line; the real-page run's agent read
    `terminal.shellIntegration`, a throwing proposal before 1.93; and 1.90's default side bar (255px) is too
    narrow for any variant of the bar's hint, which c3 now measures at the ~300px its shots are named for.
    Also on the floor: `focusWindow` does not exist and shell
    integration's command events are a proposal that throws (which killed activation once).
  - `nub packages/vscode/scripts/e2e.ts --stack` — boots a disposable two-project Frizz itself
    (`scripts/adhoc-stack.mjs`: sandbox HOME, a free port, two throwaway git repos) and runs REAL mode
    against the TENANT project: `openLocalFile` with a line landing in the editor over the bridge, the
    window listed in `editorWindows`, and "Add to Frizz prompt" landing as a chip in the new-thread box
    of a headless page open on the tenant (`e2e/page-claim.ts`), and a worker's `editor` tool — the real
    `frizz-mcp.mjs`, stamped with the tenant's id — reading the window's selection and problem through the
    real server; and a seeded thread whose agent edited files in a worktree (`e2e/review-seed.ts`): the
    server reads those edits as its edited files and the worktree as its checkout, and `reviewInEditor`
    — what a browser tab's ⋯ calls — opens them in this window. Every opener the server could spawn
    (`code`, `cursor`, `xdg-open` …) is a stub on its PATH, and the run fails if one was spawned. The
    stack is stopped by its process group and anything still carrying its HOME is killed, pass or fail.
    Ask and Send start real agents, so they run only with `FRIZZ_E2E_DISPATCH=1` (which adds `--creds`).
- The sidebar as the human uses it, `nub packages/vscode/scripts/e2e-sidebar.ts [--out=<dir>]` (also
  under Xvfb, never the real display): the packaged `.vsix` in a real VS Code with its own extensions
  directory, a disposable two-project Frizz, and the REAL page framed in the sidebar; keys and clicks are
  trusted input on the workbench, and every check reads where it shows (the page's DOM, VS Code's title
  row and editor, a simulated worker's socket). The header lists the checks; for editor context: c3 the
  bar following the editor; c4 Ctrl+L into the reply box as a pill, sent with its context, and Ctrl+L
  both ways (the reply box back to the editor; the editor with nothing selected revealing the sidebar
  with the caret in the box); c8 the `?` sheet's Editor rows; c10 one switch — the eye, clicked, turning
  the setting off, the worker's real `editor` tool then reading nothing and a send carrying no block, the
  setting turned on in VS Code turning the eye on, a send quoting the selection and the next naming it;
  c11 a stand-in extension with Claude Code's id and Alt+K installed live, Alt+K then its and the sheet
  without the row, and Frizz's again once it is uninstalled; c12 a window on a thread's worktree opening
  the sidebar on that thread (`--worktree`); c13–c16 `@` files, an explorer drop, the problems and last
  command pills, and a needs-you notification; c18 the editor's colours through seven themes and
  `frizz.matchEditorTheme` off and on; c19 the selection hint where the editor draws it (its
  colour, its line, the settle, the ink gap, gone on an empty selection, after Ctrl+L and with the setting
  off); c20 a thread in an editor tab from the title row's ⋯, its reply box sending to the simulated
  worker with the editor block, Ctrl+L into the tab and back; c17, always last, a restart and then a window reload
  (Developer: Reload Window, typed in the palette), both of which the framed page's own `localStorage`
  and the eye survive. Under the test runner a reload ends the run (VS Code exits with its extension
  host), so c17 reopens the same profile in a VS Code of the harness's own and reloads that. c21 the bar's ×:
  pointed at, the glyph is the ×; clicked, the reading is struck and pressed with the eye and the setting
  untouched, the agents' tool still reading the selection, a send carrying no block, and a new selection
  quoted again. c22 an image on the real X clipboard (xclip under the run's Xvfb), Ctrl+V in the reply box:
  a control text paste attaches nothing, the image becomes a tile, and the send names a PNG on disk. c23 a
  file from outside VS Code: VS Code's own drag monitor, measured on the workbench, turns the webview's
  pointer events off for a plain drag and back on with Shift (so a drop needs Shift, as the explorer's
  does); a drag carrying a real file, dispatched to the page's frame with Shift, shows "Drop file to
  attach" and lands as a tile. Neither paste nor drop needed a fix: the page's own handlers work in the
  webview. Not reached: a drag from a real file manager (none on the Xvfb box), so XDND itself is VS
  Code's and Chromium's, not exercised.
