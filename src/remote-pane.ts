import { qrAreaOf, renderQrLines } from "@frizz/server/qr";
import type { AccessLink } from "./access-pane.ts";
import { ALT_SCREEN_OFF, ALT_SCREEN_ON, CLEAR, DIM, fitScreen, HIDE_CURSOR, type OptionalLine, RESET, SHOW_CURSOR } from "./access-pane.ts";
import { type CloudConfig, describeCloudConfig } from "./cloud.ts";
import type { Pane } from "./pane-host.ts";
import type { CloudflaredProbe, GithubProbe, TailscaleProbe } from "./remote-detect.ts";
import { applyRemoteChoice, kindOf, type RemoteChoice, type RemoteKind } from "./remote-setup.ts";

/**
 * "Press R to reach this board from a phone or another machine" — the whole remote-access setup, in
 * the terminal that is already running the board, remembered on disk.
 *
 * Why here and not in flags: the choice is made once, and it is a walkthrough, not a switch. Each
 * setup has a prerequisite (a signed-in `gh`, a tunnel created in another terminal, a Tailscale
 * daemon) that a flag can only fail on, while a screen can check it, print the commands, and ask for
 * exactly the one or two values Frizz cannot find out for itself. What it saves is served by every
 * later plain launch; "Off" clears it.
 *
 * The pane is a small state machine over a handful of screens, rendered whole on every change. Keys
 * arrive raw from the pane host: printable characters go into the focused field, arrows move, enter
 * advances or submits, escape goes back, and while a change is being applied nothing but ^C (the
 * host's) is heard.
 */

export type { RemoteKind } from "./remote-setup.ts";

export interface RemotePaneOptions {
  port: number;
  current: () => CloudConfig | null;
  /** Switch the running board to `next`, or to loopback-only with null. Rejects with a message. */
  apply: (next: CloudConfig | null, options?: { justClaimed?: boolean }) => Promise<void>;
  /**
   * Claim `<name>.frizz.sh`. An empty name mints a private unguessable one with no account; a word
   * claims that word for the signed-in GitHub account. Rejects with a message.
   */
  claim: (name: string) => Promise<CloudConfig>;
  /** A fresh single-use link for the origin now in force, for the done screen. */
  issueLink: () => AccessLink | null;
  probes: {
    github: () => Promise<GithubProbe>;
    cloudflared: () => Promise<CloudflaredProbe>;
    tailscale: () => Promise<TailscaleProbe>;
  };
  /** Told after a successful change, so the readout can say what the board is now reached at. */
  onChanged?: (config: CloudConfig | null) => void;
  /** Running under --sandbox: everything is throwaway EXCEPT a claim, which the frizz.sh screen must say. */
  sandbox?: boolean;
  output?: NodeJS.WriteStream;
}

interface Choice {
  kind: RemoteKind;
  title: string;
  blurb: string;
}

const CHOICES: Choice[] = [
  { kind: "private", title: "Private name", blurb: "an unguessable name on frizz.sh — no account, nothing to install" },
  { kind: "frizz", title: "Custom name", blurb: "<name>.frizz.sh of your choosing; needs the GitHub CLI" },
  { kind: "cloudflare", title: "Cloudflare Tunnel", blurb: "a domain you own on Cloudflare; cloudflared on this machine" },
  { kind: "tailscale", title: "Tailscale", blurb: "your tailnet; tailscale serve does the TLS" },
  { kind: "other", title: "Something else", blurb: "any proxy or tunnel you run — tell Frizz its address" },
  { kind: "off", title: "Off", blurb: "loopback only" },
];

const ENTER = new Set(["\r", "\n"]);
const BACKSPACE = new Set(["\x7f", "\b"]);
const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";

type Screen =
  | { name: "menu"; index: number }
  | { name: "form"; kind: FormKind; fields: Field[]; focus: number; note?: string }
  | { name: "busy"; message: string }
  | { name: "done"; message: string; link: AccessLink | null; config: CloudConfig | null }
  | { name: "error"; message: string; back: Screen };

interface Field {
  label: string;
  value: string;
  /** Shown dim inside an empty field; enter accepts it. */
  placeholder?: string;
}

/** The setups that ask for anything. "off" clears and "private" claims — neither has a form. */
type FormKind = Exclude<RemoteKind, "off" | "private">;

function wrap(text: string, width = 74): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      if (line && line.length + 1 + word.length > width) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines;
}

export function createRemotePane(options: RemotePaneOptions): Pane {
  const output = options.output ?? process.stdout;
  let open = false;
  let screen: Screen = { name: "menu", index: 0 };
  // Probe results arrive after the screen opens; a repaint shows them the moment they do.
  let github: GithubProbe | "pending" | null = null;
  let cloudflared: CloudflaredProbe | "pending" | null = null;
  let tailscale: TailscaleProbe | "pending" | null = null;

  // Every screen is indented two columns under a blank top line, and never scrolls (see fitScreen):
  // the top line is the first thing a short window drops.
  const write = (lines: Array<string | OptionalLine>) => {
    if (!open) return;
    output.write(CLEAR);
    const indented = lines.map((line) => (typeof line === "string" ? `  ${line}` : { ...line, text: `  ${line.text}` }));
    output.write(fitScreen([{ text: "", drop: 0 }, ...indented], output.rows, output.columns));
  };

  const check = (ok: boolean, text: string) => (ok ? `${text} ✓` : text);

  const paint = () => {
    if (!open) return;
    const s = screen;
    if (s.name === "menu") {
      const current = kindOf(options.current());
      write([
        "Reach this board from anywhere",
        "",
        ...wrap(
          "Frizz binds 127.0.0.1 and has no login. Reaching it from another device means something in front of it does the authenticating. Whatever you pick here is remembered; from then on a plain `npx frizz` serves it.",
        ),
        "",
        ...CHOICES.map((choice, index) => {
          const marker = index === s.index ? "❯" : " ";
          const title = choice.title.padEnd(18);
          const now = choice.kind === current ? `  ${DIM}(current)${RESET}` : "";
          return `${marker} ${title}${DIM}${choice.blurb}${RESET}${now}`;
        }),
        "",
        `${DIM}↑↓ move · enter choose · esc back${RESET}`,
      ]);
      return;
    }
    if (s.name === "form") {
      const head = formHead(s.kind);
      const fields = s.fields.map((field, index) => {
        const focused = index === s.focus;
        const shown = field.value || (field.placeholder ? `${DIM}${field.placeholder}${RESET}` : "");
        const cursor = focused ? "█" : "";
        return `${field.label.padEnd(10)} ${shown}${cursor}`;
      });
      write([...head, "", ...fields, ...(s.note ? ["", s.note] : []), "", `${DIM}enter ${s.kind === "frizz" ? "claim" : "save"} · tab next field · esc back${RESET}`]);
      return;
    }
    if (s.name === "busy") {
      write([s.message, "", `${DIM}working…${RESET}`]);
      return;
    }
    if (s.name === "done") {
      if (!s.link) {
        write([s.message, "", `${DIM}press any key to return${RESET}`]);
        return;
      }
      const note = `${DIM}Scan to sign in on a phone. Single use, expires in 5 minutes. Press L later for another.${RESET}`;
      // The code gets the window minus the message, the URL and the way back, the one blank below it,
      // and the indent. A terminal that does not draw block elements itself gets the glyph-free code
      // when that fits (see qr.ts). A shorter window then sheds the blank lines and the note before
      // the code can scroll (see fitScreen).
      const width = output.columns ?? 80;
      const wrapped = (text: string) => Math.max(1, Math.ceil((text.length + 2) / width));
      const qr = renderQrLines(s.link.url, { area: qrAreaOf(output, { indent: 2, rows: wrapped(s.message) + 1 + wrapped(s.link.url) + 1 }) });
      write([
        s.message,
        { text: "", drop: 4 },
        ...qr,
        { text: "", drop: 6 },
        s.link.url,
        { text: "", drop: 2 },
        { text: note, drop: 5 },
        { text: "", drop: 3 },
        `${DIM}press any key to return${RESET}`,
      ]);
      return;
    }
    write([`Could not apply that: ${s.message}`, "", `${DIM}press any key to go back${RESET}`]);
  };

  const formHead = (kind: FormKind): string[] => {
    if (kind === "frizz") {
      const gh = github === "pending" || github === null
        ? `${DIM}GitHub CLI   checking…${RESET}`
        : !github.installed
          ? "GitHub CLI   not installed — see https://cli.github.com, then `gh auth login`"
          : github.login
            ? check(true, `GitHub CLI   signed in as ${github.login}`)
            : "GitHub CLI   not signed in — run `gh auth login` in another terminal";
      return [
        "Custom frizz.sh name",
        "",
        ...wrap(
          "Claims <name>.frizz.sh of your choosing, tied to your GitHub account so names cannot be squatted. The board dials out to frizz.sh — no port, no DNS record, no tunnel binary. One name per account; a name nobody runs for 30 days is released. (A private name needs none of this.)",
        ),
        ...(options.sandbox
          ? ["", ...wrap("This is a sandbox, but a claim is real: it binds this machine's one name to your account, and your real board keeps it. Only the setup saved here is thrown away.")]
          : []),
        "",
        gh,
      ];
    }
    if (kind === "cloudflare") {
      const cf = cloudflared === "pending" || cloudflared === null
        ? `${DIM}cloudflared   checking…${RESET}`
        : cloudflared.version
          ? check(true, `cloudflared   found, ${cloudflared.version}`)
          : "cloudflared   not found — install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
      return [
        "Cloudflare Tunnel",
        "",
        "Needs a domain on Cloudflare and cloudflared on this machine.",
        cf,
        "",
        "Create the tunnel and its DNS record once, in another terminal:",
        "",
        "  cloudflared tunnel login",
        "  cloudflared tunnel create my-board",
        "  cloudflared tunnel route dns my-board board.example.com",
        "",
        ...wrap(
          `Point it at http://127.0.0.1:${options.port} in ~/.cloudflared/frizz.yml, which Frizz reads by name. Then name them here, and Frizz runs the tunnel beside the board, so the two share a lifetime.`,
        ),
      ];
    }
    if (kind === "tailscale") {
      const ts = tailscale === "pending" || tailscale === null
        ? `${DIM}tailscale   checking…${RESET}`
        : !tailscale.installed
          ? "tailscale   not found — install it from https://tailscale.com/download"
          : tailscale.dnsName
            ? check(true, `tailscale   found, this machine is ${tailscale.dnsName}`)
            : "tailscale   found, but the daemon did not answer — is it signed in?";
      return [
        "Tailscale",
        "",
        ...wrap("Serves the board on your tailnet. Tailscale terminates TLS and only devices signed into the tailnet can reach the name."),
        ts,
        "",
        "Run once, in another terminal:",
        "",
        `  tailscale serve --bg ${options.port}`,
        "",
        "Tailscale answers at the address below — that is the origin Frizz accepts.",
      ];
    }
    return [
      "Something else",
      "",
      ...wrap(
        `Terminate TLS wherever you like, proxy to http://127.0.0.1:${options.port}, and give Frizz the exact origin a browser will show — scheme and host, no path. Frizz answers only to that Host and prints a single-use sign-in link.`,
      ),
    ];
  };

  const openForm = (kind: FormKind) => {
    const current = options.current();
    const same = kindOf(current) === kind ? current : null;
    let fields: Field[];
    if (kind === "frizz") {
      github = "pending";
      void options.probes.github().then((result) => {
        github = result;
        if (screen.name === "form" && screen.kind === "frizz" && !screen.fields[0]!.value && result.login) {
          screen.fields[0]!.placeholder = result.login;
        }
        paint();
      });
      fields = [{ label: "Name", value: same?.claim ?? "" }];
    } else if (kind === "cloudflare") {
      cloudflared = "pending";
      void options.probes.cloudflared().then((result) => {
        cloudflared = result;
        paint();
      });
      fields = [
        { label: "Hostname", value: same?.hostname ?? "", placeholder: "board.example.com" },
        { label: "Tunnel", value: same?.tunnel ?? "", placeholder: "my-board" },
      ];
    } else if (kind === "tailscale") {
      tailscale = "pending";
      void options.probes.tailscale().then((result) => {
        tailscale = result;
        if (screen.name === "form" && screen.kind === "tailscale" && !screen.fields[0]!.value && result.dnsName) {
          screen.fields[0]!.placeholder = `https://${result.dnsName}`;
        }
        paint();
      });
      fields = [{ label: "Origin", value: same ? `https://${same.hostname}` : "", placeholder: "https://mac-mini.your-tailnet.ts.net" }];
    } else {
      fields = [{ label: "Origin", value: same ? `https://${same.hostname}` : "", placeholder: "https://board.example.com" }];
    }
    screen = { name: "form", kind, fields, focus: 0 };
    paint();
  };

  const valueOf = (field: Field): string => field.value || field.placeholder || "";

  // Every change goes through applyRemoteChoice (remote-setup.ts), the same path Settings → Remote
  // access takes, so the two surfaces cannot drift on what a choice means.
  const run = async (choice: RemoteChoice, back: Screen) => {
    try {
      const next = await applyRemoteChoice(choice, {
        apply: options.apply,
        claim: options.claim,
        progress: (message) => {
          screen = { name: "busy", message };
          paint();
        },
      });
      options.onChanged?.(next);
      screen = next
        ? { name: "done", message: `Serving https://${next.hostname} (${describeCloudConfig(next)}).`, link: options.issueLink(), config: next }
        : { name: "done", message: "Loopback only. This board is reachable from this machine alone.", link: null, config: null };
    } catch (error) {
      screen = { name: "error", message: error instanceof Error ? error.message : String(error), back };
    }
    paint();
  };

  const submit = (form: Extract<Screen, { name: "form" }>) => {
    const first = valueOf(form.fields[0]!);
    const choice: RemoteChoice =
      form.kind === "frizz"
        ? { kind: "frizz", name: first }
        : form.kind === "cloudflare"
          ? { kind: "cloudflare", hostname: first, tunnel: valueOf(form.fields[1]!) }
          : { kind: form.kind, origin: first };
    return run(choice, form);
  };

  // No form and nothing to ask: the name is minted, so choosing this IS the claim.
  const claimPrivate = () => run({ kind: "private" }, { name: "menu", index: 0 });

  const turnOff = () => run({ kind: "off" }, { name: "menu", index: CHOICES.length - 1 });

  return {
    open() {
      open = true;
      const current = kindOf(options.current());
      screen = { name: "menu", index: Math.max(0, CHOICES.findIndex((choice) => choice.kind === current)) };
      output.write(ALT_SCREEN_ON);
      output.write(HIDE_CURSOR);
      paint();
      return true;
    },
    key(key) {
      const s = screen;
      if (s.name === "busy") return "keep";
      if (s.name === "done") return "close";
      if (s.name === "error") {
        screen = s.back;
        paint();
        return "keep";
      }
      if (s.name === "menu") {
        if (key === ESC || key === "q") return "close";
        if (key === UP || key === "k") s.index = (s.index + CHOICES.length - 1) % CHOICES.length;
        else if (key === DOWN || key === "j") s.index = (s.index + 1) % CHOICES.length;
        else if (/^[1-6]$/.test(key)) s.index = Number(key) - 1;
        else if (ENTER.has(key)) {
          const choice = CHOICES[s.index]!;
          if (choice.kind === "off") void turnOff();
          else if (choice.kind === "private") void claimPrivate();
          else openForm(choice.kind);
          return "keep";
        }
        paint();
        return "keep";
      }
      // A form.
      if (key === ESC) {
        screen = { name: "menu", index: CHOICES.findIndex((choice) => choice.kind === s.kind) };
        paint();
        return "keep";
      }
      const field = s.fields[s.focus]!;
      if (ENTER.has(key)) {
        if (s.focus < s.fields.length - 1 && valueOf(field)) s.focus += 1;
        else void submit(s);
      } else if (key === TAB || key === DOWN) s.focus = (s.focus + 1) % s.fields.length;
      else if (key === SHIFT_TAB || key === UP) s.focus = (s.focus + s.fields.length - 1) % s.fields.length;
      else if (BACKSPACE.has(key)) field.value = field.value.slice(0, -1);
      else if (key.length === 1 && key >= " ") field.value += key;
      else if (!key.startsWith(ESC)) field.value += key.replace(/[\r\n\t]/g, "");
      paint();
      return "keep";
    },
    close() {
      if (!open) return;
      open = false;
      output.write(ALT_SCREEN_OFF);
      output.write(SHOW_CURSOR);
    },
  };
}
