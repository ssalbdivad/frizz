# PreToolUse(Bash) PRE-FILTER for bash-background.mjs. Not a hook of its own: hooks.json runs it as
# `exec sh .../bash-background.sh; node .../bash-background.mjs`, and it either answers `{}` itself or
# hands the identical stdin to that node hook.
#
# WHY: the node hook fires on every Bash call a worker makes, and almost every call is one it answers
# with `{}`. Starting node was the whole cost — p50 67ms, p95 346ms, max 4.9s per call, 62 minutes over
# 36k calls in three days of worker transcripts (2026-09-29..10-01), with `node trivial.mjs` within noise
# of the real hook. This file answers `{}` only where it can PROVE node would, and in pure POSIX sh with
# no subprocess, so a skipped call costs one `sh` exec instead of a node start. Over 125k distinct real
# Bash inputs it answers 93% itself; replayed through `/bin/sh -c` on this repo's WSL box under load,
# the hook went from p50 166ms to 8ms (2026-10-02; the numbers and their conditions are in the commit).
#
# THE PROOF — read it against bash-background.mjs and worktree.mjs before changing either. Node emits
# something other than `{}` only through one of these, and each is ruled out by a check below:
#   1. hasEscapingBackgroundJob → DENY. Needs an `&` in tool_input.command that is a background
#      operator. Node discards an `&` whose neighbour (after blanking quotes and heredoc bodies) is `&`
#      before or after, `>`/`<` before, or `>` after. Those neighbours are never quote characters, so
#      blanking never separates them from an `&` that survives it, and `bash -c "…"` un-escaping only ever
#      removes a backslash, never one of them. So an `&` whose RAW neighbour is one of them can never be
#      an operator at any recursion depth. A backslash neighbour is deliberately NOT accepted: node's own
#      `\&` exemption is undone by that un-escaping (`bash -c "job \&"` is denied).
#   2. evaluateWorktreeGuard → DENY. Needs `\bworktree\b` in the command (worktreeAddTargets' first
#      test). A raw `worktree` followed by a raw word character [A-Za-z0-9_] is followed by that same
#      character once decoded (an escape starts with `\`, which is not one), so it fails `\b` and is
#      not that word. Every other `worktree` — `worktree add`, `worktree\tadd`, `worktree"` — goes to
#      node. The word set is spelled out, never a range: `[A-Z]` matches lowercase in some locales.
#      This is what lets `cd …/.frizz/worktrees/<slug> && …`, a worker's every other call, skip.
#   3. untimed run_in_background → advice. Needs `run_in_background` set to `true`.
#   4. long foreground → advice. Needs a `timeout` number above LONG_FOREGROUND_MS (15m = 900000).
#   5. FRIZZ_THREAD empty → node answers `{}` for every input, so this does too.
# Everything else in node only narrows those (sub-agent, codex `model`, a declared timeout) and never
# turns a `{}` into output, so this file ignores it: such calls just run node.
#
# THE JSON IS NEVER PARSED, ONLY SCANNED, so every check is conservative on the raw text:
#   - Malformed JSON is node's `{}` (its catch), so only valid JSON needs reasoning about.
#   - Any `\u` escape anywhere → node. That is the one JSON escape that could spell `&`, `worktree`, or a
#     key name without its letters appearing literally. A `\u` is an escape when the backslashes before
#     its `u` are odd in number; the check sends a `\u` after a non-backslash (one) or after `\\\` (three
#     or more, odd or not) to node, so what stays is exactly `X\\u`: an escaped backslash, then a plain
#     `u` — `printf '\\u2014'`, or a Windows path `C:\\Users\\u…` in `cwd` that would otherwise send
#     every call to node.
#   - `"tool_input"` must appear exactly once, and checks 1-4 read only the text after it (and its `:`).
#     With no `\u` escape, a real top-level `tool_input` key is spelled literally, so if it exists it is
#     that one occurrence, and its whole value lies after it. If it does not exist, node reads no
#     command and answers `{}`, so skipping is right whatever the text says. The count is of the bare
#     quoted name, NOT of `"tool_input":` — a key like `"a\"tool_input"` holds that spelling, and with
#     the real key written `"tool_input" :` the first `"tool_input":` was the impostor, after the real
#     value: a draft that counted the colon form skipped a call node denies.
#     The prefix is skipped because it holds `cwd` and `transcript_path`.
#   - `"run_in_background"` may appear there at most once, followed by exactly `:false` and `,` or `}`;
#     `"timeout"` at most once, followed by a plain integer of at most 900000 and `,` or `}`. Any other
#     spelling (whitespace, a float, an exponent, a string, a duplicate key, whose last copy is the one
#     JSON.parse keeps) → node.
#   - Inputs over 64KB → node.
#
# EVERY CHECK IS A `case` PATTERN, never a loop or a `${var#*pattern}` cut. Cutting is quadratic in
# every shell measured: `${x#*'"tool_input":'}` with the marker 60KB in took 4.7s in dash and 12s in
# bash, and an earlier per-`&` loop took 21s on a 9.6KB command holding 2,400 of them. A `case` match
# is linear, so the worst real input (73KB, the largest of 125k corpus calls) is decided in
# milliseconds.
# packages/server/src/bash-background-prefilter.test.ts checks every one of these against node on real
# transcript inputs and on adversarial ones; scripts/bash-prefilter-corpus.ts re-derives its fixture.
#
# FAIL OPEN. Claude Code reads exit status 2 from a PreToolUse hook as "block this call", and sh exits 2
# on a syntax error. So the first thing this file does is arm an EXIT trap that runs node instead: a
# syntax or fatal runtime error anywhere below lands in node, which answers exactly as it did before this
# file existed. Every deliberate exit disarms the trap first.
#
# WINDOWS, as read out of Claude Code 2.1.285's binary and then run on a real Windows host: a shell-form
# hook runs as `<Git>\bin\bash.exe -c <command>` with `<Git>\bin` put first on PATH, so `sh` is Git's
# own and this file runs as it does anywhere else (408 inputs, every one answered as node alone answers
# it; p50 247ms -> 164ms, MSYS process start being most of either). Only when it finds no Git Bash does
# Claude pick PowerShell instead, and then it offers no Bash tool at all, so this matcher never fires.
# The command still survives PowerShell: `exec` fails as an unknown command, PowerShell carries on to
# `node`, and the answer is node's (pwsh 7 and 5.1 both checked) — but the failed lookup costs ~1.2s,
# so this must never become the command of a hook that DOES fire under PowerShell.
#
# POSIX sh only — dash, bash 5 and 3.2 (macOS /bin/sh), bash --posix, busybox ash and Git Bash all take
# identical decisions on 1,038 inputs (2026-10-02): no arrays, no `${var//}`, no `[[`, no subprocess.

trap 'trap - EXIT; if [ -n "${prefilter_read:-}" ]; then printf %s "$prefilter_input" | node "$prefilter_dir/bash-background.mjs" "$@"; else node "$prefilter_dir/bash-background.mjs" "$@"; fi; exit $?' EXIT

case $0 in
  */*) prefilter_dir=${0%/*} ;;
  *) prefilter_dir=. ;;
esac

# Read stdin whole, byte for byte (Claude sends one JSON line and a newline; `read` keeps everything but
# NUL, which JSON text cannot contain). A builtin loop rather than `$(cat)`: no fork.
prefilter_nl='
'
prefilter_input=
while IFS= read -r prefilter_line; do
  prefilter_input=$prefilter_input$prefilter_line$prefilter_nl
done
prefilter_input=$prefilter_input$prefilter_line
prefilter_read=1

# Exit 0 only when node would answer `{}`; see the proof above. Every check is one `case` over the
# whole input, scoped to the text after the `"tool_input":` marker by a leading `*'"tool_input":'*`.
prefilter_skippable() {
  [ $# -eq 0 ] || return 1
  [ -n "${FRIZZ_THREAD:-}" ] || return 0
  [ ${#prefilter_input} -le 65536 ] || return 1
  case $prefilter_input in
    *[!\\]'\u'* | *'\\\u'*) return 1 ;;
    *'"tool_input"'*'"tool_input"'*) return 1 ;;
    *'"tool_input":'*) ;;
    *) return 1 ;;
  esac
  case $prefilter_input in
    *'"tool_input":'*worktree[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_]*) return 1 ;;
    # An `&` with no neighbour node discards it for: not `&`/`>`/`<` before, not `&`/`>` after.
    *'"tool_input":'*[!\&\>\<]\&[!\&\>]* | *'"tool_input":'*[!\&\>\<]\& | *'"tool_input":&'*) return 1 ;;
  esac
  case $prefilter_input in
    *'"tool_input":'*'"run_in_background"'*'"run_in_background"'*) return 1 ;;
    *'"tool_input":'*'"run_in_background":false,'* | *'"tool_input":'*'"run_in_background":false}'*) ;;
    *'"tool_input":'*'"run_in_background"'*) return 1 ;;
  esac
  case $prefilter_input in
    *'"tool_input":'*'"timeout"'*'"timeout"'*) return 1 ;;
    *'"tool_input":'*'"timeout":'[0-9][,\}]* | \
      *'"tool_input":'*'"timeout":'[0-9][0-9][,\}]* | \
      *'"tool_input":'*'"timeout":'[0-9][0-9][0-9][,\}]* | \
      *'"tool_input":'*'"timeout":'[0-9][0-9][0-9][0-9][,\}]* | \
      *'"tool_input":'*'"timeout":'[0-9][0-9][0-9][0-9][0-9][,\}]* | \
      *'"tool_input":'*'"timeout":'[0-8][0-9][0-9][0-9][0-9][0-9][,\}]* | \
      *'"tool_input":'*'"timeout":900000'[,\}]*) ;;
    *'"tool_input":'*'"timeout"'*) return 1 ;;
  esac
  return 0
}

if prefilter_skippable "$@"; then
  trap - EXIT
  printf '{}'
  exit 0
fi
trap - EXIT
printf %s "$prefilter_input" | node "$prefilter_dir/bash-background.mjs" "$@"
exit $?
