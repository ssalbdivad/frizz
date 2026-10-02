// Dev entry: a durable source watcher supervising a disposable API + Vite control-plane child.
// Run with `nub packages/server/src/dev.ts` from ui/. Worker daemons remain independent.
import { DEFAULT_PORT } from "@frizz/shared"
import { logEnvironment, openRunLogger } from "./logging.ts"
import { projectFromLaunchTarget, projectLaunchTarget, resolveProject } from "./project.ts"
import {
  acquireProjectLaunchOwner,
  adoptProjectLaunchOwner,
  projectLaunchEnvironment,
  projectLaunchOwnerTokenFromEnvironment,
  projectLaunchTargetFromEnvironment,
  verifyProjectLaunchDelegate,
} from "./project-launch.ts"

if (process.env.FRIZZ_DEV_CHILD === "1") {
  const childTarget = projectLaunchTargetFromEnvironment(process.env)
  const childToken = projectLaunchOwnerTokenFromEnvironment(process.env)
  if (!childTarget || !childToken) throw new Error("dev child is missing pinned project launch ownership")
  verifyProjectLaunchDelegate(childTarget, childToken)
  const { runDevControlPlaneChild } = await import("./dev-supervisor.ts")
  await runDevControlPlaneChild()
} else {
  const inheritedTarget = projectLaunchTargetFromEnvironment(process.env)
  const inheritedToken = projectLaunchOwnerTokenFromEnvironment(process.env)
  const project = inheritedTarget && inheritedToken ? projectFromLaunchTarget(inheritedTarget) : resolveProject()
  // The run log, opened as soon as the project (and so its state dir) is known. This entry used to
  // install no logger at all, so every supervisor and control-plane record went nowhere — the child
  // adopts the file through FRIZZ_LOG_FILE in launchEnv, the same mechanism the launchers use
  // (logging.ts `openRunLogger`).
  const debug = process.env.FRIZZ_DEBUG === "1"
  const logger = openRunLogger(project.stateDir, { debug })
  const target = projectLaunchTarget(project)
  let launchOwner: ReturnType<typeof acquireProjectLaunchOwner>
  try {
    launchOwner = inheritedToken
      ? adoptProjectLaunchOwner(target, inheritedToken, "supervisor")
      : acquireProjectLaunchOwner(target, "supervisor")
  } catch (error) {
    logger.error("launcher", `could not take the project launch lock: ${error instanceof Error ? error.message : error}`)
    throw error
  }
  const launchEnv = {
    ...projectLaunchEnvironment(process.env, target, launchOwner.token),
    ...logEnvironment(logger, debug ? "debug" : "info"),
  }
  logger.info("launcher", `dev supervisor starting for ${project.dir}`)
  const { createSupervisorShutdownHandler, startDevSupervisor } = await import("./dev-supervisor.ts")

  let supervisor: Awaited<ReturnType<typeof startDevSupervisor>>
  let boot: Awaited<typeof supervisor.firstBoot>
  try {
    supervisor = await startDevSupervisor({
      port: DEFAULT_PORT,
      cwd: project.dir,
      env: launchEnv,
      stateDir: project.stateDir,
      launchTarget: target,
      launchOwnerToken: launchOwner.token,
      childEntry: process.argv[1],
      // `pnpm dev` — source checkout, never the published bin. See RestartSupervisorProxy's `dev`.
      dev: true,
      // This entry paints no readout, so a beat prints as a plain line. Without it a restart asked
      // for from a browser tab cycles the board while the terminal that owns it says nothing.
      onActivity: (event) =>
        console.log(
          event.kind === "ready" && event.ms !== undefined
            ? `[frizz] restarted in ${Math.round(event.ms)}ms`
            : `[frizz] ${event.kind}: ${event.message}`,
        ),
    })
    boot = await supervisor.firstBoot
  } catch (error) {
    logger.error("launcher", `startup failed: ${error instanceof Error ? error.stack ?? error.message : error}`)
    launchOwner.release()
    throw error
  }
  // Say where the board is once it answers. Without this line the last thing in the terminal was
  // Vite's "bundling dependencies…", so a server that had been ready for minutes looked hung. The log
  // path rides along because this terminal shows almost nothing else; the file has the whole feed.
  console.log(`[frizz] ready at http://127.0.0.1:${boot.port}/${logger.file ? ` — log: ${logger.file}` : ""}`)

  const stop = createSupervisorShutdownHandler({
    close: () => supervisor.close(),
    force: () => supervisor.forceStop(),
    release: () => { launchOwner.release() },
    onStop: () => console.log("[frizz] stopping: draining the control plane — press ctrl-c again to force"),
    exit: (code) => process.exit(code),
    error: (line) => console.error(line),
  })
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  void supervisor.stopRequested.then(stop)
}
