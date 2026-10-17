import type { SessionMessageAssistantTool } from "@opencode/client/promise"
import { toolInlineInfo, toolOutputText, toolView } from "../mini/tool"
import type { StreamCommit } from "../mini/types"
import { createMarkdownConverter, type MarkdownConverter } from "./markdown"
import { sanitizeText } from "./sanitize"
import type { Label, TranscriptLine } from "./writer"

export type ToolNarration = "off" | "brief" | "full"

export type NarrationOptions = {
  tools: ToolNarration
  thinking: boolean
  directory?: string
  /** Longest paragraph written in one line before splitting at a sentence boundary. */
  paragraphLimit?: number
  /** Most output lines written after a result in `full` mode. */
  outputLimit?: number
}

export type Narrator = {
  /** Turn one runtime commit into zero or more transcript lines. */
  commit(commit: StreamCommit): TranscriptLine[]
  /** Write out every open paragraph and close open code fences, for the end of a turn. */
  flush(): TranscriptLine[]
  /** Forget all state, for a replay. */
  reset(): void
  update(options: Partial<NarrationOptions>): void
}

type TextKind = "assistant" | "reasoning"

type Buffer = {
  kind: TextKind
  messageID: string | undefined
  text: string
  markdown: MarkdownConverter
  started: boolean
}

const DEFAULT_PARAGRAPH_LIMIT = 2000
const DEFAULT_OUTPUT_LIMIT = 200
const THINKING_PREFIX = "Thinking: "

function partKey(commit: StreamCommit) {
  return `${commit.messageID ?? ""}\u0000${(commit.partID ?? "").replace(/:snapshot:\d+$/, "")}`
}

function outputLines(text: string) {
  return sanitizeText(text)
    .split("\n")
    .filter((line) => line.trim() !== "")
}

function countLabel(count: number) {
  if (count === 0) return "done"
  return count === 1 ? "1 line" : `${count} lines`
}

function toolOutput(part: SessionMessageAssistantTool | undefined, fallback: string) {
  if (!part) return fallback
  if (part.state.status === "completed" || part.state.status === "error")
    return toolOutputText(part.name, part.state.content)
  return fallback
}

function sentenceSplit(text: string, limit: number): [string, string] | undefined {
  if (text.length <= limit) return undefined
  const window = text.slice(0, limit)
  let cut = -1
  const boundary = /[.!?]["')\]]?\s/g
  for (let match = boundary.exec(window); match; match = boundary.exec(window)) cut = match.index + match[0].length
  if (cut <= 0) cut = window.lastIndexOf(" ") > 0 ? window.lastIndexOf(" ") + 1 : limit
  return [text.slice(0, cut).trimEnd(), text.slice(cut).trimStart()]
}

// Turns runtime commits into transcript lines (AC-020 to AC-027). Assistant and
// reasoning deltas are buffered per part and released one paragraph at a time;
// everything else becomes a labelled line. A paragraph that is still open when a
// tool line must go out is released first, but its markdown state (an open code
// fence, a table header) survives until the end of the turn.
export function createNarrator(initial: NarrationOptions): Narrator {
  let options: NarrationOptions = { ...initial }
  const buffers = new Map<string, Buffer>()
  const labelled = new Set<string>()
  const startedTools = new Set<string>()
  const finishedTools = new Set<string>()
  const shellOutput = new Map<string, string>()

  const labelFor = (buffer: Buffer): Label | undefined => {
    const key = `${buffer.kind}\u0000${buffer.messageID ?? ""}`
    if (labelled.has(key)) return undefined
    labelled.add(key)
    return buffer.kind === "reasoning" ? "thinking" : "assistant"
  }

  const paragraph = (buffer: Buffer, text: string): TranscriptLine[] =>
    buffer.markdown.push(text).map((line) => ({ label: labelFor(buffer), text: line }))

  const release = (buffer: Buffer): TranscriptLine[] => {
    const out: TranscriptLine[] = []
    for (;;) {
      const index = buffer.text.indexOf("\n")
      if (index < 0) break
      const line = buffer.text.slice(0, index)
      buffer.text = buffer.text.slice(index + 1)
      out.push(...paragraph(buffer, line))
    }
    const limit = options.paragraphLimit ?? DEFAULT_PARAGRAPH_LIMIT
    for (let split = sentenceSplit(buffer.text, limit); split; split = sentenceSplit(buffer.text, limit)) {
      buffer.text = split[1]
      out.push(...paragraph(buffer, split[0]))
    }
    return out
  }

  // Release open paragraphs so another line can follow them; keep markdown state.
  const softFlush = (): TranscriptLine[] => {
    const out: TranscriptLine[] = []
    for (const buffer of buffers.values()) {
      const rest = buffer.text.trimEnd()
      buffer.text = ""
      if (rest.trim() !== "") out.push(...paragraph(buffer, rest))
    }
    return out
  }

  const flush = (): TranscriptLine[] => {
    const out = softFlush()
    for (const [key, buffer] of [...buffers.entries()]) {
      out.push(...buffer.markdown.end().map((line) => ({ label: labelFor(buffer), text: line })))
      buffers.delete(key)
    }
    return out
  }

  const text = (commit: StreamCommit, kind: TextKind): TranscriptLine[] => {
    if (kind === "reasoning" && !options.thinking) return []
    const key = `${kind}\u0000${partKey(commit)}`
    const buffer = buffers.get(key) ?? {
      kind,
      messageID: commit.messageID,
      text: "",
      markdown: createMarkdownConverter(),
      started: false,
    }
    buffers.set(key, buffer)
    let delta = commit.text
    if (kind === "reasoning" && !buffer.started && delta.startsWith(THINKING_PREFIX))
      delta = delta.slice(THINKING_PREFIX.length)
    buffer.started = true
    buffer.text += delta
    return release(buffer)
  }

  const toolTitle = (commit: StreamCommit) => {
    if (commit.shell) return `Shell: ${commit.shell.command}`
    if (commit.part) return toolInlineInfo(commit.part, options.directory).title
    return commit.tool ?? "tool"
  }

  const tool = (commit: StreamCommit): TranscriptLine[] => {
    if (options.tools === "off") return []
    const key = partKey(commit)
    if (commit.shell && commit.phase === "progress" && commit.toolState === "running")
      shellOutput.set(key, (shellOutput.get(key) ?? "") + commit.text)
    const out: TranscriptLine[] = []
    if (!startedTools.has(key) && !finishedTools.has(key)) {
      startedTools.add(key)
      out.push({ label: "tool", text: toolTitle(commit) })
    }
    const finished = commit.toolState === "completed" || commit.toolState === "error"
    if (!finished || finishedTools.has(key)) return out
    finishedTools.add(key)
    startedTools.delete(key)
    if (commit.toolState === "error") {
      shellOutput.delete(key)
      out.push({ label: "result", text: `error: ${commit.toolError ?? commit.text}` })
      return out
    }
    // Tools whose result upstream shows as a snapshot (a written file, a diff, a task
    // list, a question) are reported as done; everything else returns text worth counting.
    const view = commit.part ? toolView(commit.part.name) : undefined
    const counts = commit.shell || !view || view.snap === undefined
    const raw = commit.shell ? (shellOutput.get(key) ?? "") + commit.text : toolOutput(commit.part, commit.text)
    shellOutput.delete(key)
    const lines = counts ? outputLines(raw) : []
    out.push({ label: "result", text: countLabel(lines.length) })
    if (options.tools === "full" && lines.length > 0) {
      const limit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT
      for (const line of lines.slice(0, limit)) out.push({ text: line })
      if (lines.length > limit) out.push({ text: `... ${lines.length - limit} more lines` })
    }
    return out
  }

  const other = (commit: StreamCommit): TranscriptLine[] => {
    if (commit.image) return [{ label: "system", text: `Image: ${commit.text || commit.image}` }]
    switch (commit.kind) {
      case "tool":
        return tool(commit)
      case "user":
        return [{ label: "you", text: commit.text }]
      case "error":
        return [{ label: "error", text: commit.text }]
      default:
        return [{ label: "system", text: commit.text }]
    }
  }

  return {
    commit(commit) {
      if (commit.kind === "assistant" || commit.kind === "reasoning") return text(commit, commit.kind)
      const lines = other(commit)
      if (lines.length === 0) return []
      const released = softFlush()
      // Anything spoken between two assistant paragraphs makes the next one need its label again.
      labelled.clear()
      return [...released, ...lines]
    },
    flush,
    reset() {
      buffers.clear()
      labelled.clear()
      startedTools.clear()
      finishedTools.clear()
      shellOutput.clear()
    },
    update(next) {
      options = { ...options, ...next }
    },
  }
}
