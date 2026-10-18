import { expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { createTerminalInput } from "../../src/sr/input"

function pipeStdin() {
  const stream = new PassThrough()
  return Object.assign(stream, { isTTY: false }) as unknown as NodeJS.ReadStream
}

function ttyStdin() {
  const stream = new PassThrough()
  return Object.assign(stream, {
    isTTY: true,
    setRawMode(this: unknown) {
      return this
    },
  }) as unknown as NodeJS.ReadStream
}

function output() {
  const chunks: string[] = []
  return { chunks, write: (chunk: string) => void chunks.push(chunk) }
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

// AC-052: piped stdin is read line by line until EOF.
test("AC-052 a pipe delivers lines and then the end signal; nothing is written back", async () => {
  const stdin = pipeStdin()
  const out = output()
  const input = createTerminalInput({ stdin, stdout: out, marker: "> " })
  const lines: string[] = []
  let ended = 0
  input.onLine((line) => void lines.push(line))
  input.onEnd(() => void ended++)
  input.prompt(true)
  stdin.write("first\nsecond\n")
  stdin.end()
  await tick()
  expect(lines).toEqual(["first", "second"])
  expect(ended).toBe(1)
  expect(out.chunks).toEqual([])
  expect(input.typing()).toBe(false)
  input.close()
})

// AC-030: on a terminal the marker is the line editor's prompt and typed text is tracked.
test("AC-030 a terminal shows the marker only while prompting and reports typing", async () => {
  const stdin = ttyStdin()
  const out = output()
  const input = createTerminalInput({ stdin, stdout: out, marker: "> " })
  const lines: string[] = []
  input.onLine((line) => void lines.push(line))
  expect(out.chunks.join("")).not.toContain("> ")
  input.prompt(true)
  expect(out.chunks.join("")).toContain("> ")
  stdin.write("hel")
  await tick()
  expect(input.typing()).toBe(true)
  stdin.write("lo\r")
  await tick()
  expect(lines).toEqual(["hello"])
  expect(input.typing()).toBe(false)
  input.close()
})

// AC-033 / AC-034: special keys are reported, not inserted.
test("AC-033 Escape, Ctrl+C and Ctrl+D are reported as keys", async () => {
  const stdin = ttyStdin()
  const input = createTerminalInput({ stdin, stdout: output(), marker: "> " })
  const keys: string[] = []
  input.onKey((key) => void keys.push(key))
  stdin.write("\x1b")
  // A lone Escape is reported after readline's escape-code timeout.
  await new Promise((resolve) => setTimeout(resolve, 600))
  stdin.write("\x03")
  await tick()
  stdin.write("\x04")
  await tick()
  expect(keys).toEqual(["escape", "ctrl-c", "ctrl-d"])
  input.close()
})

// AC-040: a single key on an empty line can be consumed by a listener; otherwise it is typed normally.
test("AC-040 single keys are offered to listeners only on an empty line", async () => {
  const stdin = ttyStdin()
  const input = createTerminalInput({ stdin, stdout: output(), marker: "> " })
  const offered: string[] = []
  const lines: string[] = []
  input.onSingleKey((char) => {
    offered.push(char)
    return char === "y"
  })
  input.onLine((line) => void lines.push(line))
  stdin.write("y")
  await tick()
  expect(offered).toEqual(["y"])
  expect(input.typing()).toBe(false)
  stdin.write("n")
  await tick()
  stdin.write("o\r")
  await tick()
  expect(offered).toEqual(["y", "n"])
  expect(lines).toEqual(["no"])
  input.close()
})

test("AC-030 beforeWrite and afterWrite bracket the prompt without touching a pipe", () => {
  const stdin = pipeStdin()
  const out = output()
  const input = createTerminalInput({ stdin, stdout: out, marker: "> " })
  input.prompt(true)
  input.beforeWrite()
  input.afterWrite()
  expect(out.chunks).toEqual([])
  input.close()
})

test("AC-052 a pipe that already ended still reports the end of input", async () => {
  const stdin = pipeStdin()
  stdin.end()
  await tick()
  const input = createTerminalInput({ stdin, stdout: output(), marker: "> " })
  let ended = 0
  input.onEnd(() => void ended++)
  await tick()
  expect(ended).toBe(1)
  input.close()
})

test("AC-030 a marker line is ended before the next transcript write even after the prompt was hidden", () => {
  const stdin = ttyStdin()
  const out = output()
  const input = createTerminalInput({ stdin, stdout: out, marker: "> " })
  input.prompt(true)
  input.prompt(false)
  out.chunks.length = 0
  input.beforeWrite()
  expect(out.chunks).toEqual(["\n"])
  input.beforeWrite()
  expect(out.chunks).toEqual(["\n"])
  input.afterWrite()
  expect(out.chunks).toEqual(["\n"])
  input.close()
})
