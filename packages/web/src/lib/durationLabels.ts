// THE HOUSE DURATION GRAMMAR — one stylization, every surface (maintainer 2026-08-31: `"40 minutes" ->
// "40m"` / `2hr 35m` / "Use this stylization everywhere. EVERYWHERE", then, hours corrected the same
// evening: "h is better than hr").
//
//   ms · s · m · h · d · w · mo · y
//
// The unit is a SUFFIX, glued to the number with no space (`40m`, never `40 min`), and a compound
// reading joins two of them with one space (`2h 35m`). Every unit is ONE letter except months, which
// are `mo` because a bare `m` is already minutes. Hours are `h` and NOT the `hr` the instruction above
// spells them with — that is the correction, and it also puts the grammar back on what the runtime
// slot has spelled since the 2026-08-08 `smhdw` spec.
//
// This replaced FIVE vocabularies that had drifted apart surface by surface — spelled-out `128 min`
// and `2 hr 8 min` here, `12 minutes` / `3 hours` in the rail's rest column, `1hr 5m` on the child-op
// row, `2 weeks ago` on the GitHub cards, against the runtime slot's `1h 17m`. Each was defensible
// alone and the set was not: the same span read five ways depending on which row you looked at. If you
// add a duration reading, it uses this grammar; if a surface seems to need its own, it does not.
//
// What is NOT unified is the LADDER — which units a given reading climbs to, and how much precision it
// keeps. That is per-surface behaviour with its own reasons, documented on each formatter below: a
// countdown pads and ticks, the runtime slot drops seconds past a minute, a tool call keeps them.
//
// A ladder DOES move for one reason: when the compact spelling creates an ambiguity the spelled-out one
// was hiding. A flat-minutes reading was safe as `128 min` and is not as `128m` — on a petite-caps meta
// line that renders `128M`, which reads as a count. The fix is never to spell the unit back out; it is
// the next rung up (`2h 8m`), which is shorter, unambiguous, and the shape of the maintainer's own
// example. Two formatters gained a rung on 2026-08-31 for exactly that: hours on formatToolDuration,
// days on formatElapsedMinutes.

// A tool call's own duration, on the card's meta line: `<1ms`, `450ms`, `2.3s`, `41s`, `9m 12s`,
// `2h 8m`. It keeps SECONDS beside minutes where the runtime slot drops them — a Bash call is a thing
// you watch finish, and 12 seconds either way is the difference between "instant" and "slow".
//
// It CLIMBS TO HOURS, and that rung is load-bearing rather than tidy. This line is drawn in
// petite-caps, where a lowercase unit renders as a small capital — so a flat-minutes reading of a
// two-hour call rendered `DONE · 128M`, which reads as a COUNT, not a duration (the reason this file
// spelled its units out at all before the house grammar arrived; see `tool-duration-fixture.tsx`,
// which exists to draw exactly this span). Past an hour the seconds are noise anyway, so the reading
// hands the resolution to the next unit down and the ambiguity goes with it.
export function formatToolDuration(ms: number): string {
  if (ms < 1) return "<1ms"
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${ms < 10_000 ? (ms / 1_000).toFixed(1) : Math.round(ms / 1_000)}s`
  const mins = Math.floor(ms / 60_000)
  if (mins >= 60) return mins % 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${Math.floor(mins / 60)}h`
  const secs = Math.round((ms % 60_000) / 1_000)
  return secs ? `${mins}m ${secs}s` : `${mins}m`
}

// `just now` · `40m` · `2h 35m` · `3d 4h`. The DAY rung is the same defence the hour rung gives
// formatToolDuration above: without it a background shell alive for a week read `169h 12m`, a number
// nobody parses as a week. Two units, and the smaller one drops when it is zero.
export function formatElapsedMinutes(minutes: number): string {
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
}

// COMPACT elapsed for the dense child-op row: "38s", "12m", "1h 5m". The maintainer specified this row
// on 2026-07-28 and spelled its hours `1hr`; the 2026-08-31 grammar single-letters them, and nothing
// else about the reading moved.
//
// Sub-minute resolves to SECONDS rather than the "just now" the recency formatters use: a child that
// has been working 38 seconds is meaningfully different from one at 5 seconds, and this reading exists
// precisely to answer "how long has this been going".
export function formatCompactElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ""
  const totalSeconds = Math.floor(ms / 1_000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`
}

// The BOTTOM RUNTIME SLOT's clock: `42s`, `2m`, `1h 17m`, `3d 4h`, `2w 3d` (maintainer 2026-08-08:
// `"2m" "1h 17m" etc (smhdw)`). At most TWO units, and the ladder runs all the way to weeks because
// that row times a live stretch of work whose length nobody bounds. The 2026-08-31 sweep left this
// reading exactly as it was and spread it to every other surface.
//
// SECONDS never appear beside another unit. They used to — the slot read `${m}m ${ss}s`, so a run that
// crossed an hour rendered `120m 00s`: two units of false precision, the larger one in the wrong scale,
// and wide enough that `828m 49s` once pushed its own minutes outside the panel. Past a minute the
// second-hand digits are noise, so the reading drops them; past an hour the next unit down carries the
// resolution instead. A zero remainder is dropped too — `2h`, not `2h 0m`.
//
// Distinct from formatCompactElapsed above only in its LADDER — this one climbs past hours to days and
// weeks, that one stops at hours. The spelling is shared, so neither can restyle the other.
export function formatRuntimeElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ""
  const seconds = Math.floor(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
  const weeks = Math.floor(days / 7)
  return days % 7 ? `${weeks}w ${days % 7}d` : `${weeks}w`
}

/** Compact elapsed since an ISO instant, measured against an injectable clock so a live tick drives it. */
export function compactElapsedSince(startedAt: string | undefined, nowMs = Date.now()): string {
  if (!startedAt) return ""
  const started = Date.parse(startedAt)
  if (!Number.isFinite(started)) return ""
  return formatCompactElapsed(nowMs - started)
}

export function formatFixedDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ""
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return "<1m"
  return formatElapsedMinutes(mins)
}

// The snooze card's COUNTDOWN — time REMAINING until a wall-clock instant, ticking down live. Same
// house grammar and same at-most-TWO-units rule as formatRuntimeElapsed above, but it deliberately
// departs from that formatter in two ways, both because this is a clock face rather than a duration
// label:
//   • the trailing sub-day unit is zero-PADDED and never dropped ("3h 05m", "12m 05s", never "3h") —
//     a countdown that loses a unit or a digit as it crosses a boundary visibly jumps width mid-tick,
//     and the steady two-unit shape is what reads as counting rather than as a restated duration;
//   • seconds survive up to an hour (formatRuntimeElapsed drops them past a minute), because a ticking
//     seconds digit is the whole difference between a countdown and a caption.
// Above a day the trailing unit goes unpadded ("2d 3h", "1w 2d") — nothing ticks at that scale, so the
// padding would read as a leading zero on prose.
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  const pad = (value: number) => String(value).padStart(2, "0")
  const seconds = Math.ceil(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${pad(minutes % 60)}m`
  const days = Math.floor(hours / 24)
  if (days < 7) return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
  const weeks = Math.floor(days / 7)
  return days % 7 ? `${weeks}w ${days % 7}d` : `${weeks}w`
}

// Human-friendly elapsed since an ISO timestamp, measured against NOW: "just now", "12m", "1h 3m".
// Empty when absent or unparseable. Distinct from formatFixedDuration, which formats an already-
// COMPLETED span (a dispatch→completion elapsed, in ms). This was written twice verbatim — in
// ChatView's ops strip and in the agent-terminal drawer — while every other duration formatter already
// lived here.
export function elapsedSince(startedAt: string | undefined, nowMs = Date.now()): string {
  if (!startedAt) return ""
  const started = Date.parse(startedAt)
  if (!Number.isFinite(started)) return ""
  return formatElapsedMinutes(Math.floor((nowMs - started) / 60_000))
}

// Compact "time since" for a dense status row: "just now", "6m ago", "1h 3m ago". Distinct from
// elapsedSince (which reads as a DURATION — "running 6m") by carrying the "ago" that marks it as
// recency, not lifetime. `nowMs` is passed in so a live clock can drive it without re-reading Date.
export function formatAgo(at: string | undefined, nowMs = Date.now()): string {
  if (!at) return ""
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return ""
  const mins = Math.floor((nowMs - t) / 60_000)
  if (mins < 1) return "just now"
  return `${formatElapsedMinutes(mins)} ago`
}

export function formatCountdownSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}
