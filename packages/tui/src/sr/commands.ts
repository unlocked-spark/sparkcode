import type { TranscriptLine } from "./writer"

export type Command = {
  name: string
  args: string
}

const pattern = /^\/([a-z][\w-]*)(?:\s+(.*))?$/i

/** `/name rest of line`, or undefined for ordinary text. */
export function parseCommand(line: string): Command | undefined {
  const match = pattern.exec(line.trim())
  if (!match) return undefined
  return { name: (match[1] ?? "").toLowerCase(), args: (match[2] ?? "").trim() }
}

const help: ReadonlyArray<readonly [usage: string, purpose: string]> = [
  ["/help", "list these commands"],
  ["/status", "say the session, model, agent, token usage and whether a turn is running"],
  ["/last", "repeat the last answer"],
  ["/model [text]", "choose the model, filtered by text"],
  ["/agent", "choose the agent"],
  ["/sessions", "switch to another session of this directory"],
  ["/new", "start a new session"],
  ["/compact", "compact the current session"],
  ["/tools off|brief|full", "how much to say about tools"],
  ["/thinking on|off", "whether to read the model's reasoning"],
  ["/heartbeat <seconds>", "how often to say Still working during silence, 0 to turn it off"],
  ["/undo", "remove the last queued prompt"],
  ["/exit", "leave; Ctrl+D or Ctrl+C twice do the same"],
]

export function helpLines(): TranscriptLine[] {
  return help.map(([usage, purpose]) => ({ label: "system", text: `${usage}: ${purpose}` }))
}
