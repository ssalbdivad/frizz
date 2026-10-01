import assert from "node:assert/strict"
import test from "node:test"
import { compactElapsedSince, formatAgo, formatCountdown, formatCountdownSeconds, formatElapsedMinutes, formatFixedDuration,
  formatToolDuration, formatCompactElapsed, formatRuntimeElapsed, liveAgeSince,
} from "./durationLabels.ts"

// THE HOUSE DURATION GRAMMAR (maintainer 2026-08-31: `"40 minutes" -> "40m"` / `2hr 35m` / "Use this
// stylization everywhere. EVERYWHERE", then "h is better than hr"). Every formatter in this module
// spells its units the same way — ms · s · m · h · d · w — whatever ladder it climbs. This test is the
// pin: a reading that reverts to `40 min`, `2 hr 8 min`, `1hr 5m` or `12 minutes` fails here rather
// than shipping as a sixth vocabulary.
test("every formatter spells its units in the house grammar", () => {
  assert.equal(formatToolDuration(450), "450ms")
  assert.equal(formatToolDuration(0.4), "<1ms")
  assert.equal(formatToolDuration(2_300), "2.3s")
  assert.equal(formatToolDuration(9 * 60_000 + 12_000), "9m 12s", "a tool call keeps its seconds")
  // …until an hour, where the next rung takes over. A flat `128m` renders `128M` on the card's
  // petite-caps meta line and reads as a count; `2h 8m` cannot.
  assert.equal(formatToolDuration(128 * 60_000), "2h 8m")
  assert.equal(formatToolDuration(128 * 60_000 + 3_000), "2h 8m")
  assert.equal(formatToolDuration(120 * 60_000), "2h", "a whole hour drops the empty minutes")
  assert.equal(formatElapsedMinutes(128), "2h 8m")
  assert.equal(formatElapsedMinutes(7 * 24 * 60 + 12), "7d", "and it climbs to days rather than saying 169h")
  assert.equal(formatElapsedMinutes(3 * 24 * 60 + 4 * 60), "3d 4h")
  assert.equal(formatElapsedMinutes(40), "40m", "the maintainer's own example: 40 minutes reads 40m")
  assert.equal(formatElapsedMinutes(155), "2h 35m", "and the compound one")
  assert.equal(formatFixedDuration(128 * 60_000), "2h 8m")
  assert.equal(formatFixedDuration(20_000), "<1m")
  assert.equal(formatCountdownSeconds(45), "45s")
  assert.equal(formatCountdownSeconds(128), "2m 08s")
  assert.equal(formatCountdownSeconds(5_400), "1h 30m")
  assert.equal(formatAgo(new Date(Date.now() - 40 * 60_000).toISOString()), "40m ago")

  // The grammar as a SHAPE: a number (or `<1`), its unit glued on, and at most one more pair after a
  // single space. A reading that reverts to `40 min`, `2 hr 8 min` or `1hr 5m` cannot match it.
  const HOUSE_GRAMMAR = /^(?:<1|\d+(?:\.\d)?)(?:ms|s|m|h|d|w|mo|y)(?: \d+(?:ms|s|m|h|d|w|mo|y))?$/
  const readings = [
    formatToolDuration(0.4), formatToolDuration(450), formatToolDuration(2_300),
    formatToolDuration(9 * 60_000 + 12_000), formatToolDuration(128 * 60_000 + 3_000),
    formatElapsedMinutes(155), formatElapsedMinutes(3 * 24 * 60 + 4 * 60), formatFixedDuration(128 * 60_000),
    formatCountdownSeconds(5_400), formatCountdownSeconds(128), formatCompactElapsed(65 * 60_000),
    formatRuntimeElapsed(3 * 86_400_000 + 4 * 3_600_000), formatRuntimeElapsed(13 * 3_600_000 + 48 * 60_000),
    formatCountdown(3 * 3_600_000 + 5 * 60_000), formatCountdown(2 * 86_400_000 + 3 * 3_600_000),
    liveAgeSince(new Date(0).toISOString(), 20_000), liveAgeSince(new Date(0).toISOString(), 65 * 60_000),
  ]
  for (const reading of readings) assert.match(reading, HOUSE_GRAMMAR, `off the house grammar: "${reading}"`)
})

// A terminal row's age is read on the page's 30s clock (lib/liveClock.ts), whose last reading can be up to
// 30s older than a row that just started. In seconds that read NOTHING (negative elapsed) and then a frozen
// `24s`; it now says `<1m` from the first render and minutes after.
test("liveAgeSince: a live process's age is `<1m` from its first render, then minutes, never seconds", () => {
  const start = "2026-09-29T10:00:00.000Z"
  const at = (ms: number) => Date.parse(start) + ms
  assert.equal(liveAgeSince(start, at(-12_000)), "<1m", "a row that started after the clock's last tick still reads")
  assert.equal(liveAgeSince(start, at(0)), "<1m")
  assert.equal(liveAgeSince(start, at(24_000)), "<1m", "no seconds to sit frozen between ticks")
  assert.equal(liveAgeSince(start, at(60_000)), "1m")
  assert.equal(liveAgeSince(start, at(12 * 60_000 + 30_000)), "12m")
  assert.equal(liveAgeSince(start, at(65 * 60_000)), "1h 5m")
  assert.equal(liveAgeSince(undefined, at(0)), "")
  assert.equal(liveAgeSince("not a date", at(0)), "")
})

test("formatCompactElapsed: seconds, minutes, hours — the dense child-row forms", () => {
  // The maintainer's spec, 2026-07-28: "12m" or "1hr 5m" or "38s" — hours single-lettered by the
  // 2026-08-31 grammar, nothing else about the reading moved.
  assert.equal(formatCompactElapsed(0), "0s")
  assert.equal(formatCompactElapsed(38_000), "38s")
  assert.equal(formatCompactElapsed(59_999), "59s")
  assert.equal(formatCompactElapsed(60_000), "1m")
  assert.equal(formatCompactElapsed(12 * 60_000), "12m")
  assert.equal(formatCompactElapsed(59 * 60_000), "59m")
  assert.equal(formatCompactElapsed(65 * 60_000), "1h 5m")
  assert.equal(formatCompactElapsed(60 * 60_000), "1h", "a whole hour drops the empty minutes")
  assert.equal(formatCompactElapsed(-1), "", "never a fabricated reading")
  assert.equal(formatCompactElapsed(Number.NaN), "")
})

test("formatRuntimeElapsed: the runtime slot's s/m/h/d/w ladder, two units at most", () => {
  const S = 1_000, M = 60 * S, H = 60 * M, D = 24 * H, W = 7 * D
  // The maintainer's ladder AND spelling, 2026-08-08 (`"2m" "1h 17m" etc (smhdw)`). The 2026-08-31
  // sweep left this reading alone and spread it to every other surface.
  assert.equal(formatRuntimeElapsed(2 * M), "2m")
  assert.equal(formatRuntimeElapsed(H + 17 * M), "1h 17m")

  assert.equal(formatRuntimeElapsed(0), "0s")
  assert.equal(formatRuntimeElapsed(42 * S), "42s")
  assert.equal(formatRuntimeElapsed(59_999), "59s")
  assert.equal(formatRuntimeElapsed(M), "1m")
  // Seconds never ride beside another unit — past a minute they are noise, which is what made the old
  // `120m 00s` reading both wrong in scale and wide enough to overflow the panel.
  assert.equal(formatRuntimeElapsed(2 * M + 5 * S), "2m")
  assert.equal(formatRuntimeElapsed(59 * M + 59 * S), "59m")
  assert.equal(formatRuntimeElapsed(2 * H), "2h", "a whole hour drops the empty minutes")
  assert.equal(formatRuntimeElapsed(13 * H + 48 * M), "13h 48m")
  assert.equal(formatRuntimeElapsed(23 * H + 59 * M), "23h 59m")

  assert.equal(formatRuntimeElapsed(D), "1d")
  assert.equal(formatRuntimeElapsed(3 * D + 4 * H), "3d 4h")
  assert.equal(formatRuntimeElapsed(6 * D + 23 * H), "6d 23h")
  assert.equal(formatRuntimeElapsed(W), "1w")
  assert.equal(formatRuntimeElapsed(2 * W + 3 * D), "2w 3d")
  assert.equal(formatRuntimeElapsed(9 * W + 6 * D), "9w 6d", "weeks are the top of the ladder")

  assert.equal(formatRuntimeElapsed(-1), "", "never a fabricated reading")
  assert.equal(formatRuntimeElapsed(Number.NaN), "")
})

test("formatCountdown: padded, two units, in the house grammar", () => {
  const S = 1_000, M = 60 * S, H = 60 * M, D = 24 * H
  assert.equal(formatCountdown(45 * S), "45s")
  assert.equal(formatCountdown(12 * M + 5 * S), "12m 05s")
  assert.equal(formatCountdown(3 * H + 5 * M), "3h 05m", "the trailing unit pads and never drops")
  assert.equal(formatCountdown(2 * D + 3 * H), "2d 3h", "past a day it goes unpadded")
  assert.equal(formatCountdown(0), "0s")
})

test("compactElapsedSince: a start the clock has not reached yet reads as just started, never blank", () => {
  const now = Date.parse("2026-09-30T10:00:00Z")
  // The shared clock ticks every 30s, so a row minted between ticks carries a start after `now`.
  assert.equal(compactElapsedSince("2026-09-30T10:00:12Z", now), "0s")
  assert.equal(compactElapsedSince("2026-09-30T09:59:22Z", now), "38s")
  assert.equal(compactElapsedSince(undefined, now), "")
  assert.equal(compactElapsedSince("not a date", now), "")
})
