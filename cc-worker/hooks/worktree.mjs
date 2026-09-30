#!/usr/bin/env node
// @ts-check
// WHERE A WORKER'S GIT WORKTREES GO — one folder, the `worktreeDir` setting (`.frizz/worktrees` by
// default, resolved against the MAIN checkout of the repository the worktree belongs to). Never beside
// the checkout: on a machine that keeps its repos directly in `~`, `git worktree add ../<repo>-<slug>`
// is a new folder in the home directory, and workers did exactly that across projects whose own docs
// said nothing about it (`~/yes-perf`, 2026-09-30; eight at once on 2026-09-28). A prompt line alone
// had not held, so three mechanisms share this module:
//
//   1. `evaluateWorktreeGuard` — called from the PreToolUse(Bash) hook (bash-background.mjs, so Codex
//      gets it through the same registration): DENIES a `git worktree add` whose path lands outside the
//      folder, and the denial names the path it should have used.
//   2. `--event=create` / `--event=remove` — Claude Code's WorktreeCreate/WorktreeRemove hooks, so
//      EnterWorktree and sub-agent `isolation: "worktree"` land in the same folder instead of
//      `.claude/worktrees`.
//   3. `worktreeAddTargets` — imported by the server (worktree-cleanup.ts), which reads the same
//      commands back out of a thread's transcript to find the worktrees it made and removes them when
//      the thread is marked done. One parser, so what the guard allowed is what cleanup finds.
//
// The setting reaches a worker as FRIZZ_WORKTREE_DIR (Claude) or `--worktree-dir=` (Codex's shared
// app-server cannot carry a per-thread env). Absent, the default applies — the hook never goes inert
// for want of it. FAIL OPEN everywhere else: a command this small parser cannot read is allowed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const DEFAULT_WORKTREE_DIR = '.frizz/worktrees';

/** @param {string} p */
function expandHome(p) {
  if (p === '~') return homedir();
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/**
 * Split a command into words, honouring quotes, and into segments at `&&` `||` `;` `|` and newlines.
 * Deliberately small: enough to read `cd X && git -C Y worktree add -b b PATH`, not a shell.
 * @param {string} command
 * @returns {string[][]}
 */
function segments(command) {
  /** @type {string[][]} */
  const out = [];
  /** @type {string[]} */
  let words = [];
  let word = '';
  let inWord = false;
  let quote = '';
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (c === ' ' || c === '\t') endWord();
    else if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')') endSegment();
    else {
      word += c;
      inWord = true;
    }
  }
  endSegment();
  return out;
}

// `git worktree add` options that consume the next word.
const ADD_VALUE_OPTIONS = new Set(['-b', '-B', '--reason']);
// git's own global options that consume the next word (`-C` handled separately).
const GIT_VALUE_OPTIONS = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/**
 * Every `git worktree add` in a command: the path as written, and the folder it is relative to when
 * the command itself says (`cd X && …`, `git -C X …`), else undefined — the caller's cwd.
 * @param {unknown} raw
 * @returns {{ path: string, base?: string }[]}
 */
export function worktreeAddTargets(raw) {
  if (typeof raw !== 'string' || !/\bworktree\b/.test(raw)) return [];
  /** @type {{ path: string, base?: string }[]} */
  const out = [];
  /** @type {string | undefined} */
  let cd;
  for (const words of segments(raw)) {
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    if (words[i] === 'cd' && words[i + 1] !== undefined) {
      const dir = expandHome(words[i + 1]);
      cd = cd && !isAbsolute(dir) ? join(cd, dir) : dir;
      continue;
    }
    if (words[i] !== 'git') continue;
    let base = cd;
    for (i++; i < words.length && words[i].startsWith('-'); i++) {
      if (words[i] === '-C' && words[i + 1] !== undefined) {
        const dir = expandHome(words[++i]);
        base = base && !isAbsolute(dir) ? join(base, dir) : dir;
      } else if (GIT_VALUE_OPTIONS.has(words[i])) i++;
    }
    if (words[i] !== 'worktree' || words[i + 1] !== 'add') continue;
    for (i += 2; i < words.length; i++) {
      const w = words[i];
      if (w === '--') {
        i++;
        break;
      }
      if (!w.startsWith('-') || w === '-') break;
      if (ADD_VALUE_OPTIONS.has(w)) i++;
    }
    const path = words[i];
    if (path) out.push({ path: expandHome(path), ...(base !== undefined ? { base } : {}) });
  }
  return out;
}

/**
 * The main checkout of the repository `dir` is in — the folder a relative setting is resolved
 * against, the same for the project root and for any of its worktrees. Undefined outside a repo.
 * @param {string} dir
 */
export function mainCheckoutOf(dir) {
  try {
    const common = execFileSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    if (!common) return undefined;
    return basename(common) === '.git' ? dirname(common) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The absolute folder worktrees of the repository at `repoDir` belong in.
 * @param {string | undefined} setting @param {string} repoDir @param {(dir: string) => string | undefined} [mainOf]
 */
export function worktreeRootFor(setting, repoDir, mainOf = mainCheckoutOf) {
  const dir = expandHome((setting ?? '').trim() || DEFAULT_WORKTREE_DIR);
  if (isAbsolute(dir)) return resolve(dir);
  return resolve(mainOf(repoDir) ?? repoDir, dir);
}

/** @param {string} root @param {string} candidate */
export function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** @param {string[]} argv @param {Record<string, string | undefined>} env */
export function worktreeSetting(argv, env) {
  const flag = argv.find((a) => a.startsWith('--worktree-dir='));
  return flag ? flag.slice('--worktree-dir='.length) : env.FRIZZ_WORKTREE_DIR;
}

/**
 * PreToolUse(Bash): deny a `git worktree add` outside the worktree folder. Returns undefined to allow.
 * @param {any} input @param {string | undefined} setting @param {(dir: string) => string | undefined} [mainOf]
 */
export function evaluateWorktreeGuard(input, setting, mainOf = mainCheckoutOf) {
  const command = input?.tool_input?.command;
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  for (const target of worktreeAddTargets(command)) {
    const base = target.base === undefined ? cwd : resolve(cwd, target.base);
    const path = resolve(base, target.path);
    const root = worktreeRootFor(setting, base, mainOf);
    if (isInside(root, path)) continue;
    const suggested = join(root, basename(path));
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Frizz keeps worktrees in ${root}, and ${path} is outside it. ` +
          `Run the same command with the path ${suggested} instead. ` +
          'Frizz removes a clean worktree there when the thread is marked done.',
      },
    };
  }
  return undefined;
}

// Claude Code's WorktreeCreate: make `<root>/<name>` on a new `worktree-<name>` branch (Claude's own
// naming) and print its path. Re-entering an existing one (a resumed session) prints it unchanged.
/** @param {any} input @param {string | undefined} setting */
function createWorktree(input, setting) {
  const name = String(input?.name ?? '').trim();
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  if (!name || name.includes('/') || name.startsWith('.')) throw new Error(`unusable worktree name: ${name}`);
  const root = worktreeRootFor(setting, cwd);
  const path = join(root, name);
  const listed = execFileSync('git', ['-C', cwd, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  if (!listed.split('\n').includes(`worktree ${path}`)) {
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['-C', cwd, 'worktree', 'add', '-b', `worktree-${name}`, path, 'HEAD'], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  process.stdout.write(`${path}\n`);
}

// Claude Code's WorktreeRemove: Claude has already confirmed discarding any changes, so this is its own
// removal (--force), plus the branch when it is merged (`-d` keeps an unmerged one).
/** @param {any} input */
function removeWorktree(input) {
  const path = String(input?.worktree_path ?? '');
  if (!path) throw new Error('no worktree_path');
  let branch = '';
  try {
    branch = execFileSync('git', ['-C', path, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {}
  const main = mainCheckoutOf(path) ?? dirname(path);
  execFileSync('git', ['-C', main, 'worktree', 'remove', '--force', path], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (branch) {
    try {
      execFileSync('git', ['-C', main, 'branch', '-d', branch], { stdio: 'ignore' });
    } catch {}
  }
}

// Entry point only under an explicit `--event=`, which no server bundle's argv ever carries.
const event = process.argv.find((a) => a.startsWith('--event='))?.slice('--event='.length);
if (basename(process.argv[1] ?? '') === 'worktree.mjs' && event) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const setting = worktreeSetting(process.argv, process.env);
    if (event === 'create') createWorktree(input, setting);
    else if (event === 'remove') removeWorktree(input);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
