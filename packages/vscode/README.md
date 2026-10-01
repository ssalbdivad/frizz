# Frizz for VS Code

Talk to [Frizz](https://github.com/ssalbdivad/frizz) from your editor, and land on Frizz's file links
in it. Works in VS Code, Cursor and Windsurf.

- **Ask Frizz…** — select code (or right-click a file), type a question, and Frizz starts a thread on
  it in the file's project, with your saved model and effort. The selection travels as a quoted
  reference, the same chip the page's prompt box makes.
- **Send to Frizz thread…** — pick one of the project's open threads, ones waiting on you first, and
  send the selection with a message.
- **Add to Frizz prompt** (`Ctrl+Alt+P`, `⌘⌥P` on macOS) — put the selection into the prompt box of
  the Frizz page in front of you, to write a longer prompt there.
- **File links from Frizz** open here — in the window that has the file's folder open, at the line the
  link names, and that window comes to the front — when Frizz's External app setting is this editor
  (Frizz offers to switch it the first time a window connects).
- **The status bar** shows how many of this workspace's threads are ready for you. Click it to open
  Frizz on this project.

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

**Frizz: Show log** shows how the extension found Frizz and every time the connection changed;
**Frizz: Reconnect** looks for Frizz again at once.
