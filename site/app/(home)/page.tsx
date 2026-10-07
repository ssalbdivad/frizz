import {
  AlarmClock,
  ArrowRight,
  AtSign,
  Code2,
  GitPullRequest,
  Repeat,
  Smartphone,
  SquareTerminal,
  Target,
  Timer,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Install } from "@/components/install";
import { Mark } from "@/components/mark";
import { Shot } from "@/components/shot";
import { githubUrl } from "@/lib/layout.shared";

// every card names one thing Frizz does, in a line, and links to the page that says the rest
const features = [
  { icon: AlarmClock, title: "Snooze", text: "Park a card until tomorrow, with what to do when it wakes.", href: "/docs/snooze" },
  { icon: Target, title: "Goals", text: "“Keep going until CI is green”, re-sent at every rest.", href: "/docs/goals" },
  { icon: Repeat, title: "Schedules", text: "“Every weekday at 9am” starts a fresh thread each time.", href: "/docs/schedules" },
  { icon: Timer, title: "Time limits", text: "“2h”, and the agent plans the best result by then.", href: "/docs/time-limits" },
  { icon: AtSign, title: "Handles", text: "Threads read and message each other by @handle.", href: "/docs/handles" },
  { icon: SquareTerminal, title: "Terminals", text: "A shell in the folder the agent works in, on t.", href: "/docs/terminals" },
  { icon: GitPullRequest, title: "GitHub", text: "Issues into threads, and watchers that wake on CI.", href: "/docs/github" },
  { icon: Code2, title: "Your editor", text: "A VS Code sidebar that sends your selection along.", href: "/docs/editor" },
  { icon: Smartphone, title: "Your phone", text: "The same queue, answered with a tap.", href: "/docs/phone" },
];

const nots = [
  { title: "Not a model.", text: "Frizz drives the CLIs you already have signed in, on your subscription." },
  { title: "Not a cloud.", text: "No account, no telemetry. The server binds localhost, and its state stays out of your repo." },
  { title: "Not a workflow.", text: "No worktrees, branches or build steps behind your back. A thread is a session you could have started." },
];

const agents = ["Claude Code", "Codex", "OpenCode", "Gemini CLI", "Copilot CLI", "Cursor", "goose", "Qwen Code"];

const remoteMenu = `  Reach this board from anywhere

  ❯ Private name        no account, nothing to install
    Custom name         <name>.frizz.sh
    Cloudflare Tunnel   a domain you own
    Tailscale           your tailnet
    Something else      any proxy you run
    Off                 loopback only`;

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-6xl px-6">
      <section className="grid items-center gap-12 pt-16 pb-20 md:grid-cols-[1fr_1.35fr] md:pt-24">
        <div>
          <h1 className="sr-only">Frizz</h1>
          <Mark className="h-auto w-24 md:w-28" />
          <p className="mt-8 text-3xl leading-tight font-semibold tracking-tight text-balance md:text-4xl">
            An opinionated agent console for extreme productivity.
          </p>
          <p className="mt-4 text-lg text-fd-muted-foreground text-balance">
            Run Claude Code, Codex and any ACP agent from one browser tab. Every agent that needs you becomes a card
            in one queue.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/docs/quick-start"
              className="inline-flex h-11 items-center gap-2 rounded-full bg-fd-primary px-5 font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
            >
              Get started <ArrowRight className="size-4" />
            </Link>
            <Install />
          </div>
        </div>
        <Shot
          src="/img/board.png"
          width={1760}
          height={1100}
          priority
          alt="The Frizz board: projects and their threads on the left, the prompt box, and a queue card where an agent asks a question with lettered options."
        />
      </section>

      <section className="pb-16">
        <p className="text-center text-sm text-fd-muted-foreground">Drives the agents you already use</p>
        <ul className="mt-4 flex flex-wrap justify-center gap-x-8 gap-y-2 font-mono text-sm text-fd-foreground/80">
          {agents.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      </section>

      <Split
        title="One queue, not ten terminals."
        link={{ href: "/docs/queue", text: "How the queue works" }}
        media={
          <Shot
            src="/img/question.png"
            width={1600}
            height={590}
            alt="A queue card asking whether the settings store should use SQLite or a JSON file, with lettered options and the first marked recommended."
          />
        }
      >
        <p>
          A worker runs until it reaches something only you can settle, then hands back a question with lettered
          options and its own recommendation. One keystroke answers it.
        </p>
        <p>
          Threads waiting on their own sub-agents, on CI or on a review stay out of the queue, so nothing shows up just
          to be dismissed. A question you leave alone takes the recommended option after ten minutes.
        </p>
      </Split>

      <Split
        title="Every project, one page."
        flip
        link={{ href: "/docs/projects", text: "Projects" }}
        media={
          <Shot
            src="/img/projects.png"
            width={1760}
            height={1100}
            alt="The All projects page: projects listed with their threads beneath them, and every project's queue cards beside them."
          />
        }
      >
        <p>
          One server serves every repo on your machine. Run <Code>npx frizz</Code> in a second one and it joins the
          page, with its own threads and settings.
        </p>
        <p>
          Each agent runs in its own background process. Close the tab or stop Frizz, and it keeps working; relaunch,
          and Frizz reconnects.
        </p>
      </Split>

      <section className="py-16">
        <Heading title="Built for the long run." subtitle="The parts that let a thread work without you." />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, text, href }) => (
            <Link
              key={title}
              href={href}
              className="group flex flex-col rounded-2xl border border-fd-border bg-fd-card p-5 transition-colors hover:border-[var(--gold)]"
            >
              <Icon className="size-5 text-[var(--gold)]" />
              <span className="mt-3 font-semibold">{title}</span>
              <span className="mt-1 text-sm text-fd-muted-foreground">{text}</span>
            </Link>
          ))}
        </div>
      </section>

      <Split
        title="Schedules, in plain words."
        link={{ href: "/docs/schedules", text: "Schedules" }}
        media={
          <Shot src="/img/schedule.png" width={1600} height={1000} alt="A schedule in Frizz." />
        }
      >
        <p>
          Type &ldquo;every weekday at 9am triage new issues&rdquo; and the prompt box reads the schedule as you type,
          showing when it next runs. Each run starts a fresh thread that lands in the queue like any other.
        </p>
      </Split>

      <Split
        title="Go until 3:30."
        flip
        link={{ href: "/docs/time-limits", text: "Time limits" }}
        media={
          <Shot src="/img/time-limit.png" width={1600} height={1000} alt="A thread with a time limit in Frizz." />
        }
      >
        <p>
          Give a thread &ldquo;2h&rdquo; or &ldquo;15:30&rdquo;. The agent plans for the best result it can hand over
          by then, gets reminders as time runs out, and passes a share of it to its sub-agents. The card counts down.
        </p>
      </Split>

      <section className="grid gap-10 py-16 md:grid-cols-[1fr_1.1fr] md:items-center">
        <div>
          <Heading title="From your phone, too." />
          <div className="mt-5 space-y-4 text-lg text-fd-muted-foreground">
            <p>
              Press <Code>R</Code> in the terminal running Frizz and pick how a phone reaches it. A private frizz.sh
              name needs no account and nothing installed.
            </p>
            <p>
              Frizz stays on localhost either way, and the first visit from each device needs a single-use sign-in
              link, shown as a QR code.
            </p>
          </div>
          <More href="/docs/remote-access">Remote access</More>
        </div>
        <div className="overflow-hidden rounded-2xl border border-fd-border bg-fd-card shadow-xl shadow-black/10">
          <div className="flex items-center gap-2 border-b border-fd-border px-4 py-3">
            <span className="size-3 rounded-full bg-fd-border" />
            <span className="size-3 rounded-full bg-fd-border" />
            <span className="size-3 rounded-full bg-[var(--gold)]" />
            <span className="ml-2 font-mono text-xs text-fd-muted-foreground">npx frizz</span>
          </div>
          <pre className="overflow-x-auto p-5 font-mono text-[0.8rem] leading-relaxed">{remoteMenu}</pre>
        </div>
      </section>

      <section className="py-16">
        <Heading title="What it is not." />
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {nots.map(({ title, text }) => (
            <div key={title} className="rounded-2xl border border-dashed border-fd-border p-5">
              <span className="font-semibold">{title}</span>
              <p className="mt-1 text-sm text-fd-muted-foreground">{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col items-center py-24 text-center">
        <p className="text-lg text-fd-muted-foreground">Ready to clear your queue?</p>
        <div className="mt-6">
          <Install />
        </div>
        <Link href="/docs/quick-start" className="mt-6 inline-flex items-center gap-2 font-medium text-[var(--gold)] hover:underline">
          Read the quick start <ArrowRight className="size-4" />
        </Link>
      </section>

      <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-fd-border py-8 text-sm text-fd-muted-foreground">
        <span>
          MIT licensed. By{" "}
          <a href="https://x.com/colinhacks" className="hover:text-fd-foreground">
            @colinhacks
          </a>
          .
        </span>
        <span className="flex gap-5">
          <Link href="/docs" className="hover:text-fd-foreground">
            Docs
          </Link>
          <a href={githubUrl} className="hover:text-fd-foreground">
            GitHub
          </a>
          <a href="https://www.npmjs.com/package/frizz" className="hover:text-fd-foreground">
            npm
          </a>
        </span>
      </footer>
    </main>
  );
}

function Heading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div>
      <h2 className="text-3xl font-semibold tracking-tight text-balance md:text-4xl">{title}</h2>
      {subtitle && <p className="mt-2 text-lg text-fd-muted-foreground">{subtitle}</p>}
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-fd-foreground">{children}</code>;
}

function More({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="mt-6 inline-flex items-center gap-2 font-medium text-[var(--gold)] hover:underline">
      {children} <ArrowRight className="size-4" />
    </Link>
  );
}

// a heading and its prose beside a screenshot; `flip` puts the picture on the left, so consecutive sections alternate
function Split({
  title,
  children,
  media,
  link,
  flip,
}: {
  title: string;
  children: ReactNode;
  media: ReactNode;
  link: { href: string; text: string };
  flip?: boolean;
}) {
  return (
    <section className="grid gap-10 py-16 md:grid-cols-[1fr_1.3fr] md:items-center">
      <div className={flip ? "md:order-2" : undefined}>
        <Heading title={title} />
        <div className="mt-5 space-y-4 text-lg text-fd-muted-foreground">{children}</div>
        <More href={link.href}>{link.text}</More>
      </div>
      <div className={flip ? "md:order-1" : undefined}>{media}</div>
    </section>
  );
}
