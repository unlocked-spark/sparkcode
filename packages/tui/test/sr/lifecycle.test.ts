import { expect, test } from "bun:test"
import { drive } from "./drive"
import { completedTool, runningTool, textDelta, toolDone, toolStart, userCommit } from "./fixture"

// TC-009 / AC-010 to AC-013, AC-020, AC-023, AC-028: output discipline under an automated drive.
test("TC-009 a full turn is written as labelled, append-only lines with Done and the bell", async () => {
  const d = await drive({ activation: { source: "command" }, sessionTitle: "Fix the bug" })
  d.footer.event({ type: "turn.send" })
  d.footer.append(userCommit("fix it"))
  d.footer.append(textDelta("Looking.\n"))
  d.footer.append(toolStart(runningTool({ name: "read", args: { filePath: "a.ts" } })))
  d.footer.append(toolDone(completedTool({ name: "read", args: { filePath: "a.ts" }, output: "x\ny" })))
  d.footer.append(textDelta("## Result\nAll \x1b[1mgood\x1b[0m."))
  d.footer.event({ type: "turn.idle" })
  await d.footer.idle()
  const text = d.writes.join("")
  expect(text).not.toContain("\x1b")
  for (const chunk of d.writes) {
    if (chunk === "\x07") continue
    expect(chunk.endsWith("\n")).toBe(true)
    expect(chunk.slice(0, -1)).not.toContain("\n")
  }
  expect(d.writes[0]).toBe("system: SparkCode, an accessibility fork of opencode. Screen reader mode on via command.\n")
  expect(d.lines()).toEqual([
    "system: SparkCode, an accessibility fork of opencode. Screen reader mode on via command.",
    "system: Session Fix the bug.",
    "system: Starting work.",
    "you: fix it",
    "assistant: Looking.",
    expect.stringMatching(/^tool: .*a\.ts/),
    "result: 2 lines",
    "assistant: Result",
    "All good.",
    "system: Done.",
    "\x07",
  ])
})

test("AC-005 the first line names the activation source and the detected reader", async () => {
  const d = await drive({ activation: { source: "detection", reader: "NVDA" } })
  expect(d.writes[0]).toBe(
    "system: SparkCode, an accessibility fork of opencode. Screen reader detected (NVDA). Screen reader mode on via detection. Set OPENCODE_SCREEN_READER=0 to use the visual interface.\n",
  )
})

test("AC-010 the lifecycle never touches the renderer surface", async () => {
  const d = await drive({ activation: { source: "flag" } })
  d.lifecycle.setTitle("Renamed")
  d.lifecycle.refreshTheme()
  const off = d.lifecycle.onResize(() => {})
  off()
  await d.lifecycle.resetForReplay()
  expect(d.writes.join("")).not.toContain("\x1b")
  expect(d.lines()).toContain("system: Session Renamed.")
})

test("AC-028 error commits and patch errors are written with the error label", async () => {
  const d = await drive({ activation: { source: "env" } })
  d.footer.append({ kind: "error", source: "system", text: "OpenCode 1.18.0 or newer is required", phase: "start" })
  await d.footer.idle()
  expect(d.lines()).toContain("error: OpenCode 1.18.0 or newer is required")
})

test("model and agent events are announced once per change", async () => {
  const d = await drive({ activation: { source: "command" } })
  d.footer.event({ type: "model", model: "Big Pickle", selection: { providerID: "opencode", modelID: "big-pickle" } })
  d.footer.event({ type: "model", model: "Big Pickle", selection: { providerID: "opencode", modelID: "big-pickle" } })
  d.footer.event({ type: "agent", agent: "build" })
  await d.footer.idle()
  expect(d.lines().filter((line) => line.startsWith("system: Model"))).toEqual(["system: Model: Big Pickle."])
  expect(d.lines()).toContain("system: Agent: build.")
})

test("stream.view permission and form requests are announced as text blocks", async () => {
  const d = await drive({ activation: { source: "command" } })
  d.footer.event({
    type: "stream.view",
    view: {
      type: "permission",
      request: {
        id: "perm_1",
        sessionID: "ses_1",
        action: "shell",
        resources: ["bun --version"],
      },
    },
  })
  await d.footer.idle()
  expect(d.lines()).toContain("permission: shell bun --version. Answer y for once, a for always, n to reject.")
})

test("AC-035 close writes the goodbye line last and resolves idle", async () => {
  const d = await drive({ activation: { source: "command" }, sessionTitle: "Hello" })
  await d.lifecycle.close({ showExit: true, sessionTitle: "Hello" })
  expect(d.lines().at(-1)).toBe("system: Session Hello saved. Goodbye.")
  expect(d.footer.isClosed).toBe(true)
})

test("AC-052 the footer forwards prompts from the input source to subscribers", async () => {
  const d = await drive({ activation: { source: "command" } })
  const received: string[] = []
  d.footer.onPrompt((prompt) => void received.push(prompt.text))
  d.submit("hello there")
  expect(received).toEqual(["hello there"])
  await d.footer.idle()
  expect(d.lines()).toContain("you: hello there")
})

test("exitWhenIdle closes the footer after the first turn ends", async () => {
  const d = await drive({ activation: { source: "command" }, exitWhenIdle: true })
  let closed = 0
  d.footer.onClose(() => void closed++)
  d.footer.event({ type: "turn.send" })
  d.footer.event({ type: "turn.idle" })
  await d.footer.idle()
  expect(closed).toBe(1)
  expect(d.footer.isClosed).toBe(true)
})

test("the session is announced once from setTitle when the runtime had no title at construction", async () => {
  const d = await drive({ activation: { source: "command" }, sessionID: "" })
  expect(d.lines()).toEqual([
    "system: SparkCode, an accessibility fork of opencode. Screen reader mode on via command.",
  ])
  d.lifecycle.setTitle("Fix the bug")
  d.lifecycle.setTitle("Fix the bug")
  d.lifecycle.setTitle("")
  await d.footer.idle()
  expect(d.lines()).toEqual([
    "system: SparkCode, an accessibility fork of opencode. Screen reader mode on via command.",
    "system: Session Fix the bug.",
  ])
})

test("AC-035 close is idempotent and says Goodbye alone when no session was ever named", async () => {
  const d = await drive({ activation: { source: "command" }, sessionID: "" })
  await d.lifecycle.close({ showExit: false })
  await d.lifecycle.close({ showExit: false })
  expect(d.lines().filter((line) => line.includes("Goodbye"))).toEqual(["system: Goodbye."])
})

test("notices are spoken right after the activation line", async () => {
  const d = await drive({
    activation: { source: "flag" },
    notices: ["Automatic permission approval is not available in screen reader mode; you will be asked."],
  })
  expect(d.lines().slice(0, 2)).toEqual([
    "system: SparkCode, an accessibility fork of opencode. Screen reader mode on via flag.",
    "system: Automatic permission approval is not available in screen reader mode; you will be asked.",
  ])
})

// AC-043: the update notice arrives from a network lookup and is spoken after the session line.
test("AC-043 a late notice that resolves first waits for the session line", async () => {
  let resolveLate!: (lines: string[]) => void
  const late = new Promise<string[]>((resolve) => (resolveLate = resolve))
  const d = await drive({ activation: { source: "command" }, sessionID: "", lateNotices: late })
  resolveLate(["SparkCode 2.0.32-sparkcode.2 is available. Run sparkcode update after this session."])
  await late
  await d.footer.idle()
  expect(d.lines()).toEqual([
    "system: SparkCode, an accessibility fork of opencode. Screen reader mode on via command.",
  ])
  d.lifecycle.setTitle("Fix the bug")
  await d.footer.idle()
  expect(d.lines()).toEqual([
    "system: SparkCode, an accessibility fork of opencode. Screen reader mode on via command.",
    "system: Session Fix the bug.",
    "system: SparkCode 2.0.32-sparkcode.2 is available. Run sparkcode update after this session.",
  ])
})

test("AC-043 a late notice that resolves after the session line is spoken at once, and an empty one is silent", async () => {
  let resolveLate!: (lines: string[]) => void
  const late = new Promise<string[]>((resolve) => (resolveLate = resolve))
  const d = await drive({ activation: { source: "command" }, sessionTitle: "Fix the bug", lateNotices: late })
  expect(d.lines()).toEqual([
    "system: SparkCode, an accessibility fork of opencode. Screen reader mode on via command.",
    "system: Session Fix the bug.",
  ])
  resolveLate(["SparkCode 2.0.32-sparkcode.2 is available. Run sparkcode update after this session."])
  await late
  await d.footer.idle()
  expect(d.lines().at(-1)).toBe(
    "system: SparkCode 2.0.32-sparkcode.2 is available. Run sparkcode update after this session.",
  )
  const quiet = await drive({ activation: { source: "command" }, sessionTitle: "Other", lateNotices: Promise.resolve([]) })
  await quiet.footer.idle()
  expect(quiet.lines()).toHaveLength(2)
})

// AC-044: the resumed history ends with a paragraph that has no newline; it must still be spoken and kept for /last.
test("AC-044 the end of a replay speaks the buffered tail instead of dropping it", async () => {
  const d = await drive({ activation: { source: "command" }, sessionTitle: "Resumed" })
  d.footer.append(textDelta("Earlier line.\n"))
  d.footer.append(textDelta("Final answer without a newline"))
  await d.lifecycle.resetForReplay()
  await d.footer.idle()
  expect(d.lines().slice(-2)).toEqual(["assistant: Earlier line.", "Final answer without a newline"])
  d.submit("/last")
  await d.footer.idle()
  expect(d.lines().at(-1)).toBe("Final answer without a newline")
})
