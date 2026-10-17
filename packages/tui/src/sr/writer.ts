import { EOL } from "node:os"
import { sanitizeText } from "./sanitize"

export type Label =
  | "you"
  | "assistant"
  | "thinking"
  | "tool"
  | "result"
  | "permission"
  | "question"
  | "system"
  | "error"

export type TranscriptLine = {
  label?: Label
  text: string
}

export type Pacing = {
  lineDelayMs: number
  msPerChar: number
}

export type WriterOptions = {
  write: (chunk: string) => void
  eol?: string
  pacing?: Pacing
  tee?: (chunk: string) => void
  sleep?: (ms: number) => Promise<void>
}

export type Writer = {
  /** Write one logical line per physical line of `text`; the label goes on the first line only. */
  line(line: TranscriptLine): Promise<void>
  /** The bell character as its own write, so it never shares a chunk with text. */
  bell(): Promise<void>
  /** Resolves once every queued write has reached the terminal. */
  drain(): Promise<void>
}

const BELL = "\x07"

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// All output goes through one promise chain: lines from different sources keep
// their order and never interleave inside a logical line (AC-013). Each write
// carries exactly one logical line and one end of line (AC-012), and the only
// non-printable byte ever written is the bell (AC-011).
export function createWriter(options: WriterOptions): Writer {
  const eol = options.eol ?? EOL
  const sleep = options.sleep ?? defaultSleep
  let chain: Promise<void> = Promise.resolve()

  // A closed pipe or a failing tee must not poison the chain: the runtime awaits
  // idle() before every prompt, so a rejected chain would freeze the session.
  let broken = false
  const emit = (chunk: string) => {
    if (!broken) {
      try {
        options.write(chunk)
      } catch {
        broken = true
      }
    }
    try {
      options.tee?.(chunk)
    } catch {
      options.tee = undefined
    }
  }

  const delayFor = (line: string) => {
    const pacing = options.pacing
    if (!pacing) return 0
    return Math.max(0, pacing.lineDelayMs) + Math.max(0, pacing.msPerChar) * line.length
  }

  const enqueue = (task: () => Promise<void>) => {
    const next = chain.then(task).catch(() => {})
    chain = next
    return next
  }

  return {
    line(line) {
      const physical = sanitizeText(line.text)
        .split("\n")
        .filter((item) => item.trim() !== "")
      if (physical.length === 0) return chain
      return enqueue(async () => {
        for (const [index, item] of physical.entries()) {
          const rendered = index === 0 && line.label ? `${line.label}: ${item}` : item
          emit(rendered + eol)
          const delay = delayFor(rendered)
          if (delay > 0) await sleep(delay)
        }
      })
    },
    bell() {
      return enqueue(async () => {
        emit(BELL)
      })
    },
    drain() {
      return chain
    },
  }
}
