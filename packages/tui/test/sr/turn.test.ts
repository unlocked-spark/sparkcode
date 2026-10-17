import { expect, test } from "bun:test"
import { createTurnSignals } from "../../src/sr/turn"
import type { TranscriptLine } from "../../src/sr/writer"

function fakeTimers() {
  let now = 0
  const pending: { at: number; fn: () => void; id: number }[] = []
  let seq = 0
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        const id = ++seq
        pending.push({ at: now + ms, fn, id })
        return id
      },
      clear: (id: number) => {
        const index = pending.findIndex((item) => item.id === id)
        if (index >= 0) pending.splice(index, 1)
      },
    },
    advance(ms: number) {
      now += ms
      for (;;) {
        const next = pending.filter((item) => item.at <= now).sort((a, b) => a.at - b.at)[0]
        if (!next) return
        pending.splice(pending.indexOf(next), 1)
        next.fn()
      }
    },
  }
}

function harness(heartbeatSeconds = 15, typing = () => false) {
  const lines: TranscriptLine[] = []
  const bells: number[] = []
  const flushes: number[] = []
  const clock = fakeTimers()
  const turn = createTurnSignals({
    emit: (line) => void lines.push(line),
    bell: () => void bells.push(1),
    flush: () => void flushes.push(1),
    heartbeatSeconds,
    isTyping: typing,
    timers: clock.timers,
  })
  return { lines, bells, flushes, clock, turn }
}

// AC-023: a turn starts with Starting work. and ends with Done. followed by the bell.
test("AC-023 announces start and end of a turn with the bell after Done", () => {
  const h = harness()
  h.turn.send()
  expect(h.lines).toEqual([{ label: "system", text: "Starting work." }])
  h.turn.idle()
  expect(h.lines).toEqual([
    { label: "system", text: "Starting work." },
    { label: "system", text: "Done." },
  ])
  expect(h.bells).toEqual([1])
  expect(h.flushes).toEqual([1])
})

test("AC-023 idle without a running turn is silent and send is idempotent", () => {
  const h = harness()
  h.turn.idle()
  h.turn.send()
  h.turn.send()
  expect(h.lines).toEqual([{ label: "system", text: "Starting work." }])
})

// AC-024: Still working. after 15 s of silence, repeated, reset by activity, off when disabled.
test("AC-024 heartbeat fires after the configured silence and repeats", () => {
  const h = harness(15)
  h.turn.send()
  h.clock.advance(14_000)
  expect(h.lines).toHaveLength(1)
  h.clock.advance(1_000)
  expect(h.lines[1]).toEqual({ label: "system", text: "Still working." })
  h.clock.advance(15_000)
  expect(h.lines[2]).toEqual({ label: "system", text: "Still working." })
})

test("AC-024 activity resets the silence timer", () => {
  const h = harness(15)
  h.turn.send()
  h.clock.advance(10_000)
  h.turn.activity()
  h.clock.advance(10_000)
  expect(h.lines).toHaveLength(1)
  h.clock.advance(5_000)
  expect(h.lines).toHaveLength(2)
})

test("AC-024 heartbeat stops at idle and never fires when disabled", () => {
  const h = harness(15)
  h.turn.send()
  h.turn.idle()
  h.clock.advance(60_000)
  expect(h.lines.map((line) => line.text)).toEqual(["Starting work.", "Done."])
  const off = harness(0)
  off.turn.send()
  off.clock.advance(120_000)
  expect(off.lines).toHaveLength(1)
})

test("AC-024 heartbeat is skipped while the user is typing", () => {
  let typing = true
  const h = harness(15, () => typing)
  h.turn.send()
  h.clock.advance(15_000)
  expect(h.lines).toHaveLength(1)
  typing = false
  h.clock.advance(15_000)
  expect(h.lines).toHaveLength(2)
})

test("AC-024 update changes the interval for the next tick", () => {
  const h = harness(15)
  h.turn.send()
  h.turn.update({ heartbeatSeconds: 5 })
  h.clock.advance(5_000)
  expect(h.lines).toHaveLength(2)
})

// AC-033: an interrupt is announced and ends the running state.
test("AC-033 interrupted writes Interrupted. and ends the turn without Done", () => {
  const h = harness()
  h.turn.send()
  h.turn.interrupted()
  expect(h.lines.map((line) => line.text)).toEqual(["Starting work.", "Interrupted."])
  expect(h.turn.running).toBe(false)
  h.clock.advance(60_000)
  expect(h.lines).toHaveLength(2)
})
