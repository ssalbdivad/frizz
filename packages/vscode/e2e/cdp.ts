// THE WORKBENCH OVER THE CHROME DEVTOOLS PROTOCOL — how the end-to-end harness presses a real key in the
// VS Code it launched (with `--remote-debugging-port`), and photographs it. A keybinding is only proved
// by a key: `commands.executeCommand` runs the command a binding names, but not the binding's `key` or
// its `when`, and a when clause that never matches looks exactly like one that does until a human
// presses the chord. `Input.dispatchKeyEvent` is TRUSTED input to the renderer, the same path a
// keyboard takes, so the workbench's own keybinding service resolves it — `when` clause, conflicts with
// VS Code's defaults and all.
//
// Runs in the harness (Node with a global WebSocket), never inside the editor. Under Xvfb only: the
// harness refuses the real display before it starts anything.

interface Target {
  type: string
  url: string
  webSocketDebuggerUrl?: string
}

/** The modifier bits `Input.dispatchKeyEvent` takes. */
const MODIFIER = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const
type Modifier = keyof typeof MODIFIER

/** The DOM key, code and Windows virtual key of each key the suite presses. */
const KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  ctrl: { key: "Control", code: "ControlLeft", keyCode: 17 },
  meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
  shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
  alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  ".": { key: ".", code: "Period", keyCode: 190 },
}
for (const letter of "abcdefghijklmnopqrstuvwxyz") KEYS[letter] = { key: letter, code: `Key${letter.toUpperCase()}`, keyCode: letter.toUpperCase().charCodeAt(0) }

export class Workbench {
  readonly #socket: WebSocket
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  #next = 0

  private constructor(socket: WebSocket) {
    this.#socket = socket
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } }
      if (message.id === undefined) return
      const waiter = this.#pending.get(message.id)
      this.#pending.delete(message.id)
      if (message.error) waiter?.reject(new Error(message.error.message))
      else waiter?.resolve(message.result)
    })
  }

  /** The workbench window's page on a VS Code debugging on `port`, once it is up. */
  static async connect(port: number, timeoutMs = 60_000): Promise<Workbench> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Target[]
        const page = targets.find((target) => target.type === "page" && /workbench(\.esm)?\.html/u.test(target.url) && target.webSocketDebuggerUrl)
        if (page) {
          const socket = new WebSocket(page.webSocketDebuggerUrl!)
          await new Promise<void>((resolve, reject) => {
            socket.addEventListener("open", () => resolve(), { once: true })
            socket.addEventListener("error", () => reject(new Error(`could not open ${page.webSocketDebuggerUrl}`)), { once: true })
          })
          return new Workbench(socket)
        }
      } catch {}
      if (Date.now() > deadline) throw new Error(`no VS Code workbench on debugging port ${port} within ${timeoutMs / 1000}s`)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.#next
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.#socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** An expression's value in the workbench page (JSON-able). */
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(`${expression.slice(0, 80)}…: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    return result.result.value as T
  }

  /**
   * Press a chord — `"ctrl+i"`, `"ctrl+shift+e"`, `"escape"` — as a keyboard does: modifiers down, the
   * key down and up, modifiers up. The window gets focus emulation first, since under Xvfb with no window
   * manager nothing ever gives an X window focus, and a page that thinks it is unfocused routes no keys.
   */
  async press(chord: string): Promise<void> {
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: true })
    const parts = chord.toLowerCase().split("+")
    const keyName = parts.pop()!
    const modifiers = parts as Modifier[]
    const key = KEYS[keyName]
    if (!key || modifiers.some((modifier) => !(modifier in MODIFIER))) throw new Error(`no key ${chord}`)
    let bits = 0
    const event = (type: string, which: { key: string; code: string; keyCode: number }) =>
      this.send("Input.dispatchKeyEvent", { type, modifiers: bits, key: which.key, code: which.code, windowsVirtualKeyCode: which.keyCode, nativeVirtualKeyCode: which.keyCode })
    for (const modifier of modifiers) {
      bits |= MODIFIER[modifier]
      await event("rawKeyDown", KEYS[modifier]!)
    }
    await event("rawKeyDown", key)
    await event("keyUp", key)
    for (const modifier of [...modifiers].reverse()) {
      bits &= ~MODIFIER[modifier]
      await event("keyUp", KEYS[modifier]!)
    }
  }

  /** Click the centre of the first element `selector` matches, with a real (trusted) mouse; false when nothing matches. */
  async click(selector: string): Promise<boolean> {
    const box = await this.evaluate<{ x: number; y: number } | null>(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)})
      if (!element) return null
      const r = element.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()`)
    if (!box) return false
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: true })
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 })
    }
    return true
  }

  /** A PNG of `clip` (CSS pixels) rendered at `scale` device pixels per CSS pixel. */
  async shot(clip: { x: number; y: number; width: number; height: number }, scale = 1): Promise<Buffer> {
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { ...clip, scale }, captureBeyondViewport: false })
    return Buffer.from(data, "base64")
  }

  close(): void {
    this.#socket.close()
  }
}
