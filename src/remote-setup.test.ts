import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudConfig } from "./cloud.ts";
import { createRemoteControlHandler, parseRemoteChoice } from "./remote-setup.ts";

const probes = {
  github: async () => ({ installed: true, login: "ada" }),
  cloudflared: async () => ({ version: null }),
  tailscale: async () => ({ installed: false, dnsName: null }),
};

function harness() {
  let config: CloudConfig | null = null;
  const applied: Array<CloudConfig | null> = [];
  const handler = createRemoteControlHandler({
    port: 9393,
    current: () => config,
    apply: async (next) => {
      applied.push(next);
      config = next;
    },
    claim: async (name) => ({ hostname: `${name || "mk7w2qp9x4n3f6tbz5vh"}.frizz.sh`, claim: name || "mk7w2qp9x4n3f6tbz5vh", serve: "relay" }),
    issueLink: () => (config ? { url: `https://${config.hostname}/?frizz_code=abc`, expiresAt: 1 } : null),
    probes,
  });
  return { handler, applied };
}

test("a browser choice becomes the same config the R pane would write, and comes back with a scannable link", async () => {
  const { handler, applied } = harness();
  const reply = await handler.post({ kind: "tailscale", origin: "https://Mini.tail.ts.net/" });
  assert.equal(reply.status, 200);
  assert.deepEqual(applied, [{ hostname: "mini.tail.ts.net", serve: "external", provider: "tailscale" }]);
  const body = reply.body as { current: { kind: string; origin: string }; link: { url: string; qrSvg: string } };
  assert.deepEqual(body.current, { kind: "tailscale", origin: "https://mini.tail.ts.net" });
  assert.match(body.link.qrSvg, /^<svg [^>]*viewBox="0 0 \d+ \d+"/);

  // A fresh link changes nothing else.
  const fresh = await handler.post({ link: true });
  assert.equal(fresh.status, 200);
  assert.equal(applied.length, 1);

  const off = await handler.post({ kind: "off" });
  assert.deepEqual((off.body as { current: unknown; link: unknown }), { protocol: 1, current: { kind: "off" }, link: null });
  assert.equal((await handler.post({ link: true })).status, 409, "no link to mint while loopback only");
});

test("a bad choice is refused before anything in force is stopped", async () => {
  const { handler, applied } = harness();
  assert.equal((await handler.post({ kind: "other", origin: "not a host" })).status, 422);
  assert.equal((await handler.post({ kind: "cloudflare", hostname: "board.example.com", tunnel: " " })).status, 422);
  assert.equal((await handler.post({ kind: "nope" })).status, 400);
  assert.deepEqual(applied, []);
  assert.equal(typeof parseRemoteChoice(null), "string");
});
