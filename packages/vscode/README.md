# Frizz for VS Code

Talk to [Frizz](https://github.com/ssalbdivad/frizz) from your editor, and land on Frizz's file links
in it. Works in VS Code, Cursor and Windsurf.

- **The Frizz sidebar** — the Frizz icon in the activity bar opens Frizz itself beside your code: the
  queue, threads, questions and prompt boxes, live, in VS Code's light or dark theme, on this window's
  project. File links in it open in this window, web links in your browser, and the palette, quick
  open, side bar, panel and terminal shortcuts still work while it has focus. Its badge counts the
  threads ready for you. **Reload** and **Open in browser** are in its title bar.
- **Ask Frizz…** — select code (or right-click a file) and ask about it in the sidebar's new-thread
  box, which opens with the selection in it as the same chip the page's prompt box makes.
- **Send to Frizz thread…** — pick one of the project's open threads, ones waiting on you first; it
  opens in the sidebar with the selection in its reply box.
- **Add to Frizz prompt** (`Ctrl+Alt+P`, `⌘⌥P` on macOS) — put the selection into the prompt box the
  sidebar shows, leaving the caret in your editor for the next one. Until you open the sidebar in a
  window, it goes to the Frizz page in your browser.
- **File links from Frizz** open here — in the window that has the file's folder open, at the line the
  link names, and that window comes to the front — when Frizz's External app setting is this editor
  (Frizz offers to switch it the first time a window connects).
- **The status bar** shows how many of this workspace's threads are ready for you. Click it to show
  the sidebar.

The commands are in the editor's right-click menu under **Frizz**, on files in the explorer, and in the
command palette.

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
| `frizz.useSidebar` | on | Ask, Send and Add go to the sidebar. Off, Add goes to Frizz in your browser, and Ask and Send take your message in an input box and send it. |

**Frizz: Show log** shows how the extension found Frizz and every time the connection changed;
**Frizz: Reconnect** looks for Frizz again at once.
