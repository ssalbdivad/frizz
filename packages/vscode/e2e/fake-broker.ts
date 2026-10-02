// A SIMULATED CLAUDE WORKER for the real-page sidebar run — a stand-in for the session broker daemon
// (packages/server/src/backend/claude-agent-broker.ts) that never starts an agent. The harness writes a
// broker record naming this process and its socket, so the real server ADOPTS it the way it adopts a
// daemon that outlived a restart (claude-broker-host.ts adoptOrForkBroker), and a follow-up the page
// sends reaches it over the real wire: `{"t":"input","message":{id,text}}`, newline-delimited JSON.
//
// It does what the Claude CLI would with that message, and no more: it appends the user record to the
// session's JSONL, then an assistant reply that ends the turn — so the real tailer, board and transcript
// render the message as delivered. Every input it took is also written to `--inputs`, one JSON line each,
// for the harness to assert the exact bytes the page sent.
//
//   node fake-broker.ts --socket=<path> --jsonl=<path> --session=<id> --cwd=<dir> --inputs=<path>
//
// Plain Node with type stripping: no imports beyond node's own, nothing that isn't erasable syntax.

import { appendFileSync, rmSync } from "node:fs"
import { createServer, type Socket } from "node:net"

const flag = (name: string): string => {
  const value = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  if (!value) throw new Error(`fake-broker: --${name} is required`)
  return value
}
const socketPath = flag("socket")
const jsonl = flag("jsonl")
const sessionId = flag("session")
const cwd = flag("cwd")
const inputs = flag("inputs")

const record = (value: unknown) => appendFileSync(jsonl, `${JSON.stringify(value)}\n`)

function take(id: string, text: string): void {
  appendFileSync(inputs, `${JSON.stringify({ at: new Date().toISOString(), id, text })}\n`)
  const at = Date.now()
  record({ type: "user", uuid: id, sessionId, cwd, timestamp: new Date(at).toISOString(), message: { role: "user", content: [{ type: "text", text }] } })
  setTimeout(() => {
    record({
      type: "assistant", sessionId, cwd, timestamp: new Date().toISOString(),
      message: { role: "assistant", id: `m-${id}`, stop_reason: "end_turn", content: [{ type: "text", text: "Read it — those lines sum the array in a loop. (A simulated worker's reply.)" }], usage: { input_tokens: 2, output_tokens: 20 } },
    })
  }, 1_500)
}

const server = createServer((socket: Socket) => {
  socket.write(`${JSON.stringify({ t: "hello", sessionId })}\n`)
  let buffer = ""
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8")
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      let frame: { t?: string; message?: { id?: string; text?: string } }
      try {
        frame = JSON.parse(line) as typeof frame
      } catch {
        continue
      }
      if (frame.t === "input" && typeof frame.message?.id === "string" && typeof frame.message.text === "string") take(frame.message.id, frame.message.text)
    }
  })
  socket.on("error", () => undefined)
})

rmSync(socketPath, { force: true })
server.listen(socketPath, () => console.log(`fake-broker: ${process.pid} listening on ${socketPath}`))
const stop = () => {
  server.close()
  rmSync(socketPath, { force: true })
  process.exit(0)
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
