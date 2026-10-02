import { useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query"
import { useSnapshot } from "valtio"
import { ArrowLeft, Check, ChevronRight, Copy } from "lucide-react"
import { type Settings } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { store, type ConnectionState } from "../store.ts"
import { copyTextToClipboard } from "../lib/clipboard.ts"
import { prefs } from "../lib/prefs.ts"
import { getThemeSnapshot, setThemePreference, subscribeTheme, type ThemePreference } from "../lib/theme.ts"
import { registerSettingsClose } from "../lib/overlays.ts"
import { SETTINGS_HELP, SETTINGS_HELP_IN_EDITOR } from "../lib/settingsHelp.ts"
import { SHEET_CLOSE_MS, SHEET_PANEL_CLASS, SHEET_SCRIM_CLASS, prefersReducedMotion } from "../lib/sheet.ts"
import { SaveStatus, useSettingsDraft, type SaveState } from "../hooks/useSettingsAutosave.tsx"
import { useIsMobile } from "../lib/mobile.ts"
import { SNOOZE_PRESETS, isSnoozePreset } from "../lib/snooze.ts"
import { EDITOR_OPENER_LABEL, codeFilesDestination, connectedOpeners } from "../lib/editorWindows.ts"
import { useSupervisorStatus } from "../api/supervisorStatus.ts"
import { isRemoteSession } from "../api/signOut.ts"
import { SignOutThisDeviceRow } from "./SignOutThisDeviceRow.tsx"
import { RemoteAccessField } from "./RemoteAccessField.tsx"
import { QuotaMeters } from "./QuotaBar.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"
import { Select } from "./ui/Select.tsx"
import { SettingsField } from "./SettingsField.tsx"
import { DeleteOldThreads, RETENTION_DAYS } from "./DeleteOldThreads.tsx"
import { embedded } from "../lib/embed.ts"
import { aboveDrawersZ } from "../lib/overlaySurface.ts"

type NotifPerm = "default" | "granted" | "denied" | "unsupported"
function currentPerm(): NotifPerm {
  if (typeof Notification === "undefined") return "unsupported"
  return Notification.permission as NotifPerm
}

// The drawer holds ONLY what belongs to the machine and this browser — appearance, the rail, how local
// links open, density, queue order, notifications, and the folder the Home workspace's threads run in. Everything that belongs to a project or to one
// runtime is edited where it applies: a runtime's launch settings behind the gear on its band in the
// model picker (AgentSettingsPopover), the GitHub triage prompt behind the gear in the GitHub picker's
// header (GithubPromptPopover). A "Project settings" tab stood here for a few hours on 2026-09-19
// carrying that prompt a second time; the maintainer's call was that moving a setting to its context
// means it no longer lives here at all, so the tab strip went with it.
export function SettingsDrawer() {
  const { draft, update, saveState, flush } = useSettingsDraft()
  const isMobile = useIsMobile()
  // AN EDITOR'S SIDEBAR GETS THIS DRAWER, the desktop's, the frame's full width (lib/mobile.ts: a sidebar is
  // never the phone). Four rows behave differently there, and each says so in the field's own hint type
  // rather than offering a control that would not do what it says.
  const inEditor = embedded()
  // ABOVE AN OPEN THREAD, as Escape already ranks it (DrawerStack): at a fixed z-50 it slid in UNDER the
  // drawer stack, whose layers climb from 50 — ⌘, or the gear over a thread drew nothing, and in an
  // editor's sidebar the title row's Settings button looked dead (scripts/e2e-sidebar.ts, 5 of 5). The
  // New thread dialog's tier (lib/overlaySurface.ts aboveDrawersZ), which also keeps toasts and its
  // own selects above it.
  const z = aboveDrawersZ(useSnapshot(store).drawers.length)
  const [perm, setPerm] = useState<NotifPerm>(currentPerm())
  // The Home workspace's square, its picker row and its project list entry all show its folder, and they
  // read it from the project list — so the list is re-read once a moved folder has actually saved.
  const queryClient = useQueryClient()
  const [folderSaved, setFolderSaved] = useState(true)
  useEffect(() => {
    if (folderSaved || saveState !== "saved") return
    setFolderSaved(true)
    void queryClient.invalidateQueries({ queryKey: ["projectsList"] })
    void queryClient.invalidateQueries({ queryKey: ["projectsQueues"] })
  }, [folderSaved, saveState, queryClient])

  // Enter/exit animation. `shown` drives the slide (mount → next frame flips it true → slides in;
  // close flips it false → slides out). App renders <SettingsDrawer> only while showSettings is true,
  // so we keep ourselves mounted through the exit by delaying the store write until the slide ends.
  const [shown, setShown] = useState(false)
  const [closing, setClosing] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [])

  // Let App's window-level Esc handler trigger THIS animated close (slide-out) rather than flipping the
  // store flag and unmounting instantly. `close` is a hoisted declaration, so referencing it here is safe.
  useEffect(() => {
    registerSettingsClose(close)
    return () => registerSettingsClose(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function close() {
    if (closing) return
    // Send whatever is still sitting in the debounce before the drawer goes away.
    flush()
    setClosing(true)
    setShown(false)
    window.setTimeout(() => (store.showSettings = false), prefersReducedMotion() ? 0 : SHEET_CLOSE_MS)
  }

  // Turning notifications on requests browser permission if not yet decided; we keep the toggle
  // truthful about the OS-level grant so a green checkbox can't imply notifications that won't fire.
  async function toggleNotifications(on: boolean) {
    if (!draft) return
    // Not from an editor's sidebar: a frame is never granted the permission, so asking only records a
    // refusal against Frizz's origin. The setting itself is the machine's, and stands (see below).
    if (on && !inEditor && typeof Notification !== "undefined" && Notification.permission === "default") {
      const result = (await Notification.requestPermission()) as NotifPerm
      setPerm(result)
    }
    update({ ...draft, notifications: on })
  }

  if (isMobile) {
    return (
      <MobileSettingsPage
        shown={shown}
        onClose={close}
        saveState={saveState}
        notifications={draft ? draft.notifications : null}
        onNotifications={toggleNotifications}
        perm={perm}
      />
    )
  }

  return (
    <div
      className={`${SHEET_SCRIM_CLASS} flex justify-end ${shown ? "opacity-100" : "opacity-0"}`}
      style={{ zIndex: z }}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        className={`${SHEET_PANEL_CLASS} w-[560px] max-w-[94vw] ${shown ? "translate-x-0" : "translate-x-full"}`}
      >
        <SheetHeader title="Settings" actions={<SaveStatus state={saveState} />} onClose={close} />

        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-6">
          {/* Browser appearance remains usable even while server settings are unavailable. */}
          <SettingsField label="Appearance" help={inEditor ? SETTINGS_HELP_IN_EDITOR.appearance : SETTINGS_HELP.appearance}>
            {/* The editor's theme, for the session (lib/theme.ts setHostTheme): a choice here would be saved
                and never shown. */}
            {inEditor ? <EditorFixed name="appearance">Follows your editor</EditorFixed> : <AppearanceControl />}
          </SettingsField>
          {!draft ? (
            <div className="text-[13px] text-muted">Loading server settings…</div>
          ) : (
            <>
            {/* A client-only VIEW preference (localStorage, not server Settings): it never travels to
                the server at all, so it's wired straight to the prefs proxy rather than the draft. */}
            {/* In an editor's sidebar that localStorage is the FRAME's, partitioned from the browser's, so a
                choice here is the sidebar's alone — said under each, since nothing else would tell you. */}
            <SettingsField label="Density" help={SETTINGS_HELP.density}>
              <DensityToggle />
              {inEditor ? <EditorHint>Your browser keeps its own.</EditorHint> : null}
            </SettingsField>

            {/* Client-only VIEW preference (localStorage): applies immediately, wired to prefs. */}
            <SettingsField label="Queue order" help={SETTINGS_HELP.queueOrder}>
              <QueueOrderControl />
              {inEditor ? <EditorHint>Your browser keeps its own.</EditorHint> : null}
            </SettingsField>

            {/* Same segmented Off/On control as every other row (the old bare checkbox matched
                nothing else in the form). Off left, On right — switch convention. */}
            {/* The machine's setting, so it is changed here as anywhere; but a frame cannot raise a
                notification (api/board-stream.ts stands down in embed), so the browser does. */}
            <SettingsField label="Desktop notifications" help={SETTINGS_HELP.notifications}>
              <OnOffToggle value={draft.notifications} onChange={toggleNotifications} />
              {inEditor ? <EditorHint>Shown in your browser, not in the sidebar.</EditorHint> : draft.notifications && <PermHint perm={perm} />}
            </SettingsField>

            <SettingsField label="Home folder" help={SETTINGS_HELP.homeFolder}>
              <HomeFolderField
                value={draft.homeFolder ?? ""}
                onCommit={(homeFolder) => {
                  setFolderSaved(false)
                  update({ ...draft, homeFolder })
                }}
              />
            </SettingsField>

            <SettingsField label="Worktree folder" help={SETTINGS_HELP.worktreeDir}>
              <WorktreeDirField value={draft.worktreeDir ?? ""} onCommit={(worktreeDir) => update({ ...draft, worktreeDir })} />
            </SettingsField>

            <SettingsField label="Remove worktrees when done" help={SETTINGS_HELP.removeWorktreesOnDone}>
              <OnOffToggle
                value={draft.removeWorktreesOnDone ?? true}
                onChange={(removeWorktreesOnDone) => update({ ...draft, removeWorktreesOnDone })}
              />
            </SettingsField>

            <SettingsField label="Delete done threads" help={SETTINGS_HELP.deleteDoneThreadsUntouchedDays}>
              <Select
                variant="bordered"
                value={String(draft.deleteDoneThreadsUntouchedDays ?? 0)}
                onValueChange={(v) => update({ ...draft, deleteDoneThreadsUntouchedDays: Number(v) })}
                options={[{ value: "0", label: "Never" }, ...RETENTION_DAYS.map((days) => ({ value: String(days), label: `Untouched for ${days}d` }))]}
                indicatorPosition="right"
                ariaLabel="Delete done threads automatically"
              />
            </SettingsField>

            <SettingsField label="Delete untouched threads now" help={SETTINGS_HELP.deleteOldThreads}>
              <DeleteOldThreads />
            </SettingsField>

            {/* Renders nothing on a page reached through the public origin: the supervisor answers it
                over loopback only (RemoteAccessField.tsx). */}
            <RemoteAccessField />

            {/* LAST, on purpose: where a vetted local path opens is the one power-user pair in the
                drawer, so it sits below everything an ordinary operator adjusts. */}
            {/* Client-only (prefs): where a click on a code file goes, in this browser. The app it
                goes to is the machine-wide select just below, which it reads as a pair with. */}
            <SettingsField label="Open code files" help={SETTINGS_HELP.codeFiles}>
              {/* From the sidebar a code file opens in the editor around it, whatever this says
                  (lib/local-file-links.ts); the choice is a browser's. */}
              {inEditor ? <EditorFixed name="code-files">In this window</EditorFixed> : <CodeFilesControl opener={draft.localFileOpener} />}
            </SettingsField>

            <SettingsField label="External app" help={SETTINGS_HELP.localFileOpener}>
              <Select
                variant="bordered"
                value={draft.localFileOpener ?? "system"}
                onValueChange={(v) => update({ ...draft, localFileOpener: v as Settings["localFileOpener"] })}
                options={[
                  { value: "system", label: "System default" },
                  { value: "cursor", label: "Cursor" },
                  { value: "vscode", label: "VS Code" },
                  { value: "editor", label: "$EDITOR" },
                  { value: "finder", label: "Reveal in Finder" },
                  { value: "copy", label: "Copy path" },
                ]}
                indicatorPosition="right"
                ariaLabel="Local file link opener"
              />
              {inEditor ? <EditorHint>Code files from the sidebar open in this window.</EditorHint> : null}
              <EditorConnectedHint />
            </SettingsField>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Settings → Home folder: where the Home workspace's agents run.
 *
 * WRITTEN ON ENTER OR ON LEAVING THE FIELD, never per keystroke — half a path is not a folder — and
 * only once the server has passed it. Every settings write carries the WHOLE object, so a draft holding
 * a folder the save refuses would fail every later write in this drawer along with it. The line under
 * the field is the server's own reading of what is typed (`~` expanded on the machine that runs the
 * agents, a registered project's folder refused), so what it says is exactly what saving would do.
 */
function HomeFolderField({ value, onCommit }: { value: string; onCommit: (folder: string) => void }) {
  const [text, setText] = useState(value)
  const typed = useDeferredValue(text.trim())
  const queryClient = useQueryClient()
  const check = useQuery({
    queryKey: ["homeFolderCheck", typed],
    queryFn: () => rpc.homeFolderCheck({ folder: typed }),
    placeholderData: keepPreviousData,
    staleTime: 2_000,
  })
  const commit = async () => {
    const folder = text.trim()
    if (folder === value.trim()) return
    const verdict = await queryClient.fetchQuery({
      queryKey: ["homeFolderCheck", folder],
      queryFn: () => rpc.homeFolderCheck({ folder }),
      staleTime: 0,
    })
    if (!verdict.problem) onCommit(folder)
  }
  // Esc closes the drawer without blurring the field, and an unmount fires no blur — so what was typed
  // is committed on the way out too, as a pending debounce is flushed (useSettingsAutosave).
  const commitRef = useRef(commit)
  commitRef.current = commit
  useEffect(() => () => void commitRef.current(), [])
  const reading = check.data
  return (
    <div>
      <input
        aria-label="Home folder"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") void commit()
        }}
        placeholder="~"
        spellCheck={false}
        autoComplete="off"
        // The bordered Select's own box (ui/Select.tsx), so the field stands in the drawer's column as one
        // of its controls; mono because what it holds is a path.
        className={`w-full rounded-md border bg-bg px-2 py-1 font-mono text-[12px] text-fg outline-none placeholder:text-muted-50 focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${
          reading?.problem ? "border-danger-fill/60" : "border-border"
        }`}
      />
      {/* Always a line tall, so the drawer does not jump as the reading comes and goes. The notification
          field's hint type (PermHint), at the same 6px from its control. It WRAPS where it does not fit, the
          path breaking anywhere: the folder is the whole reading, and truncated in a 300px sidebar it was the
          part cut ("…run in /tmp/frizz-a…"). */}
      <p className={`mt-1.5 min-h-[1.4em] break-words text-[11px] ${reading?.problem ? "text-danger" : "text-muted-70"}`}>
        {reading ? reading.problem ?? `Threads started in Home run in ${reading.folder}` : ""}
      </p>
    </div>
  )
}

/**
 * Settings → Worktree folder. Committed on Enter or blur like the Home folder, but with nothing for the
 * server to check: a relative value names a folder inside whichever repository a worktree is made in,
 * so there is no one path to validate. Blank restores the default.
 */
function WorktreeDirField({ value, onCommit }: { value: string; onCommit: (dir: string) => void }) {
  const [text, setText] = useState(value)
  const commit = () => {
    const dir = text.trim() || ".frizz/worktrees"
    setText(dir)
    if (dir !== value.trim()) onCommit(dir)
  }
  const commitRef = useRef(commit)
  commitRef.current = commit
  useEffect(() => () => commitRef.current(), [])
  return (
    <input
      aria-label="Worktree folder"
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit()
      }}
      placeholder=".frizz/worktrees"
      spellCheck={false}
      autoComplete="off"
      className="w-full rounded-md border border-border bg-bg px-2 py-1 font-mono text-[12px] text-fg outline-none placeholder:text-muted-50 focus-visible:ring-1 focus-visible:ring-focus-ink-60"
    />
  )
}

// ── THE PHONE'S SETTINGS PAGE ────────────────────────────────────────────────────────────────────────
//
// Below the phone breakpoint Settings is a full page, not a sheet beside a board (phone design
// 2026-09-30, scratch/mobile-simplify/v2.html § 6). Two things differ from the desktop drawer, and each
// is the design's call:
//
//   · IT LEADS WITH THE READINGS. The board's ⋯ sheet used to carry the connection dot and the quota
//     chips; that sheet is gone and its gear opens this page, so the readings arrive here first — they
//     are what a phone opens Settings to check.
//   · IT HOLDS ONLY WHAT MEANS SOMETHING ON A PHONE. The project sidebar, diff density and local file
//     links are desktop-only rows and do not render here; the SERVER values behind them are untouched,
//     so the desktop reads exactly what it did. Snooze length is here instead: it was only settable from
//     the thread footer's Snooze ▾, which the phone's thread page no longer has.
//
// Plain full-width rows under section labels — no grouped-inset cards, no iOS chrome.

/** The live connection, in the words the board's ⋯ sheet used before this page took its reading over. */
const CONNECTION_WORD: Record<ConnectionState, { dot: string; word: string }> = {
  open: { dot: "bg-live", word: "Connected" },
  connecting: { dot: "bg-muted", word: "Connecting…" },
  closed: { dot: "bg-danger-fill", word: "Disconnected" },
}

const MOBILE_ROW = "flex min-h-[52px] items-center gap-3 border-b border-border/70 px-[18px] text-[15.5px] text-fg"

function MobileSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="m-0 px-[18px] pb-1.5 pt-[18px] text-[12.5px] font-semibold leading-[17px] text-muted">{label}</h2>
      <div className="border-t border-border/70">{children}</div>
    </section>
  )
}

/**
 * A row whose value opens the phone's own picker: the row shows the value and a chevron, and an
 * invisible native `<select>` covers the whole row, so a tap anywhere on it raises the platform's
 * wheel or list — the control a phone already knows how to drive.
 */
function MobilePickerRow<V extends string>({
  label,
  value,
  options,
  onChange,
  data,
}: {
  label: string
  value: V
  options: readonly { value: V; label: string }[]
  onChange: (value: V) => void
  data: string
}) {
  const shown = options.find((o) => o.value === value)?.label ?? value
  return (
    <label data-mobile-setting={data} className={`${MOBILE_ROW} relative`}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="flex shrink-0 items-center gap-1 text-[14px] text-muted">
        {shown}
        {/* Ink, not box: the chevron paints 6 of its 15 box px, centred. -mr-[5px] lands its ink on the
            row's 18px inset, the same right edge the theme segments and the switch draw to, and
            -ml-[3px] leaves ~6px of ink after the value (measured 9.6 → 6.6 and 23.6 → 18.6 from the
            row's edge, sans, 2026-09-30). */}
        <ChevronRight size={15} aria-hidden className="-ml-[3px] -mr-[5px]" />
      </span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as V)}
        className="absolute inset-0 cursor-pointer appearance-none opacity-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}

/** Theme as three joined segments. Each segment is 30px of ink with a 44px hit area around it. */
function MobileThemeSegments() {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeSnapshot)
  const options: { value: ThemePreference; label: string }[] = [
    { value: "system", label: "System" },
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
  ]
  return (
    <div role="radiogroup" aria-label="Theme" className="flex shrink-0 rounded-[9px] border border-border-strong">
      {options.map((o, i) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={theme.preference === o.value}
          onClick={() => setThemePreference(o.value)}
          className={`relative h-[30px] px-[11px] text-[13px] after:absolute after:inset-x-0 after:-inset-y-[7px] after:content-[''] ${
            i > 0 ? "border-l border-border-strong" : ""
          } ${i === 0 ? "rounded-l-[8px]" : ""} ${i === options.length - 1 ? "rounded-r-[8px]" : ""} ${
            theme.preference === o.value ? "bg-fg text-bg" : "text-muted"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** On/off as a switch: 40×24 of ink, the row's full height to hit. */
function MobileSwitch({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-10 shrink-0 rounded-full after:absolute after:-inset-x-2 after:-inset-y-[10px] after:content-[''] disabled:opacity-45 ${checked ? "bg-fg" : "bg-border-strong"}`}
    >
      <span className={`absolute top-[3px] size-[18px] rounded-full ${checked ? "right-[3px] bg-bg" : "left-[3px] bg-muted"}`} />
    </button>
  )
}

function MobileSettingsPage({
  shown,
  onClose,
  saveState,
  notifications,
  onNotifications,
  perm,
}: {
  shown: boolean
  onClose: () => void
  saveState: SaveState
  /** Null while the server settings are still loading — the switch waits rather than guessing. */
  notifications: boolean | null
  onNotifications: (on: boolean) => void
  perm: NotifPerm
}) {
  const { connection } = useSnapshot(store)
  const { queueOrder, snoozePreset } = useSnapshot(prefs)
  const conn = CONNECTION_WORD[connection]
  const supervisor = useSupervisorStatus().data
  const version = supervisor?.version
  return (
    <div
      data-mobile-settings-page
      className={`fixed inset-0 z-50 flex flex-col bg-bg pt-[env(safe-area-inset-top)] transition-transform duration-200 ease-out motion-reduce:transition-none ${
        shown ? "translate-x-0" : "translate-x-full"
      }`}
    >
      <header className="flex h-[56px] shrink-0 items-center gap-0.5 border-b border-border/70 pl-0.5 pr-[18px]">
        <button
          aria-label="Back"
          onClick={onClose}
          className="flex size-[44px] shrink-0 items-center justify-center rounded-full text-fg/85 active:bg-hover-strong"
        >
          <ArrowLeft size={21} strokeWidth={2.1} />
        </button>
        <h1 className="m-0 min-w-0 flex-1 truncate pl-0.5 text-[16.5px] font-semibold tracking-[-0.01em] text-fg">Settings</h1>
        <SaveStatus state={saveState} />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        <div data-mobile-connection className="flex items-center gap-2 px-[18px] pb-1 pt-[14px] text-[14px] leading-[20px] text-fg">
          <span aria-hidden className={`size-2 shrink-0 rounded-full ${conn.dot}`} />
          <span className="min-w-0 truncate">
            {conn.word}
            {connection === "open" ? ` · ${location.host}` : null}
          </span>
        </div>
        <div className="px-[18px] pb-1 pt-2.5">
          <QuotaMeters />
        </div>

        <MobileSection label="Appearance">
          <div className={MOBILE_ROW}>
            <span className="min-w-0 flex-1 truncate">Theme</span>
            <MobileThemeSegments />
          </div>
        </MobileSection>

        <MobileSection label="Queue">
          <MobilePickerRow
            data="queue-order"
            label="Order"
            value={queueOrder}
            options={[
              { value: "fifo", label: "Oldest first" },
              { value: "lifo", label: "Newest first" },
            ]}
            onChange={(v) => (prefs.queueOrder = v)}
          />
          <MobilePickerRow
            data="snooze-length"
            label="Snooze length"
            value={snoozePreset}
            options={SNOOZE_PRESETS.map((p) => ({ value: p.value, label: p.kind === "calendar" ? `Until ${p.label}, ${p.detail}` : p.label }))}
            onChange={(v) => {
              if (isSnoozePreset(v)) prefs.snoozePreset = v
            }}
          />
          <div className={MOBILE_ROW}>
            <span className="min-w-0 flex-1 truncate">Notifications</span>
            <MobileSwitch
              label="Notifications"
              checked={notifications === true}
              disabled={notifications === null}
              onChange={onNotifications}
            />
          </div>
          {notifications ? (
            <div className="border-b border-border/70 px-[18px] py-2.5">
              <PermHint perm={perm} />
            </div>
          ) : null}
        </MobileSection>

        {/* ── THIS DEVICE ──────────────────────────────────────────────────────────────────────────────
            "Sign out this device", which ends only this browser's own remote session
            (SignOutThisDeviceRow.tsx). The SECTION is gated on the same reading as the row, so the
            operator's own loopback tab — which has nothing to sign out, and on which the row renders
            nothing — does not show a label over an empty section. The row draws its own top and bottom
            rules for standing alone; under the section's rule it drops the top one, and takes the
            section rows' tone for the bottom. */}
        {isRemoteSession(supervisor) ? (
          <MobileSection label="This device">
            <SignOutThisDeviceRow className="!border-t-0 !border-b-border/70" />
          </MobileSection>
        ) : null}

        {version ? (
          <div data-mobile-version className="px-[18px] py-[14px] text-[12.5px] text-faint">Frizz {version}</div>
        ) : null}
      </div>
    </div>
  )
}

function AppearanceControl() {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeSnapshot)
  return (
    <Select
      variant="bordered"
      value={theme.preference}
      onValueChange={(value) => setThemePreference(value as ThemePreference)}
      options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
      indicatorPosition="right"
      ariaLabel="Appearance"
    />
  )
}

// The ONE boolean control shape for the whole form: a segmented Off|On pair, Off always on the LEFT
// (switch convention — right = on). Active segments use the primary button treatment.
function OnOffToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const opts: { v: boolean; label: string }[] = [
    { v: false, label: "Off" },
    { v: true, label: "On" },
  ]
  return (
    <div className="inline-flex w-fit rounded-md border border-border bg-bg p-0.5">
      {opts.map((o) => (
        <button
          key={o.label}
          onClick={() => onChange(o.v)}
          aria-pressed={value === o.v}
          className={`rounded px-3 py-1 text-[12px] transition-colors ${
            value === o.v ? "bg-fg text-bg" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// Diff density: client-only (localStorage prefs proxy), applies live — diff blocks across the app
// collapse/expand the instant it flips, with no server round-trip at all. The pair is named for what
// each one FEELS like rather than Off/On, in the Comfortable|Compact vocabulary Gmail and Trello settled
// (a boolean called "compact mode" told you what Off was not). Left to right is increasing density,
// so Compact — the default — holds the right-hand slot, where On sits on the boolean pairs.
function DensityToggle() {
  const { compactDiffs } = useSnapshot(prefs)
  const opts: { v: boolean; label: string }[] = [
    { v: false, label: "Comfortable" },
    { v: true, label: "Compact" },
  ]
  return (
    <div className="inline-flex w-fit rounded-md border border-border bg-bg p-0.5">
      {opts.map((o) => (
        <button
          key={o.label}
          onClick={() => (prefs.compactDiffs = o.v)}
          aria-pressed={compactDiffs === o.v}
          className={`rounded px-3 py-1 text-[12px] transition-colors ${
            compactDiffs === o.v ? "bg-fg text-bg" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// Queue/rested-band direction: client-only (localStorage prefs proxy), applies live to the Needs-you
// queue and the sidebar's rested rows the instant it flips. FIFO by default (longest in the queue first).
// Pressed is where a click goes NOW: a browser that has chosen neither ("auto", lib/prefs.ts) shows the
// External app while it is an editor with a window connected, and the reader otherwise — so the control
// moves as the editor comes and goes. Pressing the OTHER button makes that the choice; pressing the one
// already pressed changes nothing, so a click that looks like a no-op cannot quietly fix automatic in
// place (it did, and the browser then ignored the editor coming and going for good).
function CodeFilesControl({ opener }: { opener: Settings["localFileOpener"] }) {
  const { codeFiles } = useSnapshot(prefs)
  const { editorWindows } = useSnapshot(store)
  const phone = useIsMobile()
  const remote = isRemoteSession(useSupervisorStatus().data)
  const current = codeFilesDestination({ codeFiles, windows: editorWindows, opener, phone, remote })
  const opts: { v: "frizz" | "editor"; label: string }[] = [
    { v: "frizz", label: "In Frizz" },
    { v: "editor", label: "In external app" },
  ]
  return (
    <div className="inline-flex w-fit rounded-md border border-border bg-bg p-0.5">
      {opts.map((o) => (
        <button
          key={o.v}
          onClick={() => {
            if (current !== o.v) prefs.codeFiles = o.v
          }}
          aria-pressed={current === o.v}
          className={`rounded px-3 py-1 text-[12px] transition-colors ${
            current === o.v ? "bg-fg text-bg" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function QueueOrderControl() {
  const { queueOrder } = useSnapshot(prefs)
  const opts: { v: "fifo" | "lifo"; label: string }[] = [
    { v: "fifo", label: "Oldest first" },
    { v: "lifo", label: "Newest first" },
  ]
  return (
    <div className="inline-flex w-fit rounded-md border border-border bg-bg p-0.5">
      {opts.map((o) => (
        <button
          key={o.v}
          onClick={() => (prefs.queueOrder = o.v)}
          aria-pressed={queueOrder === o.v}
          className={`rounded px-3 py-1 text-[12px] transition-colors ${
            queueOrder === o.v ? "bg-fg text-bg" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// A row's value where an editor's sidebar fixes it (the theme, where code files open): the reading in the
// controls' own 12px, muted as a value no click changes.
function EditorFixed({ name, children }: { name: string; children: React.ReactNode }) {
  return <span data-settings-editor={name} className="py-1 text-[12px] text-muted">{children}</span>
}

// Where a row works differently from an editor's sidebar: the field's hint type (PermHint, below).
function EditorHint({ children }: { children: React.ReactNode }) {
  return <span data-settings-editor-hint className="text-[11px] text-muted-70">{children}</span>
}

// Which of the External app's editors has a window connected right now (the editor bridge,
// packages/vscode): a file sent to one opens in the window that has its folder, at the line the link
// names. The notification field's hint type (PermHint), at the field's 6px from its control; absent
// when nothing is connected, so the field reads exactly as it always did for everyone without the
// extension.
function EditorConnectedHint() {
  const { editorWindows } = useSnapshot(store)
  const connected = connectedOpeners(editorWindows)
  // The select's own order (Cursor, then VS Code), whichever window connected first.
  const names = (["cursor", "vscode"] as const).filter((kind) => connected.has(kind)).map((kind) => EDITOR_OPENER_LABEL[kind])
  if (names.length === 0) return null
  // Which build of the extension each window runs, on hover: "is this window running the fix?" is
  // answered here as well as in the editor's own status bar.
  const builds = [...new Set(editorWindows.flatMap((window) => (window.extensionVersion ? [`${window.app}: Frizz extension ${window.extensionVersion}`] : [])))]
  return <span data-editor-connected title={builds.length ? builds.join("\n") : undefined} className="text-[11px] text-muted-70">{names.join(" and ")} {names.length > 1 ? "are" : "is"} connected.</span>
}

// Quiet, small permission-state line under the notifications toggle. Everything is muted (the old
// loud-red denied line read as an error); the denied state additionally offers a recovery assist,
// since a page can't re-prompt once denied.
function PermHint({ perm }: { perm: NotifPerm }) {
  if (perm === "denied") return <NotifDeniedHelp />
  const text: Record<Exclude<NotifPerm, "denied">, string> = {
    granted: "Browser permission granted — notifications fire when the window is hidden.",
    default: "Browser permission not yet granted — notifications won't fire until you allow them.",
    unsupported: "This browser does not support desktop notifications.",
  }
  return <span className="text-[11px] text-muted-70">{text[perm]}</span>
}

type Browser = "chrome" | "edge" | "safari" | "firefox" | "other"
function detectBrowser(): Browser {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : ""
  if (/Firefox\//.test(ua)) return "firefox"
  if (/Edg\//.test(ua)) return "edge"
  if (/OPR\/|Brave\//.test(ua)) return "other"
  if (/Chrome\//.test(ua)) return "chrome"
  if (/Safari\//.test(ua)) return "safari"
  return "other"
}

// Once a site's notification permission is DENIED, the page can no longer meaningfully re-invoke
// requestPermission, and chrome://about: URLs can't be opened from a web page — so no real deep link
// exists. Best UX: browser-specific one-line instructions, plus (Chromium) the exact site-settings
// address as selectable + copyable mono text. Muted + small; only shown in the denied state.
function NotifDeniedHelp() {
  const browser = useMemo(detectBrowser, [])
  const origin = typeof location !== "undefined" ? location.origin : ""
  const chromiumUrl = `${browser === "edge" ? "edge" : "chrome"}://settings/content/siteDetails?site=${encodeURIComponent(origin)}`

  return (
    <div className="flex flex-col gap-1 text-[11px] text-muted-70">
      <span>Notifications are blocked for this site. Re-enable them in your browser, then reload.</span>
      {browser === "chrome" || browser === "edge" ? (
        <CopyableAddress url={chromiumUrl} hint="Paste this into a new tab, set Notifications → Allow:" />
      ) : browser === "safari" ? (
        <span>Safari → Settings → Websites → Notifications → allow {hostOf(origin)}, then reload.</span>
      ) : browser === "firefox" ? (
        <span>Firefox → Settings → Privacy &amp; Security → Permissions → Notifications → Settings → allow this site.</span>
      ) : (
        <span>Open this site's notification permission in your browser's settings and set it to Allow.</span>
      )}
    </div>
  )
}

function hostOf(origin: string) {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

function CopyableAddress({ url, hint }: { url: string; hint: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await copyTextToClipboard(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — the address is still selectable inline */
    }
  }
  return (
    <span className="flex w-full flex-col gap-1">
      <span>{hint}</span>
      <span className="flex min-w-0 items-center gap-1.5">
        <code className="min-w-0 flex-1 font-mono-keep select-all rounded border border-border bg-bg px-1.5 py-0.5 text-[10.5px] text-fg/90 break-all">
          {url}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy address"
          className="shrink-0 rounded border border-border p-1 text-muted hover:bg-panel-2 hover:text-fg transition-colors"
        >
          {copied ? <Check size={11} className="text-live" /> : <Copy size={11} />}
        </button>
      </span>
    </span>
  )
}
