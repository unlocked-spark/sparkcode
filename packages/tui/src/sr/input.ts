import readline from "node:readline"
import { Writable } from "node:stream"

export type Key = "escape" | "ctrl-c" | "ctrl-d"

/** Where typed prompts come from; the lifecycle only ever talks to this interface. */
export type InputSource = {
  onLine(listener: (text: string) => void): () => void
  typing?: () => boolean
  close?: () => void
}

export type TerminalInput = InputSource & {
  onKey(listener: (key: Key) => void): () => void
  /** A character typed on an empty line; a listener returning true consumes it. */
  onSingleKey(listener: (char: string) => boolean): () => void
  /** The input is exhausted (pipe closed). */
  onEnd(listener: () => void): () => void
  /** Show or hide the prompt marker. */
  prompt(show: boolean): void
  typing(): boolean
  /** Called around every transcript write so a visible prompt line is ended first and restored after. */
  beforeWrite(): void
  afterWrite(): void
  close(): void
}

export type TerminalInputOptions = {
  stdin: NodeJS.ReadStream
  stdout: { write(chunk: string): void }
  marker: string
  /** Defaults to `stdin.isTTY`. */
  terminal?: boolean
}

type Listeners<T> = Set<(value: T) => void>

function subscribe<T>(set: Set<T>, listener: T) {
  set.add(listener)
  return () => void set.delete(listener)
}

// The line editor. On a terminal it is Node's readline in raw mode: typing,
// backspace and history stay the terminal's business, while Escape, Ctrl+C and
// Ctrl+D are reported as keys instead of being inserted. On a pipe it reads
// lines until end of input and writes nothing back (AC-052).
export function createTerminalInput(options: TerminalInputOptions): TerminalInput {
  const terminal = options.terminal ?? Boolean(options.stdin.isTTY)
  const lineListeners: Listeners<string> = new Set()
  const keyListeners: Listeners<Key> = new Set()
  const singleKeyListeners = new Set<(char: string) => boolean>()
  const endListeners = new Set<() => void>()
  let shown = false
  let closed = false

  const output = new Writable({
    write(chunk, _encoding, callback) {
      options.stdout.write(String(chunk))
      callback()
    },
  })

  const rl = readline.createInterface({
    input: options.stdin,
    output: terminal ? output : undefined,
    terminal,
    prompt: terminal ? options.marker : "",
    crlfDelay: Number.POSITIVE_INFINITY,
    historySize: terminal ? 50 : 0,
  })

  rl.on("line", (line) => {
    shown = false
    for (const listener of [...lineListeners]) listener(line)
  })
  const ended = () => {
    if (closed) return
    closed = true
    if (terminal) for (const listener of [...keyListeners]) listener("ctrl-d")
    else for (const listener of [...endListeners]) listener()
  }
  rl.on("close", ended)
  // A pipe that was drained before we attached never emits close again.
  if (!terminal && options.stdin.readableEnded) setImmediate(ended)

  const report = (key: Key) => {
    for (const listener of [...keyListeners]) listener(key)
  }
  const onKeypress = (char: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
    if (closed) return
    if (key?.name === "escape") return report("escape")
    if (!char || key?.ctrl || char.length !== 1 || char < " ") return
    // readline has already inserted the character; offer it only when it is alone on the line.
    if (rl.line !== char) return
    if (![...singleKeyListeners].some((listener) => listener(char))) return
    rl.write(null, { ctrl: true, name: "u" })
  }
  const onSigint = () => report("ctrl-c")

  if (terminal) {
    rl.on("SIGINT", () => {
      // Upstream clears the draft too; the second press must not exit with unsent text.
      if (rl.line.length > 0) rl.write(null, { ctrl: true, name: "u" })
      report("ctrl-c")
    })
    options.stdin.on("keypress", onKeypress)
  } else {
    process.on("SIGINT", onSigint)
  }

  return {
    onLine: (listener) => subscribe(lineListeners, listener),
    onKey: (listener) => subscribe(keyListeners, listener),
    onSingleKey: (listener) => subscribe(singleKeyListeners, listener),
    onEnd: (listener) => subscribe(endListeners, listener),
    prompt(show) {
      if (closed) return
      shown = show
      if (!terminal) return
      rl.setPrompt(show ? options.marker : "")
      if (show) rl.prompt(true)
    },
    typing: () => !closed && terminal && rl.line.length > 0,
    beforeWrite() {
      if (!terminal || closed || !shown) return
      options.stdout.write("\n")
    },
    afterWrite() {
      if (!terminal || closed || !shown) return
      rl.prompt(true)
    },
    close() {
      if (closed) return
      closed = true
      options.stdin.off("keypress", onKeypress)
      process.off("SIGINT", onSigint)
      rl.close()
    },
  }
}
