import type { FrizzPlugin, PluginEffort, PluginThreadRow, ProjectHost } from "../../packages/server/src/plugins/api.ts"

// LAZY THREADS, as the first Frizz plugin (plans/upstream-superset.md §7, step 9).
//
// A lazy thread is a thread written down without starting an agent: a note to come back to, marked done, or
// launched later by sending it a message (plans/lazy-threads.md, 2026-10-01). It shipped in base; on
// 2026-10-06 it moved here, and base kept the one primitive it is built on — the HELD thread
// (SessionRow.held_by): a row with a name and a session id and no agent, which base never tails, never
// queues, and starts in place on a message. Everything that makes such a row a LAZY thread is this file:
//
//   · its NOTE, in the plugin's own database (`<data>/plugin-data/lazy.db`), keyed by project + slug + the
//     session id it was written for. A thread written down before the move carried its note in base's
//     legacy column (`session.lazy_prompt`), and base's migration handed those rows to this plugin
//     (`held_by = 'lazy'`); `project()` imports each one's note from there the first time it sees it.
//     Base's copy is kept in step on every edit (`threads.setPrompt`), so a thread whose plugin is removed
//     still starts on the latest words, and an older Frizz rolled back to still shows them;
//   · that it QUEUES: base's rule is that a thread with no agent never shows up in the queue, and this
//     plugin's threadView says otherwise for its own — a lazy thread is waiting on the human, exactly like a
//     bare rest — unless it is done or snoozed;
//   · create / update / start, the procedures its web half calls (web.ts);
//   · onSend: a message sent to a lazy thread starts it with that message and drops the note, which IS
//     the message by then; threadDeleted drops the note of a thread deleted unstarted.
//
// Types only from Frizz (the loader's contract, plugins/api.ts): zod arrives as `host.z`.

const MIGRATIONS = [
  `CREATE TABLE note (
    project_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    session_id TEXT NOT NULL,
    text TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, slug)
  )`,
]

const ID = "lazy"

const plugin: FrizzPlugin = {
  setup(host) {
    const { z } = host
    const db = host.db(MIGRATIONS)
    const readNote = db.prepare<{ text: string }>("SELECT text FROM note WHERE project_id = ? AND slug = ? AND session_id = ?")
    const writeNote = db.prepare(`
      INSERT INTO note (project_id, slug, session_id, text, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, slug) DO UPDATE SET session_id = excluded.session_id, text = excluded.text, updated_at = excluded.updated_at
    `)
    const dropNote = db.prepare("DELETE FROM note WHERE project_id = ? AND slug = ?")

    const stored = (project: ProjectHost, row: Pick<PluginThreadRow, "slug" | "sessionId">) =>
      readNote.get(project.project.id, row.slug, row.sessionId)?.text
    const write = (project: ProjectHost, row: Pick<PluginThreadRow, "slug" | "sessionId">, text: string) =>
      void writeNote.run(project.project.id, row.slug, row.sessionId, text, new Date().toISOString())
    const drop = (project: ProjectHost, slug: string) => void dropNote.run(project.project.id, slug)
    /** The note: ours, or — for a thread written down before this plugin, not yet imported — base's copy. */
    const noteOf = (project: ProjectHost, row: PluginThreadRow) => stored(project, row) ?? project.threads.legacyNote(row) ?? ""

    /** A thread this plugin holds, by the caller's slug and session id — or the refusal the human reads. */
    function mine(project: ProjectHost, slug: string, sessionId: string): PluginThreadRow {
      const row = project.threads.get(slug)
      if (!row || row.sessionId !== sessionId) return host.refuse("This thread is gone")
      if (row.heldBy !== ID) return host.refuse("This thread has already started")
      return row
    }

    async function start(project: ProjectHost, row: PluginThreadRow, prompt: string, profile: Profile = {}) {
      const started = await project.threads.start(row, prompt, {
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.backend ? { backend: profile.backend } : {}),
        ...(profile.effort ? { effort: profile.effort as PluginEffort } : {}),
      })
      // Started: the note was its first message, and the thread is an ordinary one now.
      drop(project, row.slug)
      return started
    }

    const ProfileFields = {
      model: z.string().optional(),
      backend: z.enum(["claude", "codex", "acp"]).optional(),
      // Base validates the level at dispatch (DispatchInput.effort); a plugin keeps no copy of that list.
      effort: z.string().optional(),
    }
    type Profile = { model?: string; backend?: "claude" | "codex" | "acp"; effort?: string }

    return {
      procedures: {
        // Write a lazy thread down: a held row, no agent, its note here. The profile is the prompt box's pick,
        // and is what the agent starts on unless changed then.
        create: {
          kind: "mutation",
          input: z.object({ prompt: z.string().trim().min(1), title: z.string().min(1).optional(), ...ProfileFields }),
          handler(input, project) {
            const created = project.threads.create({
              prompt: input.prompt,
              ...(input.title ? { title: input.title } : {}),
              ...(input.model ? { model: input.model } : {}),
              ...(input.backend ? { backend: input.backend } : {}),
              ...(input.effort ? { effort: input.effort as PluginEffort } : {}),
            })
            write(project, created, input.prompt)
            return created
          },
        },
        // Rewrite the note as it is typed. Refused once the thread has started: the note was its first message.
        update: {
          kind: "mutation",
          human: true,
          input: z.object({ slug: z.string(), sessionId: z.string().min(1), note: z.string() }),
          handler(input, project) {
            const row = mine(project, input.slug, input.sessionId)
            write(project, row, input.note)
            project.threads.setPrompt(row, input.note)
            project.refresh()
          },
        },
        // Start the agent with `prompt` as its opening message — usually the note, edited in the box first.
        start: {
          kind: "mutation",
          human: true,
          input: z.object({ slug: z.string(), sessionId: z.string().min(1), prompt: z.string().min(1), ...ProfileFields }),
          handler: (input, project) => start(project, mine(project, input.slug, input.sessionId), input.prompt, input),
        },
      },

      // Import the note of every lazy thread written down before this plugin existed (or while it was off),
      // from base's legacy column. Once per thread: after this, the note here is the truth.
      project(project) {
        let imported = 0
        for (const row of project.threads.held()) {
          if (stored(project, row) !== undefined) continue
          write(project, row, project.threads.legacyNote(row) ?? "")
          imported++
        }
        if (imported) host.log.info(`${project.project.name}: imported the notes of ${imported} lazy thread${imported === 1 ? "" : "s"}`)
      },

      threadView(view, row, project) {
        if (row.heldBy !== ID) return view
        return {
          ...view,
          // Waiting on the human like a bare rest, so it queues — unless it is done or snoozed.
          needsYou: !view.archived && view.snoozedUntil === undefined && view.schedule?.pending !== true,
          plugins: { ...view.plugins, [ID]: { note: noteOf(project, row) } },
        }
      },

      async onSend(row, message, project) {
        await start(project, row, message)
      },

      on: {
        threadDeleted(event, project) {
          drop(project, event.slug)
        },
      },
    }
  },
}

export default plugin
