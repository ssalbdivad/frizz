#!/usr/bin/env nub
/**
 * Per-device sign-out, end to end, across processes.
 *
 * The store's unit tests prove the denylist. They cannot prove the thing that matters: that a cookie
 * held by a real browser stops working after an operator runs `frizz --sign-out` in a different
 * process, and that the sign-out survives the restart a board performs constantly. Three programs have
 * to agree — the launcher's CLI, the running board's supervisor, and the directory on disk — and the
 * seams between them are the whole feature.
 *
 * Runs the BUILT artifact, because that is what an operator has.
 */
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.SESSIONS_PORT ?? 47951);
const ORIGIN = "https://board.example.com";
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** RAW http: `fetch` silently drops a Host header, so every probe would arrive as loopback. */
const ask = (path, { host = "board.example.com", cookie, ua, method = "GET", origin } = {}) =>
  new Promise((resolve, reject) => {
    const headers = { host };
    if (cookie) headers.cookie = cookie;
    if (ua) headers["user-agent"] = ua;
    if (origin) headers.origin = origin;
    const req = httpRequest({ host: "127.0.0.1", port: PORT, path, method, headers, setHost: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode, setCookie: res.headers["set-cookie"] ?? [], body: text }));
    });
    req.on("error", reject);
    req.end();
  });
const json = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

const home = mkdtempSync(join(tmpdir(), "frizz-sessions-e2e-"));
let board = null;
const startBoard = async () => {
  const child = spawn(process.execPath, ["dist/frizz.js", "--public-origin", ORIGIN, "--port", String(PORT), "--no-app"], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, FRIZZ_WAKERS_OFF: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const code = await new Promise((resolve, reject) => {
    let buf = "";
    // Kill the launcher on the way out: `board` is only assigned once this resolves, so a board that
    // never came up would otherwise outlive the run with nothing left holding its pid.
    const fail = (why) => { clearTimeout(timer); try { child.kill("SIGTERM"); } catch { /* already gone */ } reject(new Error(`${why}:\n${buf.slice(0, 400)}`)); };
    const timer = setTimeout(() => fail("the board never printed a link"), 90_000);
    child.once("exit", (code) => fail(`the board exited (${code}) before printing a link`));
    const onData = (d) => {
      buf += d;
      const m = buf.match(/frizz_code=([A-Za-z0-9_-]+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
  });
  return { child, code };
};

/** Run the launcher's own CLI, the way an operator does. */
const cli = (...args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/frizz.js", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, FRIZZ_WAKERS_OFF: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out }));
  });

const redeem = async (code, ua) => {
  const res = await ask(`/?frizz_code=${encodeURIComponent(code)}`, { ua });
  return res.setCookie.map((c) => c.split(";")[0]).join("; ");
};

try {
  const first = await startBoard();
  board = first.child;
  check("a board is running behind a public origin", true, ORIGIN);

  // Two devices, so the test can prove signing out one leaves the other alone.
  const phone = await redeem(first.code, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Safari/604.1");
  check("a phone redeems a link and gets a session", phone.includes("frizz_session="));

  const second = await cli("--link");
  const laptopCode = (second.out.match(/frizz_code=([A-Za-z0-9_-]+)/) ?? [])[1];
  const laptop = laptopCode ? await redeem(laptopCode, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537.36") : "";
  check("a second device redeems its own link", laptop.includes("frizz_session="), laptopCode ? "" : second.out.slice(0, 120));

  check("both devices reach the board", (await ask("/", { cookie: phone })).status === 200 && (await ask("/", { cookie: laptop })).status === 200);

  // THE CONTROL PLANE IS GATED TOO. A request through the tunnel with no session used to reach
  // /_frizz/control/* straight past the session gate — restart, update-restart and status all answered
  // to anyone who set the right Host and Origin, which a non-browser client does freely.
  const bareRestart = await ask("/_frizz/control/restart", { method: "POST", origin: ORIGIN });
  check("a no-cookie restart through the tunnel is refused", bareRestart.status === 401 && bareRestart.body === "", `HTTP ${bareRestart.status} ${bareRestart.body.slice(0, 80)}`);
  const bareStatus = await ask("/_frizz/control/status", { origin: ORIGIN });
  check("and so is a no-cookie status read", bareStatus.status === 401 && bareStatus.body === "", `HTTP ${bareStatus.status}`);
  const afterBare = json((await ask("/_frizz/control/status", { cookie: laptop, origin: ORIGIN })).body);
  check("the refused restart did not start one", afterBare?.state === "ready", JSON.stringify(afterBare ?? {}).slice(0, 80));

  // The operator's view.
  const listed = await cli("--sessions");
  check("--sessions names both devices by what they are", /iPhone/.test(listed.out) && /Chrome on macOS/.test(listed.out), listed.out.trim().split("\n")[0] ?? "");

  const phoneId = (listed.out.match(/^\s*(\S+)\s+Safari on iPhone/m) ?? [])[1];
  check("the list gives an id to sign out with", !!phoneId, phoneId ?? listed.out.slice(0, 160));

  // THE FEATURE.
  const out = await cli("--sign-out", phoneId ?? "missing");
  check("--sign-out reports it signed the phone out", out.code === 0 && /Signed out/.test(out.out), out.out.trim());
  check("the signed-out phone is refused", (await ask("/", { cookie: phone })).status === 401);
  check("and the laptop is untouched", (await ask("/", { cookie: laptop })).status === 200);

  // A sign-out that a restart forgets is not a sign-out.
  board.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 3000));
  const again = await startBoard();
  board = again.child;
  check("the phone is STILL signed out after a restart", (await ask("/", { cookie: phone })).status === 401);
  check("and the laptop still works after a restart", (await ask("/", { cookie: laptop })).status === 200);

  // A STOLEN SESSION MUST NOT BE ABLE TO EVICT THE OWNER. The endpoint is loopback-only for the same
  // reason minting is: being at the machine — or on it over ssh — is the proof it requires.
  const remoteList = await ask("/_frizz/control/sessions", { cookie: laptop });
  check("a remote visitor cannot list the signed-in devices", remoteList.status === 403, `HTTP ${remoteList.status}`);

  const all = await cli("--sign-out", "all");
  check("--sign-out all kicks what is left", all.code === 0 && /Signed out 1 device/.test(all.out), all.out.trim());
  check("the laptop is now refused too", (await ask("/", { cookie: laptop })).status === 401);
} catch (error) {
  check("harness completed", false, error instanceof Error ? error.message : String(error));
} finally {
  try { board?.kill("SIGTERM"); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 2000));
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
