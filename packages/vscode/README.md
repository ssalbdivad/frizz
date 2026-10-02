# Frizz for VS Code

Talk to [Frizz](https://github.com/ssalbdivad/frizz) from your editor, and land on Frizz's file links
in it. Works in VS Code, Cursor and Windsurf.

- **The Frizz sidebar** — the Frizz icon in the activity bar opens Frizz itself beside your code: the
  queue, threads, questions and prompt boxes, live, in VS Code's light or dark theme, on this window's
  project. It is the app you know, narrowed: the same cards, type sizes and shortcuts. File links in it
  open in this window, web links in your browser. Its badge counts the threads ready for you.
- **VS Code's title row holds the header's buttons**: **Back to queue** in a thread, **New thread**
  elsewhere, **Jump to a thread** (the app's ⌘K) and **Settings**. **Reload sidebar**, **Open in
  browser** and **Keyboard shortcuts** (the app's `?`) are under its `…`. Each is in the command palette
  too, and brings the sidebar back if it was hidden. The badge's tooltip reads the counts
  (`1 needs you · 3 ready`).
- **The sidebar sees your editor.** Over its prompt boxes it names the file in front and what you have
  selected (`sample.ts:12-20`, `26 lines`), live; a click adds it as a chip, and the other open files
  are one more click away. Only paths and line numbers reach the sidebar until you add something.
- **Frizz's agents can see your editor.** Ask a thread about "this", "the selected code" or "the error"
  without pasting anything: its agent can read what you have in front of you — the file you are in,
  what you have selected and its text, your open tabs, and the editor's errors and warnings — from the
  window that has the thread's project open. The extension keeps Frizz on this machine up to date with
  it; an agent reads it only when it asks. Turn off `frizz.shareEditorState` to keep the editor to
  yourself.
- **Add to Frizz prompt** (`Ctrl+L`, `⌘L` on macOS, with text selected — Cursor's chord; `Ctrl+I` / `⌘I`
  too) — the selection becomes a chip in the prompt box the sidebar shows, with the caret after it so you
  can type straight on: the reply box of the thread you are in, else the new-thread box. The sidebar
  opens if this window never had it. Without a selection (from the editor's right-click menu or the
  palette) it adds the line your caret is on.
- **`Alt+K`** (`⌥K` on macOS — Claude Code's chord) — the selection as a chip, or with nothing selected,
  the whole file.
- **More ways in**, each landing as a chip with the caret after it:
  - **Add file to Frizz prompt** on an editor tab's right-click menu, on files in the explorer (every
    file selected), and in the editor's Frizz menu — a reference to the whole file.
  - **Ask Frizz to fix** in a problem's quick fixes (the light bulb, `Ctrl+.`) — the problem's lines,
    and the problem itself written after the chip (`Fix: Cannot find name 'foo'. ts(2304)`), ready to
    send or to edit.
  - **Add to Frizz prompt** in the terminal's right-click menu — the selected terminal output, as an
    `@terminal` chip.
- **Ask Frizz…** — select code (or right-click a file) and ask about it in the sidebar's new-thread
  box, which opens with the selection in it as the same chip the page's prompt box makes.
- **Send to Frizz thread…** — pick one of the project's open threads, ones waiting on you first; it
  opens in the sidebar with the selection in its reply box.
- **Review a thread's changes** — everything a thread changed, as VS Code's multi-file diff: from its ⋯
  menu in the sidebar (**Review changes**), from Frizz in your browser (**Review changes in VS Code**,
  which brings this window to the front), or **Frizz: Review a thread's changes…** in the palette. A
  thread that worked in a worktree shows its whole branch since it started, committed or not; one that
  worked in the project folder shows its own files' uncommitted changes. The left side is where it
  started; the right side is the file itself, to fix in place.
- **File links from Frizz** open here — in the window that has the file's folder open, at the line the
  link names, and that window comes to the front — when Frizz's External app setting is this editor
  (Frizz offers to switch it the first time a window connects).
- **The status bar** shows how many of this workspace's threads are ready for you. Click it to show
  the sidebar.

The commands are in the editor's right-click menu under **Frizz**, on files in the explorer, and in the
command palette.

## Shortcuts

| where | keys | does |
| --- | --- | --- |
| the editor, with text selected | `Ctrl+L` / `⌘L`, or `Ctrl+I` / `⌘I` | Add to Frizz prompt, caret in the sidebar |
| the editor | `Alt+K` / `⌥K` | the selection, or with none the whole file, into the prompt |
| the sidebar's prompt box | `Ctrl+L` / `⌘L`, `Ctrl+I` / `⌘I` | the editor's selection (or its file) into this box |
| the sidebar | every shortcut the app's `?` sheet lists | what it does in the app |
| the sidebar | `Ctrl+Shift+P`, `Ctrl+P`, `Ctrl+B`, `Ctrl+J`, ``Ctrl+` ``, `Ctrl+1`, `Ctrl+Shift+E/F/G/D/X` (`⌘` on macOS) | VS Code's own: palette, quick open, side bar, panel, terminal, back to the editor, the built-in views |

## Where the sidebar differs from Frizz in your browser

- **`Ctrl+L` and `Ctrl+I` with text selected are Frizz's.** Without a selection, and everywhere outside
  the editor, both stay the editor's own: `Ctrl+L` selects the caret's line, and `Ctrl+I` is VS Code's
  suggestions (also on `Ctrl+Space`) or its inline chat where chat is on. With a selection, Frizz's
  bindings win: a second `Ctrl+L` to grow a line selection adds it to Frizz instead (`Ctrl+L` once, then
  `Shift+↓`, still does), and inline chat is in the palette (**Inline Chat**). In Cursor, whose chat and
  agent are on `Ctrl+L` and `Ctrl+I`, Cursor and Frizz bind the same chords; rebind either in **Keyboard
  Shortcuts** if the wrong one answers. Frizz's first binding, `Ctrl+Alt+P`, is gone.
- **`Alt+K` in the editor is Frizz's**, with or without a selection. On macOS `⌥K` types `˚` in other
  apps; in the editor it adds to Frizz, as Claude Code's does.
- **While the sidebar has focus, VS Code sees only the chords in the table above**; every other key goes
  to Frizz, as in the browser. Copy, cut, paste, undo and select all stay the text box's.
- **The terminal's right-click menu**: on Windows a right-click in the terminal copies or pastes by
  default (`terminal.integrated.rightClickBehavior`); Shift+right-click opens the menu. Adding from the
  terminal borrows the clipboard for a moment and puts your text back: a clipboard holding an image
  comes back empty, and a clipboard history records the selection.
- **No Frizz header, no browser notifications.** The title row's buttons stand in for the header, and
  it always reads "Frizz": VS Code re-cases a view's title, so thread and project names stay in the page,
  and it shows no view description in a sidebar of one view. Frizz's
  desktop notifications cannot fire inside an editor, so the badge and the status bar carry the count.
- **The theme is VS Code's**, light or dark, for as long as the sidebar shows; your Frizz theme setting
  is the browser's.

## Install

Frizz must be running on this machine (`npx frizz`). The extension finds it on its own.

From a Frizz checkout: `nub run vscode:install` builds the `.vsix` and installs it — into the VS Code
Server when you are in WSL, since the extension runs where your files are. Or build it with
`nub run vscode:package` and install `packages/vscode/dist/frizz-vscode-<version>.vsix` with
**Extensions: Install from VSIX…**.

## Settings

| setting | default | |
| --- | --- | --- |
| `frizz.serverUrl` | empty | Frizz's address, such as `http://127.0.0.1:9393`. Empty finds the Frizz running on this machine. |
| `frizz.openFileLinks` | on | Open file links from Frizz in this window. Turn it off for a window that should never take them. |
| `frizz.shareEditorState` | on | Let Frizz's agents read what this window shows when they need it: the file in front, your selection and its text, your open tabs, the errors and warnings. Off, they see nothing of it. |
| `frizz.useSidebar` | on | Everything you add from the editor, and Ask and Send, go to the sidebar. Off, selections and files go to Frizz in your browser, Ask and Send take your message in an input box and send it, and the quick fix and the terminal's entry are not offered. |

**Frizz: Show log** shows how the extension found Frizz and every time the connection changed;
**Frizz: Reconnect** looks for Frizz again at once.
