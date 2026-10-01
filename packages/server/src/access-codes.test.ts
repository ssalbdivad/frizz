import assert from "node:assert/strict"
import test from "node:test"
import { createHmac, randomBytes } from "node:crypto"
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AccessStore,
  DEFAULT_CODE_TTL_MS,
  describeDevice,
  fileSessionDirectory,
  loadOrCreateSessionKey,
  secretsMatch,
} from "./access-codes.ts"

/** A clock the test drives, so expiry is exercised without sleeping through it. */
function clock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => { now += ms } }
}

function counter() {
  let n = 0
  return () => `token-${++n}`
}

test("a code works exactly once, and the second attempt says so", () => {
  // The property the whole design rests on. If a code can be spent twice, "single-use" is a comment.
  const store = new AccessStore({ randomToken: counter() })
  const { code } = store.issue()

  const first = store.redeem(code)
  assert.equal(first.ok, true)
  assert.ok(first.ok && first.session.length > 0)

  const second = store.redeem(code)
  assert.deepEqual(second, { ok: false, reason: "already-used" })

  // Consumed codes stop being offered, but are REMEMBERED so a replay is distinguishable from a typo.
  assert.deepEqual(store.outstanding(), [])
  assert.deepEqual(store.redeem("token-never-issued"), { ok: false, reason: "unknown" })
})

test("two redemptions of one code cannot both win", () => {
  // The race a naive check-then-set loses. Redeem is synchronous and marks consumed before returning,
  // so interleaving is impossible — this pins that rather than trusting it.
  const store = new AccessStore({ randomToken: counter() })
  const { code } = store.issue()
  const results = [store.redeem(code), store.redeem(code), store.redeem(code)]
  assert.equal(results.filter((r) => r.ok).length, 1, "exactly one redemption may succeed")
})

test("codes expire on a human timescale, because a photographed QR is a real vector", () => {
  const time = clock()
  const store = new AccessStore({ now: time.now, randomToken: counter() })
  const { code, expiresAt } = store.issue()
  assert.equal(expiresAt - time.now(), DEFAULT_CODE_TTL_MS)

  time.advance(DEFAULT_CODE_TTL_MS - 1)
  assert.equal(store.outstanding().length, 1, "still redeemable one millisecond before expiry")

  time.advance(2)
  assert.deepEqual(store.redeem(code), { ok: false, reason: "expired" })
  assert.deepEqual(store.outstanding(), [], "expired codes are swept, not left to accumulate")
})

test("issuing a code does not invalidate one already outstanding", () => {
  // Pressing the key twice, or two people asking at once, must not silently break the first QR.
  const store = new AccessStore({ randomToken: counter() })
  const first = store.issue()
  const second = store.issue()
  assert.notEqual(first.code, second.code)
  assert.equal(store.outstanding().length, 2)
  assert.equal(store.redeem(first.code).ok, true)
  assert.equal(store.redeem(second.code).ok, true)
})

test("a session verifies, expires on its own terms, and dies when the key rotates", () => {
  const time = clock()
  const store = new AccessStore({ now: time.now, randomToken: counter(), sessionTtlMs: 10_000 })
  const redeemed = store.redeem(store.issue().code)
  assert.ok(redeemed.ok)
  const session = redeemed.session

  assert.equal(store.verifySession(session), true)
  time.advance(10_001)
  assert.equal(store.verifySession(session), false, "a session past its own expiry is refused")

  // A board with a DIFFERENT key rejects it — that is what rotating the key means, and it is the
  // revocation story.
  const rotated = new AccessStore({ now: time.now, randomToken: counter(), signingKey: Buffer.alloc(32, 9) })
  assert.equal(rotated.verifySession(session), false)
})

test("a session SURVIVES a restart when the signing key is persisted", () => {
  // The bug this pins cost a real sign-out: the key defaulted to a fresh random per process, so every
  // artifact update, crash or ctrl-C silently signed out every device — making a nominally year-long
  // cookie last only until the next restart. The board must load the same key back.
  const key = randomBytes(32)
  const first = new AccessStore({ signingKey: key, randomToken: counter() })
  const redeemed = first.redeem(first.issue().code)
  assert.ok(redeemed.ok)

  const afterRestart = new AccessStore({ signingKey: key, randomToken: counter() })
  assert.equal(afterRestart.verifySession(redeemed.session), true, "the phone stays signed in")
})

test("the session key is persisted at 0600 and reloaded, not regenerated", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-session-key-"))
  const first = loadOrCreateSessionKey(dir)
  const second = loadOrCreateSessionKey(dir)
  assert.deepEqual(second, first, "a second start must reuse the key, or every restart signs out")
  assert.equal(first.byteLength, 32)
  // The mode bits only — everything above this line is asserted on every platform. Windows has no
  // POSIX permission bits: NTFS access is an ACL, `fs.chmod` there sets nothing but the read-only
  // flag, and node reports 0666 for any writable file. The key is still written with mode 0o600, which
  // is simply inert there; restricting it would take an icacls ACL, which frizz does not attempt.
  if (process.platform !== "win32") {
    assert.equal(statSync(join(dir, "session-key")).mode & 0o777, 0o600, "a world-readable key is a forgeable session")
  }
  rmSync(dir, { recursive: true, force: true })
})

test("a truncated key file is replaced rather than used", () => {
  // A short read would silently weaken every signature; treat it as absent.
  const dir = mkdtempSync(join(tmpdir(), "frizz-session-key-"))
  writeFileSync(join(dir, "session-key"), Buffer.alloc(4))
  const key = loadOrCreateSessionKey(dir)
  assert.equal(key.byteLength, 32)
  rmSync(dir, { recursive: true, force: true })
})

test("a forged or tampered session is refused", () => {
  const store = new AccessStore({ randomToken: counter() })
  const redeemed = store.redeem(store.issue().code)
  assert.ok(redeemed.ok)
  const session = redeemed.session
  const [expiry, nonce, signature] = session.split(".")

  for (const forged of [
    undefined,
    "",
    "garbage",
    session.slice(0, -1),
    `${expiry}.${nonce}.${"A".repeat(signature!.length)}`,
    // The interesting one: push the expiry far out and keep the original signature.
    `${Number(expiry) + 10_000_000}.${nonce}.${signature}`,
  ]) {
    assert.equal(store.verifySession(forged), false, `accepted a forged session: ${String(forged)}`)
  }
})

test("consumption notifies, so a launcher can repaint a spent QR", () => {
  const seen: string[] = []
  const store = new AccessStore({ randomToken: counter(), onConsumed: (code) => seen.push(code) })
  const { code } = store.issue()
  store.redeem(code)
  store.redeem(code)
  assert.deepEqual(seen, [code], "fires on the successful redemption only")
})

test("secret comparison is length-safe and constant-time", () => {
  assert.equal(secretsMatch("abc", "abc"), true)
  assert.equal(secretsMatch("abc", "abd"), false)
  assert.equal(secretsMatch("abc", "abcd"), false, "different lengths must not throw")
  assert.equal(secretsMatch("", ""), true)
})

test("a redeemed session can be signed out on its own, without touching the others", () => {
  // The point of the whole id: losing a phone must not sign out the laptop. Before this, the only
  // revocation was rotating the key, which kicks every device the operator owns.
  const store = new AccessStore()
  const phone = store.redeem(store.issue().code, "iPhone")
  const laptop = store.redeem(store.issue().code, "Chrome on macOS")
  assert.ok(phone.ok && laptop.ok)
  assert.equal(store.verifySession(phone.session), true)

  assert.equal(store.sessions.revoke(phone.id), true)
  assert.equal(store.verifySession(phone.session), false, "the signed-out phone still works")
  assert.equal(store.verifySession(laptop.session), true, "signing out the phone kicked the laptop")
})

test("signing out a device twice, or one that never existed, is reported rather than silently ignored", () => {
  const store = new AccessStore()
  const only = store.redeem(store.issue().code, "iPhone")
  assert.ok(only.ok)
  assert.equal(store.sessions.revoke(only.id), true)
  assert.equal(store.sessions.revoke(only.id), false, "a second sign-out claimed to do something")
  assert.equal(store.sessions.revoke("no-such-id"), false)
})

test("sign out everywhere reports how many devices it actually kicked", () => {
  const store = new AccessStore()
  const a = store.redeem(store.issue().code, "iPhone")
  const b = store.redeem(store.issue().code, "Firefox on Linux")
  assert.ok(a.ok && b.ok)
  assert.equal(store.sessions.revokeAll(), 2)
  assert.equal(store.sessions.revokeAll(), 0, "already-revoked devices were counted again")
  assert.equal(store.verifySession(a.session), false)
  assert.equal(store.verifySession(b.session), false)
})

test("the device list names what redeemed each link, newest first", () => {
  const store = new AccessStore()
  store.redeem(store.issue().code, "iPhone")
  store.redeem(store.issue().code, "Chrome on macOS")
  const listed = store.sessions.list()
  assert.deepEqual(listed.map((r) => r.label), ["Chrome on macOS", "iPhone"])
})

test("a session id cannot be swapped for another device's — the signature covers it", () => {
  // Otherwise revoking a phone would be undone by editing one field of the cookie.
  const store = new AccessStore()
  const phone = store.redeem(store.issue().code, "iPhone")
  const laptop = store.redeem(store.issue().code, "macOS")
  assert.ok(phone.ok && laptop.ok)
  store.sessions.revoke(phone.id);
  // Graft the laptop's (live) id into the phone's cookie.
  const [exp, , nonce, sig] = phone.session.split(".")
  assert.equal(store.verifySession(`${exp}.${laptop.id}.${nonce}.${sig}`), false)
})

test("a session minted before ids existed still works, so upgrading signs nobody out", () => {
  // Legacy payload is `<expiry>.<nonce>`; it has no id, so it cannot be revoked individually — but it
  // must not be rejected outright, or every device is kicked by the upgrade that added this feature.
  const key = Buffer.alloc(32, 7)
  const store = new AccessStore({ signingKey: key })
  const expiry = Date.now() + 60_000
  const payload = `${expiry}.legacy-nonce`
  const sig = createHmac("sha256", key).update(payload).digest("base64url")
  assert.equal(store.verifySession(`${payload}.${sig}`), true)
})

test("a device label is coarse on purpose, and never invents one", () => {
  assert.equal(describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Safari/604.1"), "Safari on iPhone")
  assert.equal(describeDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36"), "Chrome on macOS")
  assert.equal(describeDevice("Mozilla/5.0 (Windows NT 10.0) Edg/120"), "Edge on Windows")
  assert.equal(describeDevice(undefined), "unknown device")
  assert.equal(describeDevice("   "), "unknown device")
})

test("a sign-out survives a restart, because a forgotten one is not a sign-out", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-sessions-"))
  try {
    const key = Buffer.alloc(32, 3)
    const first = new AccessStore({ signingKey: key, sessions: fileSessionDirectory(dir) })
    const phone = first.redeem(first.issue().code, "iPhone")
    assert.ok(phone.ok)
    assert.equal(first.sessions.revoke(phone.id), true)

    // A whole new board, same state directory and same key — which is exactly what a restart is.
    const second = new AccessStore({ signingKey: key, sessions: fileSessionDirectory(dir) })
    assert.equal(second.verifySession(phone.session), false, "the restart forgot the sign-out")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an unreadable session directory leaves the board running rather than taking it down", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-sessions-bad-"))
  try {
    writeFileSync(join(dir, "sessions.json"), "{ this is not json")
    const store = new AccessStore({ sessions: fileSessionDirectory(dir) })
    const ok = store.redeem(store.issue().code, "iPhone")
    assert.ok(ok.ok)
    assert.equal(store.verifySession(ok.session), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a session signs ITSELF out: its own id is revoked and persisted, and no other device is touched", () => {
  // The phone's "Sign out this device". The id is taken from the verified session, so the only
  // credential it can end is the one presented — the laptop beside it must not notice.
  const dir = mkdtempSync(join(tmpdir(), "frizz-sign-self-out-"))
  try {
    const store = new AccessStore({ sessions: fileSessionDirectory(dir) })
    const phone = store.redeem(store.issue().code, "Safari on iPhone")
    const laptop = store.redeem(store.issue().code, "Chrome on macOS")
    assert.ok(phone.ok && laptop.ok)

    assert.deepEqual(store.signOutSession(phone.session), { result: "revoked", id: phone.id })
    assert.equal(store.verifySession(phone.session), false, "the phone still works after signing itself out")
    assert.equal(store.verifySession(laptop.session), true, "signing the phone out kicked the laptop")
    // On disk, where a restart and `frizz --sessions` both read it.
    assert.equal(fileSessionDirectory(dir).isRevoked(phone.id), true)
    assert.equal(fileSessionDirectory(dir).isRevoked(laptop.id), false)

    // Once dead, presenting it again ends nothing.
    assert.deepEqual(store.signOutSession(phone.session), { result: "no-session" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("signing out needs a VALID session: nothing, a forgery, or a grafted id revokes nothing", () => {
  const store = new AccessStore()
  const phone = store.redeem(store.issue().code, "iPhone")
  const laptop = store.redeem(store.issue().code, "macOS")
  assert.ok(phone.ok && laptop.ok)
  assert.deepEqual(store.signOutSession(undefined), { result: "no-session" })
  assert.deepEqual(store.signOutSession(""), { result: "no-session" })
  // Graft the laptop's id into the phone's cookie: the signature no longer matches, so the laptop's id
  // never reaches the directory. This is what stops one device naming another's id.
  const [exp, , nonce, sig] = phone.session.split(".")
  assert.deepEqual(store.signOutSession(`${exp}.${laptop.id}.${nonce}.${sig}`), { result: "no-session" })
  assert.equal(store.verifySession(laptop.session), true)
  assert.equal(store.verifySession(phone.session), true)
  assert.deepEqual(store.sessions.list().filter((r) => r.revokedAt !== undefined), [])
})

test("a session the directory never recorded still signs itself out, instead of silently not", () => {
  // A board whose directory was in memory forgets its records on restart while a persisted key keeps
  // verifying the session. revoke() refuses unknown ids, so without recording first this reported
  // success and changed nothing.
  const key = Buffer.alloc(32, 9)
  const before = new AccessStore({ signingKey: key })
  const phone = before.redeem(before.issue().code, "iPhone")
  assert.ok(phone.ok)
  const after = new AccessStore({ signingKey: key })
  assert.equal(after.verifySession(phone.session), true)
  assert.deepEqual(after.signOutSession(phone.session), { result: "revoked", id: phone.id })
  assert.equal(after.verifySession(phone.session), false)
})

test("a pre-id session cannot be put on the denylist, and says so rather than claiming it was", () => {
  const key = Buffer.alloc(32, 7)
  const store = new AccessStore({ signingKey: key })
  const payload = `${Date.now() + 60_000}.legacy-nonce`
  const legacy = `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`
  assert.deepEqual(store.signOutSession(legacy), { result: "legacy" })
  assert.deepEqual(store.sessions.list(), [])
})
