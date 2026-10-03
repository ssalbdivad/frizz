// WHICH socket file a detached daemon bound, by identity rather than by name — shared by all three
// daemon families (the Claude session broker, the codex app-server daemon, the ACP agent daemon).
//
// The name is shared. Every daemon ever forked for one key (a Claude session, a codex project, an ACP
// session) binds the SAME derived path, and a second one unlinks the first's file before binding its
// own (each daemon's sweep before `listen`). So "the path exists" says nothing about whether it still
// leads to THIS daemon — only the inode does. And the record file is no substitute: it is a proxy that
// can be absent (every host unlinks it before forking, on a failed attach, and on stop) or name us
// while a successor is between its bind and its record write.
//
// Two decisions hang on the answer, and each cost a lost message once it was answered by name:
//   - TEARDOWN: a daemon may remove the socket file only while the path still leads to it. Closing a
//     unix-socket server unlinks its PATH too — libuv does it on close (uv__pipe_close), by name — so
//     a daemon that does not own the path must not `server.close()` either. That close is what deleted
//     a surviving Claude daemon's socket on 2026-09-30 (0dc073b7; scripts/verify-broker-resume-race.mjs).
//     `process.exit` without a close does not touch the filesystem (measured: the survivor's path still
//     exists and accepts a connection), which is why the codex and ACP daemons exit without one.
//   - SELF-COLLECTION: an unattached daemon whose path no longer leads to it can never be reached
//     again, record or no record, so it collects itself (`self-collected-socket-lost`).
//
// A residual worth knowing: a filesystem that hands a freed inode number straight back to the next
// file (ext4, for one, may) could make a successor's file look like ours. That degrades to the
// pre-identity behaviour for that one teardown; it never makes a live daemon think it lost its path,
// because the file it bound keeps its (dev, ino) for as long as it exists.
import { statSync } from "node:fs"

/**
 * Call once `listen()` has succeeded on `socketPath`. Returns a predicate answering whether the path
 * still leads to the socket this process bound: false once the file is deleted or replaced.
 *
 * Always true on Windows, where a named pipe has no inode to compare and nothing unlinks it by name;
 * and always true if the bound file could not be stat'ed at all — unknown is answered with the
 * pre-identity behaviour, which assumed ours, rather than with a self-collection.
 */
export function socketPathOwnership(socketPath: string): () => boolean {
  if (process.platform === "win32") return () => true
  let bound: { dev: number; ino: number }
  try {
    const stat = statSync(socketPath)
    bound = { dev: stat.dev, ino: stat.ino }
  } catch {
    return () => true
  }
  return () => {
    try {
      const now = statSync(socketPath)
      return now.dev === bound.dev && now.ino === bound.ino
    } catch {
      return false // deleted: nothing leads here any more
    }
  }
}
