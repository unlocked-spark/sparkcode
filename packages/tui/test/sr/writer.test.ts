import { expect, test } from "bun:test"
import { createWriter } from "../../src/sr/writer"

function capture() {
  const writes: string[] = []
  return { writes, write: (chunk: string) => void writes.push(chunk) }
}

// AC-012: each write holds exactly one logical line terminated by one EOL.
test("AC-012 writes one logical line per write with the label on the first line only", async () => {
  const out = capture()
  const writer = createWriter({ write: out.write, eol: "\n" })
  await writer.line({ label: "assistant", text: "first paragraph\nsecond paragraph" })
  expect(out.writes).toEqual(["assistant: first paragraph\n", "second paragraph\n"])
  for (const chunk of out.writes) expect(chunk.split("\n").length).toBe(2)
})

test("AC-012 skips empty lines entirely", async () => {
  const out = capture()
  const writer = createWriter({ write: out.write, eol: "\n" })
  await writer.line({ label: "system", text: "" })
  await writer.line({ text: "\n\n" })
  expect(out.writes).toEqual([])
})

test("AC-012 uses the configured end of line", async () => {
  const out = capture()
  const writer = createWriter({ write: out.write, eol: "\r\n" })
  await writer.line({ label: "you", text: "hello" })
  expect(out.writes).toEqual(["you: hello\r\n"])
})

// AC-011: no ESC sequences ever reach the terminal; the bell is its own write.
test("AC-011 strips escape sequences before writing and never emits ESC", async () => {
  const out = capture()
  const writer = createWriter({ write: out.write, eol: "\n" })
  await writer.line({ label: "result", text: "\x1b[1mbold\x1b[0m ┃ edge" })
  expect(out.writes).toEqual(["result: bold | edge\n"])
  expect(out.writes.join("")).not.toContain("\x1b")
})

test("AC-011 bell is a separate write containing only the bell character", async () => {
  const out = capture()
  const writer = createWriter({ write: out.write, eol: "\n" })
  await writer.line({ label: "system", text: "Done." })
  await writer.bell()
  expect(out.writes).toEqual(["system: Done.\n", "\x07"])
})

// AC-013: writes are serialised and ordered even when callers interleave.
test("AC-013 serialises concurrent writes in call order", async () => {
  const out = capture()
  const slept: number[] = []
  const writer = createWriter({
    write: out.write,
    eol: "\n",
    pacing: { lineDelayMs: 5, msPerChar: 0 },
    sleep: async (ms) => void slept.push(ms),
  })
  void writer.line({ label: "tool", text: "one" })
  void writer.line({ text: "two" })
  void writer.line({ label: "system", text: "three" })
  await writer.drain()
  expect(out.writes).toEqual(["tool: one\n", "two\n", "system: three\n"])
  expect(slept).toEqual([5, 5, 5])
})

// AC-016: pacing is off by default and scales with line length when enabled.
test("AC-016 does not sleep when pacing is zero", async () => {
  const out = capture()
  const slept: number[] = []
  const writer = createWriter({ write: out.write, eol: "\n", sleep: async (ms) => void slept.push(ms) })
  await writer.line({ label: "assistant", text: "no delay" })
  expect(slept).toEqual([])
})

test("AC-016 sleeps lineDelayMs plus msPerChar times the line length", async () => {
  const out = capture()
  const slept: number[] = []
  const writer = createWriter({
    write: out.write,
    eol: "\n",
    pacing: { lineDelayMs: 100, msPerChar: 10 },
    sleep: async (ms) => void slept.push(ms),
  })
  await writer.line({ label: "assistant", text: "abcd" })
  expect(slept).toEqual([100 + 10 * "assistant: abcd".length])
})

// AC-051: the transcript tee receives exactly the bytes written to the terminal.
test("AC-051 tee receives the same chunks as the terminal", async () => {
  const out = capture()
  const tee: string[] = []
  const writer = createWriter({ write: out.write, eol: "\n", tee: (chunk) => void tee.push(chunk) })
  await writer.line({ label: "you", text: "hi" })
  await writer.bell()
  expect(tee).toEqual(out.writes)
})

// A broken terminal or tee must not reject the chain, because the runtime awaits idle() before each prompt.
test("AC-013 a throwing write or tee does not poison later lines or drain", async () => {
  const out: string[] = []
  let failures = 0
  const writer = createWriter({
    write: (chunk) => {
      if (chunk.startsWith("system: boom")) {
        failures++
        throw new Error("EPIPE")
      }
      out.push(chunk)
    },
    eol: "\n",
    tee: () => {
      throw new Error("disk full")
    },
  })
  await writer.line({ label: "system", text: "boom" })
  await writer.line({ label: "system", text: "after" })
  await writer.drain()
  expect(failures).toBe(1)
  expect(out).toEqual([])
})
