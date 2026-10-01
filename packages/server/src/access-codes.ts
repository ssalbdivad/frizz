import { randomBytes, timingSafeEqual, createHmac } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Single-use access codes, and the long-lived sessions they mint.
 *
 * The split is the whole point. Before this, one standing secret was printed at launch and traded for a
 * year-long cookie: every copy of it — scrollback, shell history, an email — stayed valid forever, and
 * it only rotated on the restart that is least convenient to perform. Separating the two fixes that:
 *
 *   CODE     single-use, short-lived, authorizes exactly ONE exchange. Safe to show on a screen.
 *   SESSION  what the code mints. Long-lived, signed, and independently revocable.
 *
 * A leaked code is worthless the moment it is used (or five minutes pass), and a leaked session can be
 * revoked without disturbing anything else. GitHub minting the session instead of a code is policy on
 * top of that split; per-device names and sign-out are built here.
 *
 * REVOCATION IS A DENYLIST, not a session table. A session still verifies from its own signature with
 * no lookup — that is what makes it cheap and restart-proof — and the directory holds only the ids an
 * operator has actually signed out, plus a label per device so the list means something. A board with
 * nothing revoked pays nothing.
 */

/** Long enough that guessing is hopeless, short enough that the QR stays a small version. */
const CODE_BYTES = 16
const SESSION_BYTES = 32
/** Short enough to read off a terminal and type back into `--sign-out`; still 2^48 of space. */
const SESSION_ID_BYTES = 6
export const DEFAULT_CODE_TTL_MS = 5 * 60_000
/** A photographed QR is a real vector, so codes expire on a human timescale, not a session one. */
export const DEFAULT_SESSION_TTL_MS = 365 * 24 * 60 * 60_000

export interface AccessCode {
  code: string
  createdAt: number
  expiresAt: number
}

interface StoredCode extends AccessCode {
  consumedAt?: number
}

export interface AccessStoreOptions {
  codeTtlMs?: number
  sessionTtlMs?: number
  /** Injectable so tests can advance time without sleeping. */
  now?: () => number
  /** Injectable so tests get deterministic values; production uses randomBytes. */
  randomToken?: (bytes: number) => string
  /**
   * HMAC key for sessions. Supply a PERSISTED one so sessions outlive a restart.
   *
   * Defaulting to a fresh random key means every restart silently signs out every device — and a
   * board restarts often (artifact updates, crashes, an ordinary ctrl-C), so in practice a "one year"
   * cookie lasted until the next one. Rotating this key is what revocation looks like.
   */
  signingKey?: Buffer
  /** Called when a code is successfully consumed, so a launcher can repaint its QR. */
  onConsumed?: (code: string) => void
  /** Where sign-outs and device labels live. In-memory by default, which forgets them on restart. */
  sessions?: SessionDirectory
}

export type RedeemResult =
  | { ok: true; session: string; expiresAt: number; id: string }
  | { ok: false; reason: "unknown" | "expired" | "already-used" }

/** One device that redeemed a link. `label` is for the human reading `frizz --sessions`. */
export interface SessionRecord {
  id: string
  label: string
  createdAt: number
  revokedAt?: number
}

/**
 * Where sign-outs are remembered.
 *
 * Injected rather than assumed to be a file, so the store can be driven in a test without a temp
 * directory and so a future backend (a tenant DB) needs no change here.
 */
export interface SessionDirectory {
  record(record: SessionRecord): void
  isRevoked(id: string): boolean
  list(): SessionRecord[]
  /** False when the id is unknown or already revoked, so a caller can say which. */
  revoke(id: string): boolean
  /** Returns how many live sessions were signed out. */
  revokeAll(): number
}

export function memorySessionDirectory(seed: SessionRecord[] = []): SessionDirectory {
  const records = new Map<string, SessionRecord>(seed.map((r) => [r.id, r]))
  return {
    record: (r) => void records.set(r.id, r),
    isRevoked: (id) => records.get(id)?.revokedAt !== undefined,
    // Reverse FIRST, then sort. Array.sort is stable, so two devices that redeemed in the same
    // millisecond — which two taps on one page reliably are — keep newest-inserted-first instead of
    // falling back to insertion order and reading as oldest first.
    list: () => [...records.values()].reverse().sort((a, b) => b.createdAt - a.createdAt),
    revoke(id) {
      const found = records.get(id)
      if (!found || found.revokedAt !== undefined) return false
      found.revokedAt = Date.now()
      return true
    },
    revokeAll() {
      let n = 0
      for (const r of records.values()) if (r.revokedAt === undefined) { r.revokedAt = Date.now(); n++ }
      return n
    },
  }
}

/**
 * Turn a User-Agent into something an operator can recognise in a list.
 *
 * Deliberately coarse. The label exists so "sign out the phone" is answerable, and a precise version
 * string would only make the list harder to scan — this is not analytics, and it is the only thing the
 * board ever records about a visitor's browser.
 */
export function describeDevice(userAgent: string | undefined): string {
  const ua = userAgent ?? ""
  if (!ua.trim()) return "unknown device"
  const os =
    /iPhone/i.test(ua) ? "iPhone"
    : /iPad/i.test(ua) ? "iPad"
    : /Android/i.test(ua) ? "Android"
    : /Mac OS X|Macintosh/i.test(ua) ? "macOS"
    : /Windows/i.test(ua) ? "Windows"
    : /Linux/i.test(ua) ? "Linux"
    : "unknown device"
  // Order matters: Edge and Chrome both claim Safari, and Chrome claims Safari too.
  const browser =
    /Edg\//i.test(ua) ? "Edge"
    : /OPR\/|Opera/i.test(ua) ? "Opera"
    : /Firefox\//i.test(ua) ? "Firefox"
    : /Chrome\//i.test(ua) ? "Chrome"
    : /Safari\//i.test(ua) ? "Safari"
    : ""
  return browser ? `${browser} on ${os}` : os
}

function defaultRandomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url")
}

/** Constant-time string compare; a plain `===` leaks a shared prefix to a patient attacker. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export class AccessStore {
  private readonly codes = new Map<string, StoredCode>()
  private readonly options: Required<Omit<AccessStoreOptions, "onConsumed" | "signingKey" | "sessions">> &
    Pick<AccessStoreOptions, "onConsumed">
  readonly sessions: SessionDirectory
  /** Signing key for sessions. Persisted by the caller; a fresh one signs every device out. */
  private readonly signingKey: Buffer

  constructor(options: AccessStoreOptions = {}) {
    this.signingKey = options.signingKey ?? randomBytes(32)
    this.sessions = options.sessions ?? memorySessionDirectory()
    this.options = {
      codeTtlMs: options.codeTtlMs ?? DEFAULT_CODE_TTL_MS,
      sessionTtlMs: options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
      now: options.now ?? Date.now,
      randomToken: options.randomToken ?? defaultRandomToken,
      onConsumed: options.onConsumed,
    }
  }

  /** Mint a code to show as a QR or a link. Minting does not invalidate codes already outstanding. */
  issue(): AccessCode {
    this.sweep()
    const now = this.options.now()
    const code: StoredCode = {
      code: this.options.randomToken(CODE_BYTES),
      createdAt: now,
      expiresAt: now + this.options.codeTtlMs,
    }
    this.codes.set(code.code, code)
    return { code: code.code, createdAt: code.createdAt, expiresAt: code.expiresAt }
  }

  /**
   * Trade a code for a session, at most once, ever.
   *
   * The consumed marker is set BEFORE anything else can observe success, and JS runs this method to
   * completion without interleaving, so two browsers racing the same code cannot both win. That
   * atomicity is what makes "single-use" true rather than aspirational — it is the first thing the
   * tests attack.
   */
  redeem(code: string | undefined, device?: string): RedeemResult {
    if (!code) return { ok: false, reason: "unknown" }
    // Classify BEFORE sweeping. Sweeping first deletes the very entry that distinguishes "this link
    // expired" from "no such link", and the difference is the whole diagnostic value of the result.
    // Look up by exact key, then re-compare in constant time: a Map hit already leaks nothing useful
    // (the attacker supplied the key), but the compare keeps the code path uniform for stored secrets.
    const stored = this.codes.get(code)
    if (!stored || !secretsMatch(stored.code, code)) return { ok: false, reason: "unknown" }
    const now = this.options.now()
    if (stored.consumedAt !== undefined) return { ok: false, reason: "already-used" }
    if (now >= stored.expiresAt) {
      this.sweep()
      return { ok: false, reason: "expired" }
    }
    stored.consumedAt = now
    this.sweep()
    this.options.onConsumed?.(code)
    const minted = this.mintSession(now)
    this.sessions.record({ id: minted.id, label: device ?? "unknown device", createdAt: now })
    return { ok: true, session: minted.session, expiresAt: now + this.options.sessionTtlMs, id: minted.id }
  }

  /**
   * A session is `<expiry>.<id>.<nonce>.<hmac>` — signed with a key the caller persists so it survives
   * a restart, and self-describing enough that a stale cookie is rejected without any lookup.
   *
   * The `id` is what makes ONE device signable-out. It is short because an operator types it into
   * `frizz --sign-out <id>`, and it is inside the signed payload so it cannot be swapped for another
   * device's. Rotating the key still revokes everything at once; this is the scalpel beside that axe.
   *
   * A session minted before ids existed has a two-part payload and still verifies — it simply has no id
   * to revoke individually. Upgrading must not sign every device out.
   */
  private mintSession(now: number): { session: string; id: string } {
    const expiresAt = now + this.options.sessionTtlMs
    const id = this.options.randomToken(SESSION_ID_BYTES)
    const nonce = this.options.randomToken(SESSION_BYTES)
    const payload = `${expiresAt}.${id}.${nonce}`
    return { session: `${payload}.${this.sign(payload)}`, id }
  }

  /** The id inside a session payload, or null for a legacy two-part one. */
  private static idOf(payload: string): string | null {
    const parts = payload.split(".")
    return parts.length >= 3 ? (parts[1] ?? null) : null
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.signingKey).update(payload).digest("base64url")
  }

  /** Is this cookie a session signed by this board's key, and still in date? */
  verifySession(session: string | undefined): boolean {
    if (!session) return false
    const cut = session.lastIndexOf(".")
    if (cut <= 0) return false
    const payload = session.slice(0, cut)
    const signature = session.slice(cut + 1)
    if (!secretsMatch(signature, this.sign(payload))) return false
    const expiresAt = Number(payload.slice(0, payload.indexOf(".")))
    if (!Number.isFinite(expiresAt) || this.options.now() >= expiresAt) return false
    // The signature proves the id was not tampered with, so the denylist can be trusted to name a real
    // device. Checked LAST: an expired or forged cookie should never reach the directory at all.
    const id = AccessStore.idOf(payload)
    return !(id && this.sessions.isRevoked(id))
  }

  /**
   * Sign out the device HOLDING this session — the "Sign out this device" row, not `--sign-out`.
   *
   * The id comes from the session itself, and only after its signature verifies, so the one thing this
   * can ever revoke is the credential the caller just proved it holds. There is deliberately no
   * parameter naming any other id: signing out SOMEONE ELSE stays loopback-only, because a stolen
   * session must not be able to evict the owner and keep the board.
   *
   * - `revoked`: the id is on the denylist now, so a surviving copy of this cookie is refused too.
   * - `legacy`: a session minted before ids existed verifies but has no id to revoke on its own. The
   *   caller can still clear the cookie; rotating the key remains the way to kill a copy of it.
   * - `no-session`: nothing valid was presented — absent, forged, expired, or already signed out.
   */
  signOutSession(session: string | undefined):
    | { result: "revoked"; id: string }
    | { result: "legacy" }
    | { result: "no-session" } {
    if (!session || !this.verifySession(session)) return { result: "no-session" }
    const id = AccessStore.idOf(session.slice(0, session.lastIndexOf(".")))
    if (!id) return { result: "legacy" }
    // The directory only knows ids it recorded, so a session minted while it was held in memory (a board
    // started without a persisted one) is unknown after a restart even though the key still verifies it.
    // Record it first, or revoke() refuses the unknown id and the sign-out silently does nothing.
    if (!this.sessions.revoke(id)) {
      this.sessions.record({ id, label: "unknown device", createdAt: this.options.now() })
      this.sessions.revoke(id)
    }
    return this.sessions.isRevoked(id) ? { result: "revoked", id } : { result: "no-session" }
  }

  /**
   * Drop codes past their expiry so a long-lived board does not accumulate them forever.
   *
   * A CONSUMED code is deliberately kept until that same expiry rather than deleted on use. Deleting it
   * immediately would make a replay indistinguishable from a typo — both "unknown" — and the difference
   * matters: "already-used" is the message that tells someone their link was used by somebody else.
   * It costs one small entry for at most the code TTL.
   */
  private sweep(): void {
    const now = this.options.now()
    for (const [key, stored] of this.codes) {
      if (now >= stored.expiresAt) this.codes.delete(key)
    }
  }

  /** Outstanding codes that could still be redeemed — neither consumed nor expired. */
  outstanding(): AccessCode[] {
    this.sweep()
    return [...this.codes.values()]
      .filter((stored) => stored.consumedAt === undefined)
      .map(({ code, createdAt, expiresAt }) => ({ code, createdAt, expiresAt }))
  }
}


/**
 * The session directory on disk, beside the signing key.
 *
 * A SIGN-OUT THAT DOES NOT SURVIVE A RESTART IS NOT A SIGN-OUT — and a board restarts often, on every
 * artifact update and every ordinary ctrl-C. So the denylist is written through on each change rather
 * than held in memory, and a lost phone stays signed out.
 *
 * Reads are served from memory: `isRevoked` runs on every single request, and hitting the filesystem
 * there would put a stat in the path of every page load and every socket frame.
 */
export function fileSessionDirectory(stateDir: string, now: () => number = Date.now): SessionDirectory {
  const path = join(stateDir, "sessions.json")
  let records: SessionRecord[] = []
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
    // A hand-edited or truncated file must not take the board down; an unreadable directory means no
    // remembered sign-outs, which is the same position a first run is in.
    if (Array.isArray(parsed)) {
      records = parsed.filter(
        (r): r is SessionRecord =>
          !!r && typeof (r as SessionRecord).id === "string" && typeof (r as SessionRecord).createdAt === "number"
      )
    }
  } catch {
    // Missing on first run, which is the ordinary path.
  }
  const inner = memorySessionDirectory(records)
  const flush = () => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      // Prune what can no longer matter: a revoked session past its own expiry is denied by the expiry
      // check alone, so keeping it would grow the file forever for nothing.
      writeFileSync(path, JSON.stringify(inner.list()), { mode: 0o600 })
    } catch (error) {
      // Best effort. Losing the write costs a remembered sign-out, not correctness of the live board.
      if (process.env.FRIZZ_DEBUG_SESSIONS) console.error("[sessions] flush failed:", error)
    }
  }
  return {
    record(r) { inner.record(r); flush() },
    isRevoked: (id) => inner.isRevoked(id),
    list: () => inner.list(),
    revoke(id) { const ok = inner.revoke(id); if (ok) flush(); return ok },
    revokeAll() { const n = inner.revokeAll(); if (n > 0) flush(); return n },
  }
}

/**
 * Load this board's session-signing key, creating it on first use.
 *
 * On disk at 0600 beside the project's other state, because the alternative — a key held only in
 * memory — makes every restart a silent sign-out of every device. Deleting this file is the
 * revocation story: it invalidates every outstanding session at once and the next start writes a
 * fresh one.
 */
export function loadOrCreateSessionKey(stateDir: string): Buffer {
  const path = join(stateDir, "session-key")
  try {
    const existing = readFileSync(path)
    // A truncated or empty file would silently produce a weak key; treat it as absent and rewrite.
    if (existing.byteLength >= 32) return existing
  } catch {
    // Missing on first run, which is the ordinary path.
  }
  const key = randomBytes(32)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, key, { mode: 0o600 })
  try {
    // writeFileSync's mode is ignored when the file already exists, so state it again.
    chmodSync(path, 0o600)
  } catch {
    // Best effort: a key readable only by this user is the goal, not a hard gate.
  }
  return key
}
