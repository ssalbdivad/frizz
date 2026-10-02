import { isAnonymousClaimName } from "@frizz/shared";
import type { RemoteControlHandler, RemoteControlReply } from "@frizz/server/restart-supervisor";
import { type CloudConfig, isClaimedConfig, isExternalConfig, normalizeHostname } from "./cloud.ts";
import type { CloudflaredProbe, GithubProbe, TailscaleProbe } from "./remote-detect.ts";

/**
 * Remote access as a set of CHOICES, shared by the two places an operator makes one: the R pane in
 * the launcher's terminal (remote-pane.ts) and Settings → Remote access in the browser, which reaches
 * the launcher through the supervisor's loopback-only `/_frizz/control/remote` (restart-supervisor.ts).
 *
 * Both turn a choice into the same CloudConfig here, so a setup made in one reads as the same setup in
 * the other, and both apply it through the one RemoteController — which is what keeps a switch from one
 * setup to another leaving no tunnel behind, whichever surface asked for it.
 */

export type RemoteKind = "private" | "frizz" | "cloudflare" | "tailscale" | "other" | "off";

/** What an operator asked for, in the fields each setup actually takes. */
export type RemoteChoice =
  | { kind: "off" }
  | { kind: "private" }
  | { kind: "frizz"; name: string }
  | { kind: "cloudflare"; hostname: string; tunnel: string }
  | { kind: "tailscale" | "other"; origin: string };

export function kindOf(config: CloudConfig | null): RemoteKind {
  if (!config) return "off";
  if (isClaimedConfig(config)) return isAnonymousClaimName(config.claim!) ? "private" : "frizz";
  if (isExternalConfig(config)) return config.provider === "tailscale" ? "tailscale" : "other";
  return "cloudflare";
}

export interface RemoteSetupDeps {
  /** Switch the running board to `next`, or to loopback-only with null. Rejects with a message. */
  apply: (next: CloudConfig | null, options?: { justClaimed?: boolean }) => Promise<void>;
  /** Claim `<name>.frizz.sh`; an empty name mints a private one. Rejects with a message. */
  claim: (name: string) => Promise<CloudConfig>;
  /** Told before each slow step, so a caller with a screen can say what is happening. */
  progress?: (message: string) => void;
}

/**
 * Turn a choice into a config and serve it. Resolves to what is now in force (null = loopback only).
 *
 * Validation happens BEFORE anything is stopped: a typo in a hostname must not take down the setup
 * that was working.
 */
export async function applyRemoteChoice(choice: RemoteChoice, deps: RemoteSetupDeps): Promise<CloudConfig | null> {
  if (choice.kind === "off") {
    deps.progress?.("back to loopback only…");
    await deps.apply(null);
    return null;
  }
  let next: CloudConfig;
  let justClaimed = false;
  if (choice.kind === "private" || choice.kind === "frizz") {
    const name = choice.kind === "frizz" ? choice.name.trim() : "";
    if (choice.kind === "frizz" && !name) throw new Error("a name is needed");
    deps.progress?.(name ? `claiming ${name}.frizz.sh…` : "claiming a private name on frizz.sh…");
    next = await deps.claim(name);
    justClaimed = true;
  } else if (choice.kind === "cloudflare") {
    const hostname = normalizeHostname(choice.hostname);
    const tunnel = choice.tunnel.trim();
    if (!tunnel) throw new Error("the tunnel's name is needed");
    next = { hostname, tunnel };
  } else {
    next = { hostname: normalizeHostname(choice.origin), serve: "external", provider: choice.kind };
  }
  deps.progress?.(`serving ${next.hostname}…`);
  await deps.apply(next, { justClaimed });
  return next;
}

/** Read a request body as a RemoteChoice, or say what is wrong with it. */
export function parseRemoteChoice(body: unknown): RemoteChoice | string {
  if (!body || typeof body !== "object") return "expected a JSON object";
  const value = body as Record<string, unknown>;
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : "");
  switch (value.kind) {
    case "off":
    case "private":
      return { kind: value.kind };
    case "frizz":
      return { kind: "frizz", name: text("name") };
    case "cloudflare":
      return { kind: "cloudflare", hostname: text("hostname"), tunnel: text("tunnel") };
    case "tailscale":
    case "other":
      return { kind: value.kind, origin: text("origin") };
    default:
      return "kind must be one of off, private, frizz, cloudflare, tailscale, other";
  }
}

/** How the browser sees the setup in force. Mirrored in packages/web/src/api/remoteAccess.ts. */
export interface RemoteSetupView {
  kind: RemoteKind;
  /** `https://<hostname>`, absent while loopback only. */
  origin?: string;
  /** The claimed frizz.sh label, for a custom name. */
  name?: string;
  /** The cloudflared tunnel name, for a Cloudflare Tunnel. */
  tunnel?: string;
}

export function viewOf(config: CloudConfig | null): RemoteSetupView {
  const kind = kindOf(config);
  if (!config) return { kind };
  return {
    kind,
    origin: `https://${config.hostname}`,
    ...(kind === "frizz" && config.claim ? { name: config.claim } : {}),
    ...(config.tunnel ? { tunnel: config.tunnel } : {}),
  };
}

export interface RemoteControlOptions extends Omit<RemoteSetupDeps, "progress"> {
  current: () => CloudConfig | null;
  port: number;
  /** A fresh single-use sign-in link for the origin in force. */
  issueLink: () => { url: string; expiresAt: number } | null;
  probes: {
    github: () => Promise<GithubProbe>;
    cloudflared: () => Promise<CloudflaredProbe>;
    tailscale: () => Promise<TailscaleProbe>;
  };
  onChanged?: (config: CloudConfig | null) => void;
}

/**
 * The launcher's half of Settings → Remote access. The supervisor has already refused anything that
 * did not arrive over loopback before this runs — changing who can reach the board needs presence on
 * the machine, the same rule minting a sign-in link and signing devices out already follow.
 */
export function createRemoteControlHandler(options: RemoteControlOptions): RemoteControlHandler {
  // One browser change at a time: two overlapping applies would each stop the other's transport
  // half-started. (The R pane is modal on its own terminal and an operator drives one surface at once.)
  let applying = false;
  const reply = (status: number, body: unknown): RemoteControlReply => ({ status, body });

  return {
    async get() {
      const [github, cloudflared, tailscale] = await Promise.all([
        options.probes.github(),
        options.probes.cloudflared(),
        options.probes.tailscale(),
      ]);
      return reply(200, {
        protocol: 1,
        current: viewOf(options.current()),
        port: options.port,
        applying,
        probes: { github, cloudflared, tailscale },
      });
    },
    async post(body) {
      const choice = parseRemoteChoice(body);
      if (typeof choice === "string") return reply(400, { protocol: 1, error: choice });
      if (applying) return reply(409, { protocol: 1, error: "another remote-access change is still being applied" });
      applying = true;
      try {
        const next = await applyRemoteChoice(choice, options);
        options.onChanged?.(next);
        return reply(200, { protocol: 1, current: viewOf(next), link: next ? options.issueLink() : null });
      } catch (error) {
        // The controller has already dropped the origin for a setup that failed to start, so what is in
        // force now is whatever it says — report that alongside the error.
        return reply(422, {
          protocol: 1,
          error: error instanceof Error ? error.message : String(error),
          current: viewOf(options.current()),
        });
      } finally {
        applying = false;
      }
    },
  };
}
