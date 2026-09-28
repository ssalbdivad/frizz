// Launch the PACKAGED desktop app and check it does its one job: its window reaches a Frizz server and
// carries the preload bridge. This is the release gate in .github/workflows/desktop.yml — nothing is
// published that did not get this far on its own OS — and it runs by hand after `nub run desktop:dist`.
//
//   node packages/desktop/scripts/smoke.mjs              the unpacked app(s) in out/
//   node packages/desktop/scripts/smoke.mjs --install    the INSTALLERS, installed as a user would: the
//       .deb through apt (sudo), each .dmg mounted, the NSIS installer run silently. It installs onto the
//       machine it runs on, so it is for a disposable CI runner, not a workstation.
//   node packages/desktop/scripts/smoke.mjs --app=<executable>    one binary, as it is
//
// The server is a stand-in on a free port, named by FRIZZ_DESKTOP_URL, so this tests the app rather
// than whatever `npx frizz` publishes today — verify-start.ts and verify-window.ts drive the real
// launcher. Plain JavaScript because CI runs it with node, which has no nub. On Linux the app gets a
// private Xvfb display, so nothing opens on a real screen.
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { createServer as createHttpServer } from "node:http"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const out = resolve(dirname(fileURLToPath(import.meta.url)), "..", "out")
const install = process.argv.includes("--install")
const only = process.argv.find((arg) => arg.startsWith("--app="))?.slice("--app=".length)
const TITLE = "Frizz desktop smoke"
const BRIDGE = "chooseProject,focusWindow,retry"

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, ...(detail ? { detail } : {}) })
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`)
}

const artifacts = (pattern) => (existsSync(out) ? readdirSync(out).filter((file) => pattern.test(file)).map((file) => join(out, file)) : [])

// The stand-in board: a page with a known title, and the health route the app's own probe would ask.
const server = createHttpServer((request, response) => {
  if (request.url === "/_frizz/health") {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ ok: true, bootId: "smoke" }))
    return
  }
  response.setHeader("content-type", "text/html")
  response.end(`<!doctype html><title>${TITLE}</title><p>smoke</p>`)
})
await new Promise((ready) => server.listen(0, "127.0.0.1", ready))
const origin = `http://127.0.0.1:${server.address().port}`

function freePort() {
  return new Promise((ready) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address()
      probe.close(() => ready(port))
    })
  })
}

/** One DevTools round trip on a page's own socket. */
async function evaluate(socketUrl, expression) {
  const socket = new WebSocket(socketUrl)
  try {
    await new Promise((open, fail) => {
      socket.onopen = open
      socket.onerror = () => fail(new Error("the DevTools socket did not open"))
    })
    const reply = new Promise((answer) => {
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data))
        if (message.id === 1) answer(message)
      }
    })
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }))
    const message = await Promise.race([reply, delay(15_000).then(() => ({ error: { message: "no reply in 15s" } }))])
    if (message.error) throw new Error(message.error.message)
    return message.result?.result?.value
  } finally {
    socket.close()
  }
}

function stop(child) {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
  else try { process.kill(-child.pid, "SIGKILL") } catch {}
}

/** Launch one executable against the stand-in and read back what its window shows. */
async function smoke(label, executable, extraArgs = [], extraEnv = {}) {
  const port = await freePort()
  const config = mkdtempSync(join(tmpdir(), "frizz-desktop-smoke-"))
  const argv = [`--remote-debugging-port=${port}`, ...extraArgs]
  const xvfb = process.platform === "linux"
  const env = { ...process.env, ...extraEnv, FRIZZ_DESKTOP_URL: origin, XDG_CONFIG_HOME: config }
  // Xvfb's display, never the one this shell happens to have — and never Wayland, which Electron would
  // otherwise prefer and which xvfb-run does not replace.
  if (xvfb) delete env.WAYLAND_DISPLAY
  const child = spawn(xvfb ? "xvfb-run" : executable, xvfb ? ["-a", "-s", "-screen 0 1280x800x24", executable, ...argv] : argv, {
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  let log = ""
  child.stdout.on("data", (chunk) => { log += chunk })
  child.stderr.on("data", (chunk) => { log += chunk })
  child.on("error", (error) => { log += `\nspawn failed: ${error.message}` })

  let page
  let seen = "nothing"
  try {
    const deadline = Date.now() + 90_000
    while (!page && Date.now() < deadline && child.exitCode === null) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        const pages = targets.filter((target) => target.type === "page")
        page = pages.find((target) => target.url.startsWith(origin))
        seen = pages.map((target) => target.url.slice(0, 160)).join(", ") || "no page"
      } catch {
        // DevTools is not listening yet.
      }
      if (!page) await delay(500)
    }
    check(`${label}: the window reaches the server`, Boolean(page), page ? page.url : `window shows ${seen}; exit ${child.exitCode}`)
    if (!page) {
      console.log(log.trim().split("\n").slice(-40).join("\n"))
      return
    }
    const read = await evaluate(page.webSocketDebuggerUrl, `new Promise((done) => {
      const read = () => document.readyState === "complete"
        ? done(JSON.stringify({ title: document.title, bridge: window.frizzDesktop ? Object.keys(window.frizzDesktop).sort().join(",") : "missing" }))
        : setTimeout(read, 100)
      read()
    })`)
    const { title, bridge } = JSON.parse(read)
    check(`${label}: the board renders`, title === TITLE, title)
    check(`${label}: the preload bridge is on the page`, bridge === BRIDGE, bridge)
  } catch (error) {
    check(`${label}: launch`, false, error instanceof Error ? error.message : String(error))
    console.log(log.trim().split("\n").slice(-40).join("\n"))
  } finally {
    stop(child)
    await delay(1_000)
    rmSync(config, { recursive: true, force: true })
  }
}

/** The one executable inside a macOS bundle's Contents/MacOS. */
function bundleExecutable(app) {
  const dir = join(app, "Contents", "MacOS")
  const [binary, ...rest] = readdirSync(dir)
  if (!binary || rest.length) throw new Error(`expected one executable in ${dir}, found ${[binary, ...rest].join(", ")}`)
  return join(dir, binary)
}

/** Apple silicon runs an x64 build only through Rosetta, which a runner may not have installed. */
function canRunMac(arch) {
  if (arch === process.arch) return true
  return arch === "x64" && spawnSync("arch", ["-x86_64", "/usr/bin/true"]).status === 0
}

/** An ad-hoc signature that does not verify is what macOS reports as "damaged" on arm64. */
function checkSignature(label, app) {
  const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", app], { encoding: "utf8" })
  check(`${label}: its signature verifies`, verify.status === 0, verify.stderr.trim() || "valid")
}

async function smokeMacApp(label, app, arch) {
  checkSignature(label, app)
  if (canRunMac(arch)) await smoke(label, bundleExecutable(app))
  else console.log(`- ${label}: not launched — this ${process.arch} runner cannot run ${arch}`)
}

try {
  if (only) {
    await smoke(basename(only), only)
  } else if (process.platform === "linux") {
    if (install) {
      const [deb] = artifacts(/\.deb$/u)
      if (!deb) throw new Error(`no .deb in ${out}`)
      execFileSync("sudo", ["apt-get", "install", "-y", "--no-install-recommends", deb], { stdio: "inherit" })
      // What the application menu runs: the Exec line of the entry the package installed.
      const files = execFileSync("dpkg", ["-L", "frizz-desktop"], { encoding: "utf8" }).split("\n")
      const entry = files.find((file) => file.startsWith("/usr/share/applications/") && file.endsWith(".desktop"))
      const exec = entry && /^Exec=("([^"]+)"|(\S+))/mu.exec(readFileSync(entry, "utf8"))
      const binary = exec?.[2] ?? exec?.[3]
      check("deb: installs an application menu entry", Boolean(binary), entry ? `${entry} → ${binary}` : "no .desktop file installed")
      // With the SUID sandbox helper the package installs — no --no-sandbox, as a user runs it.
      if (binary) await smoke(`deb (${basename(deb)})`, binary)
      // An AppImage cannot carry a setuid helper, so where unprivileged user namespaces are restricted
      // (Ubuntu 24.04 and later) it needs --no-sandbox; the release notes send Ubuntu to the .deb. This
      // checks it runs at all, unpacked in place of the FUSE mount a runner may not have.
      for (const image of artifacts(/\.AppImage$/u)) {
        await smoke(`AppImage (${basename(image)})`, image, ["--no-sandbox"], { APPIMAGE_EXTRACT_AND_RUN: "1" })
      }
    } else {
      await smoke("linux-unpacked", join(out, "linux-unpacked", "frizz-desktop"))
    }
  } else if (process.platform === "darwin") {
    if (install) {
      const dmgs = artifacts(/\.dmg$/u)
      if (!dmgs.length) throw new Error(`no .dmg in ${out}`)
      for (const dmg of dmgs) {
        const mount = mkdtempSync(join(tmpdir(), "frizz-desktop-dmg-"))
        execFileSync("hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-mountpoint", mount], { stdio: "inherit" })
        try {
          const app = readdirSync(mount).find((file) => file.endsWith(".app"))
          if (!app) throw new Error(`no .app in ${basename(dmg)}`)
          // The name Finder, Launchpad and /Applications show — and the one a later build must reuse to
          // replace this one rather than install beside it.
          check(`${basename(dmg)}: the bundle is Frizz.app`, app === "Frizz.app", app)
          await smokeMacApp(basename(dmg), join(mount, app), /-arm64\./u.test(dmg) ? "arm64" : "x64")
        } finally {
          execFileSync("hdiutil", ["detach", mount, "-force"], { stdio: "inherit" })
        }
      }
    } else {
      for (const [dir, arch] of [["mac-arm64", "arm64"], ["mac", "x64"]]) {
        const app = existsSync(join(out, dir)) && readdirSync(join(out, dir)).find((file) => file.endsWith(".app"))
        if (app) await smokeMacApp(`${dir}/${app}`, join(out, dir, app), arch)
      }
    }
  } else if (process.platform === "win32") {
    if (install) {
      const [setup] = artifacts(/-setup\.exe$/u)
      if (!setup) throw new Error(`no installer in ${out}`)
      // One-click, per-user, silent: what a double-click does, minus the window. A silent install does
      // not launch the app (installSection.nsh starts it only with --force-run).
      execFileSync(setup, ["/S"], { stdio: "inherit" })
      const programs = join(process.env.LOCALAPPDATA ?? "", "Programs")
      const dir = existsSync(programs) && readdirSync(programs).find((name) => existsSync(join(programs, name, "frizz-desktop.exe")))
      check("installer: installs the app per-user", Boolean(dir), dir ? join(programs, dir) : `nothing under ${programs}`)
      if (dir) await smoke(`installed (${basename(setup)})`, join(programs, dir, "frizz-desktop.exe"))
    } else {
      await smoke("win-unpacked", join(out, "win-unpacked", "frizz-desktop.exe"))
    }
  }
} catch (error) {
  check("smoke", false, error instanceof Error ? error.message : String(error))
} finally {
  server.close()
}

if (!results.length) check("smoke", false, "nothing was launched")
const failed = results.filter((result) => !result.ok).map((result) => result.name)
console.log(JSON.stringify({ ok: failed.length === 0, checks: results.length, failed }))
process.exit(failed.length ? 1 : 0)
