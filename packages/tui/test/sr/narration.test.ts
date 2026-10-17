import { expect, test } from "bun:test"
import { createNarrator } from "../../src/sr/narration"
import {
  completedTool,
  errorCommit,
  failedTool,
  reasoningDelta,
  runningTool,
  shellCommit,
  systemCommit,
  textDelta,
  toolDone,
  toolFailed,
  toolStart,
  userCommit,
} from "./fixture"

function narrator(overrides: Partial<Parameters<typeof createNarrator>[0]> = {}) {
  return createNarrator({ tools: "brief", thinking: false, ...overrides })
}

// AC-021: deltas are buffered and emitted per paragraph.
test("AC-021 buffers deltas until a newline and emits one paragraph per line", () => {
  const n = narrator()
  expect(n.commit(textDelta("Hello, "))).toEqual([])
  expect(n.commit(textDelta("world.\nSecond "))).toEqual([{ label: "assistant", text: "Hello, world." }])
  expect(n.commit(textDelta("paragraph.\n"))).toEqual([{ text: "Second paragraph." }])
})

test("AC-021 flush emits the open paragraph without a trailing newline", () => {
  const n = narrator()
  n.commit(textDelta("Tail without newline"))
  expect(n.flush()).toEqual([{ label: "assistant", text: "Tail without newline" }])
  expect(n.flush()).toEqual([])
})

// AC-020: the assistant label appears on the first paragraph of a message only.
test("AC-020 labels only the first paragraph of each message", () => {
  const n = narrator()
  n.commit(textDelta("one\n", "m1"))
  expect(n.commit(textDelta("two\n", "m1"))).toEqual([{ text: "two" }])
  expect(n.commit(textDelta("three\n", "m2"))).toEqual([{ label: "assistant", text: "three" }])
})

test("AC-021 splits a very long paragraph at a sentence boundary before the limit", () => {
  const n = narrator({ paragraphLimit: 60 })
  const sentence = "This sentence has exactly forty characters. "
  const lines = n.commit(textDelta(sentence + sentence))
  expect(lines).toEqual([{ label: "assistant", text: sentence.trim() }])
  expect(n.flush()).toEqual([{ text: sentence.trim() }])
})

test("AC-021 blank lines in assistant text produce no output", () => {
  const n = narrator()
  expect(n.commit(textDelta("\n\n   \n"))).toEqual([])
})

// AC-022 is applied to assistant paragraphs, including fences that span deltas.
test("AC-022 converts markdown in assistant text across deltas", () => {
  const n = narrator()
  const out = [...n.commit(textDelta("Here is **code**:\n```js\nlet x")), ...n.commit(textDelta(" = 1\n```\n"))]
  expect(out).toEqual([
    { label: "assistant", text: "Here is code:" },
    { text: "code (js):" },
    { text: "let x = 1" },
    { text: "end code" },
  ])
})

// AC-026: reasoning is hidden by default and shown with the thinking label when enabled.
test("AC-026 hides reasoning by default", () => {
  const n = narrator()
  expect(n.commit(reasoningDelta("Thinking: plan\n"))).toEqual([])
  expect(n.flush()).toEqual([])
})

test("AC-026 shows reasoning with the thinking label and strips the transport prefix", () => {
  const n = narrator({ thinking: true })
  expect(n.commit(reasoningDelta("Thinking: first step\n"))).toEqual([{ label: "thinking", text: "first step" }])
  expect(n.commit(reasoningDelta("second step\n"))).toEqual([{ text: "second step" }])
})

// AC-020: user, system and error commits get their labels.
test("AC-020 user, system and error commits are labelled", () => {
  const n = narrator()
  expect(n.commit(userCommit("do the thing"))).toEqual([{ label: "you", text: "do the thing" }])
  expect(n.commit(systemCommit("Compaction"))).toEqual([{ label: "system", text: "Compaction" }])
  expect(n.commit(errorCommit("boom"))).toEqual([{ label: "error", text: "boom" }])
})

// AC-025: brief tool narration.
test("AC-025 brief narration announces the tool title on start and a line count on completion", () => {
  const n = narrator({ directory: "/repo" })
  const part = completedTool({ name: "read", args: { filePath: "/repo/src/app.ts" }, output: "a\nb\nc" })
  const start = n.commit(toolStart(runningTool({ name: "read", args: { filePath: "/repo/src/app.ts" } })))
  expect(start).toHaveLength(1)
  expect(start[0]?.label).toBe("tool")
  expect(start[0]?.text).toContain("app.ts")
  expect(n.commit(toolDone(part))).toEqual([{ label: "result", text: "3 lines" }])
})

test("AC-025 completion is reported once even if the transport repeats it", () => {
  const n = narrator()
  const part = completedTool({ name: "grep", output: "x" })
  n.commit(toolStart(runningTool({ name: "grep" })))
  expect(n.commit(toolDone(part))).toEqual([{ label: "result", text: "1 line" }])
  expect(n.commit(toolDone(part))).toEqual([])
})

test("AC-025 a completed tool without visible output reports done", () => {
  const n = narrator()
  const part = completedTool({ name: "edit", output: "" })
  n.commit(toolStart(runningTool({ name: "edit" })))
  expect(n.commit(toolDone(part))).toEqual([{ label: "result", text: "done" }])
})

test("AC-025 a failed tool reports the error message", () => {
  const n = narrator()
  const part = failedTool({ name: "shell", message: "exit code 1" })
  n.commit(toolStart(runningTool({ name: "shell" })))
  expect(n.commit(toolFailed(part, "exit code 1"))).toEqual([{ label: "result", text: "error: exit code 1" }])
})

test("AC-025 tools off narrates nothing about tools", () => {
  const n = narrator({ tools: "off" })
  const part = completedTool({ name: "read", output: "a" })
  expect(n.commit(toolStart(runningTool({ name: "read" })))).toEqual([])
  expect(n.commit(toolDone(part))).toEqual([])
})

test("AC-025 tools full writes the output lines after the result line", () => {
  const n = narrator({ tools: "full" })
  const part = completedTool({ name: "grep", output: "line one\nline two" })
  n.commit(toolStart(runningTool({ name: "grep" })))
  expect(n.commit(toolDone(part))).toEqual([
    { label: "result", text: "2 lines" },
    { text: "line one" },
    { text: "line two" },
  ])
})

test("AC-025 direct shell commits are titled with the command", () => {
  const n = narrator()
  expect(
    n.commit(shellCommit("s1", "bun --version", { text: "$ bun --version", phase: "start", toolState: "running" })),
  ).toEqual([{ label: "tool", text: "Shell: bun --version" }])
  expect(
    n.commit(shellCommit("s1", "bun --version", { text: "1.4.2\n", phase: "progress", toolState: "running" })),
  ).toEqual([])
  expect(n.commit(shellCommit("s1", "bun --version", { text: "", phase: "final", toolState: "completed" }))).toEqual([
    { label: "result", text: "1 line" },
  ])
})

test("AC-025 a tool start flushes the assistant paragraph that preceded it", () => {
  const n = narrator()
  n.commit(textDelta("Let me look"))
  const out = n.commit(toolStart(runningTool({ name: "read" })))
  expect(out[0]).toEqual({ label: "assistant", text: "Let me look" })
  expect(out[1]?.label).toBe("tool")
})

// AC-014 applies inside narration too: tool titles and output are sanitised.
test("AC-014 tool output with ANSI codes is counted and printed clean", () => {
  const n = narrator({ tools: "full" })
  const part = completedTool({ name: "shell", output: "\x1b[32mok\x1b[0m\nsecond" })
  n.commit(toolStart(runningTool({ name: "shell" })))
  const out = n.commit(toolDone(part))
  expect(out).toEqual([{ label: "result", text: "2 lines" }, { text: "ok" }, { text: "second" }])
})

test("reset drops open buffers so replay starts clean", () => {
  const n = narrator()
  n.commit(textDelta("pending"))
  n.reset()
  expect(n.flush()).toEqual([])
})

test("AC-020 the assistant label returns after a tool line interrupted the message", () => {
  const n = narrator()
  n.commit(textDelta("First.\n", "m1"))
  n.commit(toolStart(runningTool({ name: "read" }), "m1"))
  expect(n.commit(textDelta("Second.\n", "m1"))).toEqual([{ label: "assistant", text: "Second." }])
})

test("AC-022 an open code fence survives a tool line between two deltas", () => {
  const n = narrator()
  const out = [
    ...n.commit(textDelta("```sh\n# comment\n", "m1")),
    ...n.commit(toolStart(runningTool({ name: "read" }), "m1")),
    ...n.commit(textDelta("echo hi\n```\n", "m1")),
  ]
  expect(out.map((line) => line.text)).toEqual(["code (sh):", "# comment", expect.any(String), "echo hi", "end code"])
  expect(out[2]?.label).toBe("tool")
})

test("AC-021 a running tool's progress commit does not break the open paragraph", () => {
  const n = narrator()
  n.commit(textDelta("Half a ", "m1"))
  expect(n.commit(toolStart(runningTool({ name: "read" }), "m1"))).toHaveLength(2)
  expect(n.commit(textDelta("sentence.\n", "m1"))).toEqual([{ label: "assistant", text: "sentence." }])
})

test("AC-025 tools without a readable output report done even when content exists", () => {
  const n = narrator()
  const part = completedTool({ name: "edit", output: "--- a\n+++ b\n-old\n+new" })
  n.commit(toolStart(runningTool({ name: "edit" })))
  expect(n.commit(toolDone(part))).toEqual([{ label: "result", text: "done" }])
})
