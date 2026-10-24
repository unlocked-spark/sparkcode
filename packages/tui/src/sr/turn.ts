import type { TranscriptLine } from "./writer"

export type TimerHandle = ReturnType<typeof setTimeout> | number

export type Timers = {
  set(callback: () => void, ms: number): TimerHandle
  clear(id: TimerHandle): void
}

export type TurnSignalsInput = {
  emit: (line: TranscriptLine) => void
  bell: () => void
  /** Called before `Done.` so open paragraphs reach the transcript first. */
  flush?: () => void
  heartbeatSeconds: number
  /** The heartbeat stays quiet while the user is typing, so it never breaks their line. */
  isTyping?: () => boolean
  /** A question or permission is open: the model waits for the user, so the heartbeat stays quiet. */
  isWaiting?: () => boolean
  timers?: Timers
}

export type TurnSignals = {
  readonly running: boolean
  send(): void
  idle(): void
  activity(): void
  interrupted(): void
  update(input: { heartbeatSeconds: number }): void
  dispose(): void
}

const defaultTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (id) => clearTimeout(id),
}

// Turn boundaries (AC-023), the silence heartbeat (AC-024) and the interrupt
// notice (AC-033). Everything is driven by the footer events the runtime emits.
export function createTurnSignals(input: TurnSignalsInput): TurnSignals {
  const timers = input.timers ?? defaultTimers
  let seconds = input.heartbeatSeconds
  let running = false
  let timer: TimerHandle | undefined

  const clear = () => {
    if (timer === undefined) return
    timers.clear(timer)
    timer = undefined
  }

  const schedule = () => {
    clear()
    if (!running || seconds <= 0) return
    timer = timers.set(tick, seconds * 1000)
  }

  const tick = () => {
    timer = undefined
    if (!running) return
    if (!input.isTyping?.() && !input.isWaiting?.()) input.emit({ label: "system", text: "Still working." })
    schedule()
  }

  return {
    get running() {
      return running
    },
    send() {
      if (running) return
      running = true
      input.emit({ label: "system", text: "Starting work." })
      schedule()
    },
    idle() {
      if (!running) return
      running = false
      clear()
      input.flush?.()
      input.emit({ label: "system", text: "Done." })
      input.bell()
    },
    activity() {
      if (running) schedule()
    },
    interrupted() {
      running = false
      clear()
      input.flush?.()
      input.emit({ label: "system", text: "Interrupted." })
    },
    update(next) {
      seconds = next.heartbeatSeconds
      schedule()
    },
    dispose() {
      running = false
      clear()
    },
  }
}
