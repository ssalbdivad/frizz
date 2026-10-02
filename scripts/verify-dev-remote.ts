// Can a phone reach a `nub run dev` board? Boots `src/dev.ts` on a spare port with throwaway Frizz
// state (XDG_* pointed at a temp dir, so the real board, its saved setup and its sessions are never
// touched), sets remote access through the same loopback route Settings uses, then loads the board the
// way a phone does: over HTTPS at the public name, through a TLS proxy that forwards to the board with
// the public Host intact, in a headless browser that resolves the name to that proxy. Then restarts the
// dev board and checks the setup and the phone's session both survive it.
//
//   nub scripts/verify-dev-remote.ts [--keep]   (from a worktree: it boots Vite from this checkout)
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { createServer as createHttpsServer } from "node:https";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer";

const root = resolve(import.meta.dirname, "..");
const PORT = 9471;
const NAME = "board.frizz-verify.test";
const state = mkdtempSync(join(tmpdir(), "frizz-dev-remote-"));
const env = {
  ...process.env,
  XDG_DATA_HOME: join(state, "data"),
  XDG_STATE_HOME: join(state, "state"),
  XDG_CONFIG_HOME: join(state, "config"),
  XDG_CACHE_HOME: join(state, "cache"),
};
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

function boot(): Promise<{ child: ChildProcess; log: () => string }> {
  let log = "";
  const child = spawn("nub", [join(root, "src/dev.ts"), "--port", String(PORT)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", (c) => { log += c; });
  child.stderr!.on("data", (c) => { log += c; });
  return new Promise((ready, fail) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (log.includes("[frizz] ready at")) {
        // The attach step prints its own line right after; give it a beat.
        setTimeout(() => { clearInterval(tick); ready({ child, log: () => log }); }, 1500);
      } else if (child.exitCode !== null || Date.now() - started > 240_000) {
        clearInterval(tick);
        fail(new Error(`dev board did not come up:\n${log}`));
      }
    }, 500);
  });
}
const stop = (child: ChildProcess) => new Promise<void>((done) => { child.once("exit", () => done()); child.kill("SIGINT"); });

const local = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, init.method === "POST"
    ? { ...init, headers: { origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json", ...(init.headers ?? {}) } }
    : { ...init, headers: { "sec-fetch-site": "same-origin", ...(init.headers ?? {}) } });

// A self-signed TLS front door that forwards to the board with the public Host intact — what the
// relay, cloudflared or a proxy does in front of a real board.
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${NAME}`,
  "-keyout", join(state, "key.pem"), "-out", join(state, "cert.pem")], { stdio: "ignore" });
const front = createHttpsServer({ key: readFileSync(join(state, "key.pem")), cert: readFileSync(join(state, "cert.pem")) }, (req, res) => {
  const upstream = request({ host: "127.0.0.1", port: PORT, method: req.method, path: req.url, headers: req.headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(upstream);
});
// Websockets too — the board socket and Vite's HMR — as the relay and cloudflared carry them.
front.on("upgrade", (req, socket, head) => {
  const upstream = connect(PORT, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});
await new Promise<void>((r) => front.listen(0, "127.0.0.1", () => r()));
const frontPort = (front.address() as { port: number }).port;

let board = await boot();
const browser = await puppeteer.launch({
  headless: true,
  acceptInsecureCerts: true,
  args: [`--host-resolver-rules=MAP ${NAME} 127.0.0.1:${frontPort}`],
});
try {
  const before = await (await local("/_frizz/control/remote")).json() as { current: { kind: string } };
  check(before.current.kind === "off", "a fresh dev board offers remote access, starting off");

  const applied = await (await local("/_frizz/control/remote", { method: "POST", body: JSON.stringify({ kind: "other", origin: `https://${NAME}` }) })).json() as { current: { origin?: string }; link?: { url: string } };
  check(applied.current.origin === `https://${NAME}` && !!applied.link?.url, "setting it from this machine returns a sign-in link");

  const phone = await browser.newPage();
  const errors: string[] = [];
  phone.on("pageerror", (e) => errors.push(String(e)));
  await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const refused = await phone.goto(`https://${NAME}/`, { waitUntil: "domcontentloaded" });
  check(refused?.status() === 401, "the public name refuses a phone with no session");
  await phone.goto(applied.link!.url, { waitUntil: "networkidle2", timeout: 120_000 });
  await phone.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0, { timeout: 60_000 });
  check(true, "the sign-in link opens the dev board on the phone");
  await phone.screenshot({ path: join(state, "phone.png") });
  const remoteFromPhone = await phone.evaluate(async () => (await fetch("/_frizz/control/remote")).status);
  check(remoteFromPhone === 403, "the phone cannot read or change remote access");
  check(errors.length === 0, `no page errors on the phone${errors.length ? `: ${errors.join(" | ")}` : ""}`);

  // Hot reload on the phone: Vite's socket rides the public name like everything else.
  const phonePage = join(root, "packages/web/src/components/PhonePage.tsx");
  const original = readFileSync(phonePage, "utf8");
  const label = ': "All projects"';
  if (!original.includes(label)) throw new Error(`${phonePage} no longer titles the view ${label}`);
  try {
    await phone.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
    writeFileSync(phonePage, original.replace(label, ': "All projects (hot)"'));
    await phone.waitForFunction(() => document.body.innerText.includes("All projects (hot)"), { timeout: 30_000 });
    const reloaded = !(await phone.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload));
    check(!reloaded, "a web edit hot-reloads on the phone, in place");
  } catch {
    check(false, "a web edit hot-reloads on the phone, in place");
  } finally {
    writeFileSync(phonePage, original);
  }

  // Restart the dev board: the setup comes back on its own, and the phone stays signed in.
  await stop(board.child);
  board = await boot();
  check(board.log().includes(`reachable at https://${NAME}`), "a restarted dev board serves the saved setup");
  const again = await phone.goto(`https://${NAME}/`, { waitUntil: "domcontentloaded" });
  check(again?.status() === 200, "the phone's session survives the restart");

  await local("/_frizz/control/remote", { method: "POST", body: JSON.stringify({ kind: "off" }) });
  const off = await phone.goto(`https://${NAME}/`, { waitUntil: "domcontentloaded" });
  check(off?.status() !== 200, "turning it off closes the public name");
  console.log(`phone screenshot: ${join(state, "phone.png")}`);
} finally {
  await browser.close();
  await stop(board.child);
  front.close();
}
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed; state kept at ${state}`);
  process.exit(1);
}
if (process.argv.includes("--keep")) console.log(`state kept at ${state}`);
else rmSync(state, { recursive: true, force: true });
