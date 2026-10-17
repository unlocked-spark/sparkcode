import type { Lifecycle, LifecycleInput } from "../mini/runtime.lifecycle"
import type { FooterApi, FooterEvent, FooterView, RunPrompt, StreamCommit } from "../mini/types"
import { createNarrator } from "./narration"
import type { ScreenReaderSettings } from "./settings"
import { createTurnSignals, type Timers } from "./turn"
import { createWriter, type TranscriptLine } from "./writer"

export type ActivationSource = {
  source: "command" | "flag" | "env" | "detection"
  reader?: "NVDA" | "JAWS"
}

/** Where typed prompts come from. The interactive line editor arrives in a later cycle; tests drive it directly. */
export type InputSource = {
  onLine(listener: (text: string) => void): () => void
  /** Whether the user is in the middle of typing a line, so the heartbeat stays quiet. */
  typing?: () => boolean
  close?: () => void
}

export type ScreenReaderLifecycleOptions = {
  settings: ScreenReaderSettings
  activation: ActivationSource
  /** Defaults to the host's stdout. */
  write?: (chunk: string) => void
  /** Receives every chunk written, for `--transcript` and for tests. */
  tee?: (chunk: string) => void
  eol?: string
  input?: InputSource
  /** One-shot mode: close the footer after the first turn ends. */
  exitWhenIdle?: boolean
  timers?: Timers
  sleep?: (ms: number) => Promise<void>
}

export type ScreenReaderLifecycleFactory = (input: LifecycleInput) => Promise<Lifecycle>

function activationLine(activation: ActivationSource) {
  if (activation.source === "detection" && activation.reader)
    return `Screen reader detected (${activation.reader}). Screen reader mode on via detection.`
  return `Screen reader mode on via ${activation.source}.`
}

function permissionLines(view: Extract<FooterView, { type: "permission" }>): TranscriptLine[] {
  const request = view.request
  const resources = request.resources.join(" ")
  const what = resources ? `${request.action} ${resources}` : request.action
  return [{ label: "permission", text: `${what}. Answer y for once, a for always, n to reject.` }]
}

function formLines(view: Extract<FooterView, { type: "form" }>): TranscriptLine[] {
  const out: TranscriptLine[] = [{ label: "question", text: view.request.title }]
  for (const field of view.request.fields) {
    if ("title" in field && field.title) out.push({ text: field.title })
    if ("options" in field && field.options)
      field.options.forEach((option, index) => out.push({ text: `${index + 1}. ${option.label}` }))
  }
  out.push({ text: "Type the number, or your own answer." })
  return out
}

// The screen reader frontend's Lifecycle: a FooterApi that turns runtime commits
// and events into appended text lines, with no renderer behind it (AC-010).
export function createScreenReaderLifecycle(options: ScreenReaderLifecycleOptions): ScreenReaderLifecycleFactory {
  return async (input) => {
    const settings = options.settings
    const writer = createWriter({
      write: options.write ?? ((chunk) => input.host.stdout.write(chunk)),
      eol: options.eol,
      tee: options.tee,
      sleep: options.sleep,
      pacing:
        settings.delivery.lineDelayMs > 0 || settings.delivery.msPerChar > 0
          ? { lineDelayMs: settings.delivery.lineDelayMs, msPerChar: settings.delivery.msPerChar }
          : undefined,
    })
    const narrator = createNarrator({
      tools: settings.tools,
      thinking: settings.thinking === "on",
      directory: input.getDirectory(),
    })
    const promptListeners = new Set<(prompt: RunPrompt) => void>()
    const closeListeners = new Set<() => void>()
    const sentTexts: string[] = []
    let closed = false
    let lastModel: string | undefined
    let lastAgent: string | undefined = input.agent
    let lastSession: string | undefined
    let exited = false

    const say = (line: TranscriptLine) => {
      void writer.line(line)
      turn.activity()
    }
    const sayAll = (lines: TranscriptLine[]) => {
      for (const line of lines) say(line)
    }
    const turn = createTurnSignals({
      emit: (line) => void writer.line(line),
      bell: () => void writer.bell(),
      flush: () => sayAll(narrator.flush()),
      heartbeatSeconds: settings.heartbeat.seconds,
      isTyping: options.input?.typing,
      timers: options.timers,
    })

    const close = () => {
      if (closed) return
      closed = true
      turn.dispose()
      options.input?.close?.()
      for (const listener of [...closeListeners]) listener()
    }

    const append = (commit: StreamCommit) => {
      if (closed) return
      if (commit.kind === "user") {
        const index = sentTexts.indexOf(commit.text)
        if (index >= 0) {
          sentTexts.splice(index, 1)
          return
        }
      }
      sayAll(narrator.commit(commit))
    }

    const event = (next: FooterEvent) => {
      if (closed) return
      switch (next.type) {
        case "turn.send":
          turn.send()
          return
        case "turn.idle":
          turn.idle()
          if (options.exitWhenIdle) close()
          return
        case "model":
          if (next.model !== lastModel) {
            lastModel = next.model
            say({ label: "system", text: `Model: ${next.model}.` })
          }
          return
        case "agent":
          if (next.agent && next.agent !== lastAgent) {
            lastAgent = next.agent
            say({ label: "system", text: `Agent: ${next.agent}.` })
          }
          return
        case "stream.view":
          if (next.view.type === "permission") sayAll(permissionLines(next.view))
          if (next.view.type === "form") sayAll(formLines(next.view))
          return
        default:
          return
      }
    }

    const footer: FooterApi = {
      get isClosed() {
        return closed
      },
      onPrompt(fn) {
        promptListeners.add(fn)
        return () => void promptListeners.delete(fn)
      },
      onClose(fn) {
        closeListeners.add(fn)
        return () => void closeListeners.delete(fn)
      },
      event,
      append,
      idle: () => writer.drain(),
      close,
      destroy: close,
    }

    options.input?.onLine((text) => {
      const trimmed = text.trim()
      if (!trimmed || closed) return
      sentTexts.push(trimmed)
      say({ label: "you", text: trimmed })
      const prompt: RunPrompt = { text: trimmed, parts: [] }
      for (const listener of [...promptListeners]) listener(prompt)
    })

    // The runtime builds the lifecycle before the session is resolved, so the
    // title usually arrives later through setTitle; announce it once, whenever it comes.
    const announceSession = (title: string | undefined) => {
      const name = title?.trim()
      if (!name || name === lastSession) return
      lastSession = name
      say({ label: "system", text: `Session ${name}.` })
    }

    say({ label: "system", text: activationLine(options.activation) })
    announceSession(input.sessionTitle || input.sessionID)

    return {
      footer,
      onResize: () => () => {},
      refreshTheme: () => {},
      setTitle: announceSession,
      async resetForReplay() {
        narrator.reset()
        await writer.drain()
      },
      async close(exit) {
        if (exited) return writer.drain()
        exited = true
        sayAll(narrator.flush())
        turn.dispose()
        const title = (exit.sessionTitle || lastSession || exit.sessionID || input.sessionID || "").trim()
        void writer.line({ label: "system", text: title ? `Session ${title} saved. Goodbye.` : "Goodbye." })
        close()
        await writer.drain()
      },
    }
  }
}
