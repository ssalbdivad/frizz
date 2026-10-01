import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const repo = join(import.meta.dirname, "..");
const workflow = readFileSync(join(repo, ".github", "workflows", "release.yml"), "utf8");

function step(name: string): string {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `missing release step: ${name}`);
  const end = workflow.indexOf("\n      - name:", start + 1);
  return workflow.slice(start, end === -1 ? undefined : end);
}

test("a release retry reconciles shell tags and GitHub metadata after npm succeeds", () => {
  const tag = step("Tag the released shell commit");
  const release = step("Create the GitHub shell release");

  assert.doesNotMatch(tag, /\n\s+if:/, "tagging must run when publish_shell is false on a retry");
  assert.doesNotMatch(release, /\n\s+if:/, "GitHub release creation must run when publish_shell is false on a retry");
  assert.match(tag, /node scripts\/published-git-head.mjs frizz "\$VERSION"/);
  assert.match(tag, /git fetch --no-tags --depth=1 origin "\$GIT_HEAD"/);
  assert.match(tag, /git cat-file -e "\$GIT_HEAD\^\{commit\}"/);
  assert.match(tag, /git tag -a "v\$VERSION" "\$GIT_HEAD" -m "frizz v\$VERSION"/);
  assert.match(tag, /git ls-remote --exit-code --tags origin "v\$VERSION"/);
  assert.match(release, /gh release view "v\$VERSION"/);
});

test("the release publishes the server, waits for npm to serve it, then publishes the shell", () => {
  const server = step("Build and publish frizz-server to npm");
  const serverWait = step("Wait for npm to serve frizz-server");
  const shell = step("Publish the frizz shell to npm");
  const shellWait = step("Wait for npm to serve frizz");

  // Staged publishing was dropped on 2026-09-30; a leftover `npm stage` would hang every release on
  // an approval nobody is asked for. The header still names it as history, so comments are skipped.
  const code = workflow.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(code, /npm stage|npm-stage-publish/, "the release path publishes directly");
  assert.match(server, /npm-publish\.sh \.\/packages\/server-release --ignore-scripts/);
  assert.match(shell, /npm-publish\.sh \.$/m);
  assert.match(shell, /frizzServer\.version/, "the shell refuses to publish over a pinned server npm does not serve");
  assert.match(serverWait, /npm-wait-served\.sh frizz-server "\$SERVER_VERSION"/);
  assert.match(shellWait, /npm-wait-served\.sh frizz "\$VERSION"/);
  // A retry finds a version an earlier run published and npm may still hold in review, so neither
  // wait may be skipped just because this run published nothing.
  assert.doesNotMatch(serverWait, /\n\s+if:/, "the server wait must run on a retry");
  assert.doesNotMatch(shellWait, /\n\s+if:/, "the shell wait must run on a retry");
  assert.match(workflow, /RELEASE_DEADLINE=/, "both waits need the shared deadline");
  assert.match(workflow, /^ {4}timeout-minutes: 360$/m, "npm's review can take hours; the waits need the job's full six hours");

  // A shell fetches its pinned server from the registry on first boot, so the server must be served
  // before the shell publishes; the tag and the GitHub release describe a served shell.
  const order = [
    "- name: Build and publish frizz-server to npm",
    "- name: Wait for npm to serve frizz-server",
    "- name: Publish the frizz shell to npm",
    "- name: Wait for npm to serve frizz\n",
    "- name: Tag the released shell commit",
    "- name: Create the GitHub shell release",
  ].map((name) => workflow.indexOf(name));
  assert.ok(!order.includes(-1), "every release step is present");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "server, server wait, shell, shell wait, tag, release");
});

// The two helpers run against fake `npm` and `curl` on PATH, so these exercise the real scripts
// without touching the registry.
function runScript(script: string, args: string[], fake: { served: boolean; npmOut?: string; npmExit?: number; deadline?: number }) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-release-script-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "curl"), `#!/bin/sh\nexit ${fake.served ? 0 : 22}\n`, { mode: 0o755 });
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh\necho "$@" >> "${join(dir, "npm-calls")}"\nprintf '%s\\n' "$FAKE_NPM_OUT"\nexit ${fake.npmExit ?? 0}\n`,
    { mode: 0o755 }
  );
  const pkg = join(dir, "pkg");
  mkdirSync(pkg);
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "frizz-server", version: "9.9.9" }));
  const result = spawnSync("bash", [join(repo, ".github", "scripts", script), ...args.map((a) => (a === "<pkg>" ? pkg : a))], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_NPM_OUT: fake.npmOut ?? "",
      RELEASE_DEADLINE: String(fake.deadline ?? 0),
    },
  });
  const calls = existsSync(join(dir, "npm-calls")) ? readFileSync(join(dir, "npm-calls"), "utf8") : "";
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, out: result.stdout + result.stderr, calls };
}

test("npm-publish.sh skips a served version, tolerates a re-run during npm's review, and fails on E403", () => {
  const served = runScript("npm-publish.sh", ["<pkg>"], { served: true });
  assert.equal(served.status, 0);
  assert.equal(served.calls, "", "a served version must not be published again");

  const fresh = runScript("npm-publish.sh", ["<pkg>", "--ignore-scripts"], { served: false });
  assert.equal(fresh.status, 0);
  assert.match(fresh.calls, /^publish .*\/pkg --ignore-scripts$/m, "a direct publish, never `npm stage publish`");

  const inReview = runScript("npm-publish.sh", ["<pkg>"], {
    served: false,
    npmExit: 1,
    npmOut: "npm error code E409\nnpm error 409 Conflict - Cannot publish over previously staged version",
  });
  assert.equal(inReview.status, 0, inReview.out);

  // A stage-only trusted publisher refuses a direct publish with E403; the step must fail at once and
  // say which npm setting to change.
  const denied = runScript("npm-publish.sh", ["<pkg>"], {
    served: false,
    npmExit: 1,
    npmOut: "npm error code E403\nnpm error 403 Forbidden - OIDC permission denied for this action",
  });
  assert.equal(denied.status, 1, denied.out);
  assert.match(denied.out, /trusted publisher/);

  const other = runScript("npm-publish.sh", ["<pkg>"], { served: false, npmExit: 1, npmOut: "npm error code E500" });
  assert.equal(other.status, 1, other.out);
});

test("npm-wait-served.sh returns once npm serves the version and fails at the deadline", () => {
  const served = runScript("npm-wait-served.sh", ["frizz", "9.9.9"], { served: true });
  assert.equal(served.status, 0, served.out);

  const missing = runScript("npm-wait-served.sh", ["frizz", "9.9.9"], { served: false, deadline: 1 });
  assert.equal(missing.status, 1, missing.out);
  assert.match(missing.out, /npm still does not serve frizz@9\.9\.9/);
});
