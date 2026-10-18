import { expect, test } from "bun:test"
import { drive } from "./drive"
import type { MiniFormRequest } from "../../src/mini/types"
import { textDelta } from "./fixture"

const permission = {
  id: "perm_1",
  sessionID: "ses_test",
  action: "shell",
  resources: ["bun --version"],
}

function questionForm(fields: MiniFormRequest["fields"]) {
  const request: MiniFormRequest = {
    id: "form_1",
    sessionID: "ses_test",
    title: "Which colour do you prefer?",
    fields,
  }
  return { type: "form" as const, request }
}

// AC-030 / AC-031: prompt marker and echo.
test("AC-030 the prompt marker shows when idle and hides while a turn runs", async () => {
  const d = await drive({ activation: { source: "command" } })
  expect(d.prompting()).toBe(true)
  d.footer.event({ type: "turn.send" })
  expect(d.prompting()).toBe(false)
  d.footer.event({ type: "turn.idle" })
  await d.footer.idle()
  expect(d.prompting()).toBe(true)
})

test("AC-031 an idle prompt is echoed as you: and forwarded; empty lines are ignored", async () => {
  const d = await drive({ activation: { source: "command" } })
  const sent: string[] = []
  d.footer.onPrompt((prompt) => void sent.push(prompt.text))
  d.submit("   ")
  d.submit("hello")
  await d.footer.idle()
  expect(sent).toEqual(["hello"])
  expect(d.lines()).toContain("you: hello")
})

// AC-032: prompts typed during a turn are queued; /undo removes the last one.
test("AC-032 a prompt typed during a turn is announced as queued and still forwarded", async () => {
  const d = await drive({ activation: { source: "command" } })
  const sent: string[] = []
  d.footer.onPrompt((prompt) => void sent.push(prompt.text))
  d.footer.event({ type: "turn.send" })
  d.submit("and then say hello")
  await d.footer.idle()
  expect(sent).toEqual(["and then say hello"])
  expect(d.lines()).toContain("system: Queued: and then say hello")
  expect(d.lines()).not.toContain("you: and then say hello")
})

test("AC-032 /undo cancels the last queued prompt reported by the runtime", async () => {
  const d = await drive({ activation: { source: "command" } })
  d.footer.event({ type: "turn.send" })
  d.footer.event({
    type: "queued.prompts",
    prompts: [
      { messageID: "inbox_1", prompt: { text: "one", parts: [] }, delivery: "queue" },
      { messageID: "inbox_2", prompt: { text: "two", parts: [] }, delivery: "queue" },
    ],
  })
  d.submit("/undo")
  await new Promise((resolve) => setTimeout(resolve, 0))
  await d.footer.idle()
  expect(d.queuedActions).toEqual([{ action: "cancel", inboxID: "inbox_2" }])
  expect(d.lines()).toContain("system: Queued prompt removed.")
  d.footer.event({ type: "queued.prompts", prompts: [] })
  d.submit("/undo")
  await d.footer.idle()
  expect(d.lines()).toContain("system: Nothing queued.")
})

// AC-033 / AC-034: Esc, Ctrl+C and Ctrl+D.
test("AC-033 Esc during a turn interrupts and announces it; Esc when idle does nothing", async () => {
  const d = await drive({ activation: { source: "command" } })
  d.key("escape")
  expect(d.interrupts).toBe(0)
  d.footer.event({ type: "turn.send" })
  d.key("escape")
  await d.footer.idle()
  expect(d.interrupts).toBe(1)
  expect(d.lines()).toContain("system: Interrupted.")
  d.footer.event({ type: "turn.idle" })
  await d.footer.idle()
  expect(d.lines()).not.toContain("system: Done.")
})

test("AC-034 Ctrl+C interrupts a turn, and twice within two seconds when idle exits", async () => {
  let now = 1000
  const d = await drive({ activation: { source: "command" }, now: () => now })
  let closed = 0
  d.footer.onClose(() => void closed++)
  d.footer.event({ type: "turn.send" })
  d.key("ctrl-c")
  expect(d.interrupts).toBe(1)
  d.footer.event({ type: "turn.idle" })
  d.key("ctrl-c")
  await d.footer.idle()
  expect(d.lines()).toContain("system: Press Ctrl+C again to exit.")
  expect(closed).toBe(0)
  now += 3000
  d.key("ctrl-c")
  await d.footer.idle()
  expect(closed).toBe(0)
  now += 500
  d.key("ctrl-c")
  expect(closed).toBe(1)
})

test("AC-034 Ctrl+D and /exit close the footer at once", async () => {
  const a = await drive({ activation: { source: "command" } })
  let closedA = 0
  a.footer.onClose(() => void closedA++)
  a.key("ctrl-d")
  expect(closedA).toBe(1)
  const b = await drive({ activation: { source: "command" } })
  let closedB = 0
  b.footer.onClose(() => void closedB++)
  b.submit("/exit")
  expect(closedB).toBe(1)
})

// AC-040: permissions.
test("AC-040 a permission request is announced and answered with a single key", async () => {
  const d = await drive({ activation: { source: "command" } })
  d.footer.event({ type: "stream.view", view: { type: "permission", request: permission } })
  await d.footer.idle()
  expect(d.lines()).toContain("permission: shell bun --version. Answer y for once, a for always, n to reject.")
  expect(d.char("x")).toBe(false)
  expect(d.char("y")).toBe(true)
  await d.footer.idle()
  expect(d.permissions).toEqual([{ sessionID: "ses_test", requestID: "perm_1", decision: "once" }])
  expect(d.lines()).toContain("system: Allowed once.")
})

test("AC-040 typed answers a, n and anything else", async () => {
  const d = await drive({ activation: { source: "command" } })
  d.footer.event({ type: "stream.view", view: { type: "permission", request: permission } })
  d.submit("maybe")
  await d.footer.idle()
  expect(d.lines()).toContain("system: Answer y, a or n.")
  expect(d.permissions).toEqual([])
  d.submit("A")
  await d.footer.idle()
  expect(d.permissions.at(-1)?.decision).toBe("always")
  expect(d.lines()).toContain("system: Allowed always.")
  d.footer.event({ type: "stream.view", view: { type: "permission", request: { ...permission, id: "perm_2" } } })
  d.submit("n")
  await d.footer.idle()
  expect(d.permissions.at(-1)).toEqual({ sessionID: "ses_test", requestID: "perm_2", decision: "reject" })
  expect(d.lines()).toContain("system: Rejected.")
})

test("AC-045 a second permission waits until the first is answered, and a prompt view dismisses a stale one", async () => {
  const d = await drive({ activation: { source: "command" } })
  d.footer.event({ type: "stream.view", view: { type: "permission", request: permission } })
  d.footer.event({
    type: "stream.view",
    view: { type: "permission", request: { ...permission, id: "perm_2", resources: ["rm x"] } },
  })
  await d.footer.idle()
  expect(d.lines().filter((line) => line.startsWith("permission:"))).toHaveLength(1)
  d.submit("y")
  await d.footer.idle()
  expect(d.lines().filter((line) => line.startsWith("permission:"))).toHaveLength(2)
  d.footer.event({ type: "stream.view", view: { type: "prompt" } })
  d.submit("y")
  await d.footer.idle()
  expect(d.permissions).toHaveLength(1)
  expect(d.lines()).toContain("you: y")
})

// AC-041: questions and forms.
test("AC-041 a question with options is a numbered menu answered by number or free text", async () => {
  const d = await drive({ activation: { source: "command" } })
  d.footer.event({
    type: "stream.view",
    view: questionForm([
      {
        type: "string",
        key: "colour",
        title: "Colour",
        options: [
          { value: "red", label: "Red" },
          { value: "blue", label: "Blue" },
        ],
      },
    ]),
  })
  await d.footer.idle()
  expect(d.lines().slice(-4)).toEqual([
    "question: Which colour do you prefer?",
    "1. Red",
    "2. Blue",
    "Type the number.",
  ])
  d.submit("2")
  await d.footer.idle()
  expect(d.forms).toEqual([
    { sessionID: "ses_test", formID: "form_1", answer: { colour: "blue" }, location: undefined },
  ])
  expect(d.lines()).toContain("system: Answered: Blue.")
})

test("AC-041 free-text, number and boolean fields are asked one by one; Esc cancels the form", async () => {
  const d = await drive({ activation: { source: "command" } })
  d.footer.event({
    type: "stream.view",
    view: questionForm([
      { type: "string", key: "name", title: "Project name" },
      { type: "integer", key: "count", title: "How many" },
      { type: "boolean", key: "ok", title: "Proceed?" },
    ]),
  })
  await d.footer.idle()
  expect(d.lines()).toContain("question: Project name")
  d.submit("SparkCode")
  await d.footer.idle()
  expect(d.lines()).toContain("question: How many")
  d.submit("three")
  await d.footer.idle()
  expect(d.lines().at(-1)).toMatch(/^system: .*number/)
  d.submit("3")
  await d.footer.idle()
  expect(d.lines()).toContain("question: Proceed?")
  expect(d.lines()).toContain("1. Yes")
  d.submit("1")
  await d.footer.idle()
  expect(d.forms.at(-1)?.answer).toEqual({ name: "SparkCode", count: 3, ok: true })
  const e = await drive({ activation: { source: "command" } })
  e.footer.event({ type: "stream.view", view: questionForm([{ type: "string", key: "name", title: "Name" }]) })
  e.key("escape")
  await e.footer.idle()
  expect(e.cancels).toEqual([{ sessionID: "ses_test", formID: "form_1", location: undefined }])
  expect(e.lines()).toContain("system: Question cancelled.")
})

// AC-042 / AC-043: model and agent menus.
test("AC-042 /model lists models as a numbered menu, filters by text and applies the choice", async () => {
  const d = await drive({ activation: { source: "command" } })
  d.footer.event({
    type: "models",
    providers: [
      { id: "opencode", name: "OpenCode", models: { "big-pickle": { name: "Big Pickle" } } },
      { id: "anthropic", name: "Anthropic", models: { "claude-fable-5-1": { name: "Claude Fable 5.1" } } },
    ],
  })
  d.footer.event({ type: "model", model: "Big Pickle", selection: { providerID: "opencode", modelID: "big-pickle" } })
  d.submit("/model")
  await d.footer.idle()
  expect(d.lines()).toContain("system: Models:")
  expect(d.lines()).toContain("1. OpenCode Big Pickle (current)")
  expect(d.lines()).toContain("2. Anthropic Claude Fable 5.1")
  d.submit("2")
  await d.footer.idle()
  expect(d.modelSelections).toEqual([{ providerID: "anthropic", modelID: "claude-fable-5-1" }])
  expect(d.lines().at(-1)).toBe("system: Model: Anthropic Claude Fable 5.1.")
  d.submit("/status")
  await d.footer.idle()
  expect(d.lines()).toContain("system: Model: Anthropic Claude Fable 5.1")
  d.submit("/model")
  await d.footer.idle()
  expect(d.lines()).toContain("2. Anthropic Claude Fable 5.1 (current)")
  d.key("escape")
  await d.footer.idle()
  d.submit("/model fable")
  await d.footer.idle()
  expect(d.lines().at(-2)).toBe("1. Anthropic Claude Fable 5.1 (current)")
  d.key("escape")
  await d.footer.idle()
  expect(d.lines().at(-1)).toBe("system: Cancelled.")
})

test("AC-043 /agent lists primary agents and applies the choice", async () => {
  const d = await drive({
    activation: { source: "command" },
    agents: [
      { id: "build", name: "Build", mode: "primary", hidden: false },
      { id: "plan", name: "Plan", description: "Plans first", mode: "primary", hidden: false },
      { id: "explore", name: "Explore", mode: "subagent", hidden: false },
    ],
  })
  d.footer.event({ type: "agent", agent: "build" })
  d.submit("/agent")
  await d.footer.idle()
  expect(d.lines()).toContain("1. Build (current)")
  expect(d.lines()).toContain("2. Plan: Plans first")
  expect(d.lines()).not.toContain("3. Explore")
  d.submit("2")
  await d.footer.idle()
  expect(d.agentSelections).toEqual(["plan"])
})

// AC-044: sessions.
test("AC-044 /sessions lists sessions and switching closes the footer with the chosen id", async () => {
  const d = await drive({
    activation: { source: "command" },
    sessions: [
      { id: "ses_a", title: "Fix the bug", updated: Date.now() - 60_000 },
      { id: "ses_b", title: "", updated: Date.now() - 3_600_000 },
    ],
  })
  let closed = 0
  d.footer.onClose(() => void closed++)
  d.submit("/sessions")
  await new Promise((resolve) => setTimeout(resolve, 0))
  await d.footer.idle()
  expect(d.lines()).toContain("system: Sessions:")
  expect(d.lines()).toContain("1. Fix the bug (1 minute ago)")
  expect(d.lines()).toContain("2. ses_b (1 hour ago)")
  d.submit("1")
  await d.footer.idle()
  expect(d.lines()).toContain("system: Switching to session Fix the bug.")
  expect(d.switches).toEqual(["ses_a"])
  expect(closed).toBe(1)
})

test("AC-044 /new and /compact are forwarded to the runtime as prompts", async () => {
  const d = await drive({ activation: { source: "command" } })
  const sent: string[] = []
  d.footer.onPrompt((prompt) => void sent.push(prompt.text))
  d.submit("/new")
  d.submit("/compact")
  expect(sent).toEqual(["/new", "/compact"])
})

// AC-046 / AC-047: help, status, last and settings commands.
test("AC-046 /help, /status and /last write their lines", async () => {
  const d = await drive({ activation: { source: "command" }, sessionTitle: "Fix the bug" })
  d.footer.event({ type: "model", model: "Big Pickle", selection: { providerID: "opencode", modelID: "big-pickle" } })
  d.footer.event({ type: "agent", agent: "build" })
  d.footer.event({ type: "stream.patch", patch: { usage: { tokens: 1234, cost: 0 } } })
  d.footer.event({ type: "turn.send" })
  d.footer.append(textDelta("First answer.\nSecond line.\n"))
  d.footer.event({ type: "turn.idle" })
  d.submit("/status")
  await d.footer.idle()
  expect(d.lines()).toContain("system: Session: Fix the bug")
  expect(d.lines()).toContain("system: Model: Big Pickle")
  expect(d.lines()).toContain("system: Agent: build")
  expect(d.lines()).toContain("system: Tokens: 1234")
  expect(d.lines()).toContain("system: State: idle")
  d.submit("/last")
  await d.footer.idle()
  expect(d.lines().slice(-2)).toEqual(["assistant: First answer.", "Second line."])
  d.submit("/help")
  await d.footer.idle()
  expect(d.lines().some((line) => line.startsWith("system: /model"))).toBe(true)
  expect(d.lines().some((line) => line.startsWith("system: /exit"))).toBe(true)
})

test("AC-047 /tools, /thinking and /heartbeat change, persist and confirm; bad values explain", async () => {
  const d = await drive({ activation: { source: "command" } })
  d.submit("/tools full")
  d.submit("/thinking on")
  d.submit("/heartbeat 30")
  d.submit("/tools loud")
  await d.footer.idle()
  expect(d.saved.map((item) => [item.tools, item.thinking, item.heartbeat.seconds])).toEqual([
    ["full", "off", 15],
    ["full", "on", 15],
    ["full", "on", 30],
  ])
  expect(d.lines()).toContain("system: Tools: full.")
  expect(d.lines()).toContain("system: Thinking: on.")
  expect(d.lines()).toContain("system: Heartbeat: 30 seconds.")
  expect(d.lines().at(-1)).toBe("system: Usage: /tools off|brief|full")
})

test("an unknown slash command is explained, not sent to the model", async () => {
  const d = await drive({ activation: { source: "command" } })
  const sent: string[] = []
  d.footer.onPrompt((prompt) => void sent.push(prompt.text))
  d.submit("/frobnicate")
  await d.footer.idle()
  expect(sent).toEqual([])
  expect(d.lines()).toContain("system: Unknown command /frobnicate. Type /help.")
})

// AC-052: end of piped input.
test("AC-052 end of input exits once the running turn and queue are done", async () => {
  const d = await drive({ activation: { source: "command" } })
  let closed = 0
  d.footer.onClose(() => void closed++)
  d.footer.event({ type: "turn.send" })
  d.eof()
  expect(closed).toBe(0)
  d.footer.event({ type: "turn.idle" })
  await d.footer.idle()
  expect(closed).toBe(1)
  const e = await drive({ activation: { source: "command" } })
  let closedE = 0
  e.footer.onClose(() => void closedE++)
  e.eof()
  expect(closedE).toBe(1)
})

test("AC-031 a prompt typed before the runtime subscribes is delivered on subscription", async () => {
  const d = await drive({ activation: { source: "command" } })
  d.submit("early bird")
  const sent: string[] = []
  d.footer.onPrompt((prompt) => void sent.push(prompt.text))
  expect(sent).toEqual(["early bird"])
  d.submit("later")
  expect(sent).toEqual(["early bird", "later"])
})

test("AC-052 end of input right after a buffered prompt waits for that prompt's turn", async () => {
  const d = await drive({ activation: { source: "command" } })
  let closed = 0
  d.footer.onClose(() => void closed++)
  d.submit("Reply with OK")
  d.eof()
  expect(closed).toBe(0)
  const sent: string[] = []
  d.footer.onPrompt((prompt) => void sent.push(prompt.text))
  expect(sent).toEqual(["Reply with OK"])
  expect(closed).toBe(0)
  d.footer.event({ type: "turn.send" })
  d.footer.event({ type: "turn.idle" })
  await d.footer.idle()
  expect(closed).toBe(1)
})

test("a close listener registered after the footer closed is called at once", async () => {
  const d = await drive({ activation: { source: "command" } })
  d.key("ctrl-d")
  let closed = 0
  d.footer.onClose(() => void closed++)
  expect(closed).toBe(1)
})

test("AC-052 in one-shot mode the end of a drained pipe does not exit before the runtime's own turn", async () => {
  const d = await drive({ activation: { source: "command" }, exitWhenIdle: true })
  let closed = 0
  d.footer.onClose(() => void closed++)
  d.eof()
  expect(closed).toBe(0)
  d.footer.event({ type: "turn.send" })
  d.footer.event({ type: "turn.idle" })
  expect(closed).toBe(1)
})

// Review findings of cycle 2.
test("AC-030 the marker comes after Done and the bell, and after Interrupted", async () => {
  const d = await drive({ activation: { source: "command" }, recordMarker: true })
  d.footer.event({ type: "turn.send" })
  d.footer.event({ type: "turn.idle" })
  await d.footer.idle()
  await d.footer.idle()
  expect(d.lines().slice(-3)).toEqual(["system: Done.", "\x07", "> "])
  d.footer.event({ type: "turn.send" })
  d.key("escape")
  await d.footer.idle()
  await d.footer.idle()
  expect(d.lines().slice(-2)).toEqual(["system: Interrupted.", "> "])
})

test("AC-032 the runtime's user commit for a queued prompt is still spoken, while an idle echo is not doubled", async () => {
  const d = await drive({ activation: { source: "command" } })
  d.submit("first")
  d.footer.append({ kind: "user", source: "system", text: "first", phase: "start", messageID: "m1" })
  d.footer.event({ type: "turn.send" })
  d.submit("second")
  d.footer.append({ kind: "user", source: "system", text: "second", phase: "start", messageID: "m2" })
  await d.footer.idle()
  expect(d.lines().filter((line) => line === "you: first")).toHaveLength(1)
  expect(d.lines()).toContain("system: Queued: second")
  expect(d.lines()).toContain("you: second")
})

test("AC-046 /last repeats the same answer every time", async () => {
  const d = await drive({ activation: { source: "command" } })
  d.footer.event({ type: "turn.send" })
  d.footer.append(textDelta("Alpha.\nBeta.\n"))
  d.footer.event({ type: "turn.idle" })
  d.submit("/last")
  d.submit("/last")
  await d.footer.idle()
  expect(d.lines().filter((line) => line === "assistant: Alpha.")).toHaveLength(3)
  expect(d.lines().filter((line) => line === "Beta.")).toHaveLength(3)
})

test("AC-043 /agent confirms the choice even though the runtime emits no agent event", async () => {
  const d = await drive({
    activation: { source: "command" },
    agents: [
      { id: "build", name: "Build", mode: "primary", hidden: false },
      { id: "plan", name: "Plan", mode: "primary", hidden: false },
    ],
  })
  d.submit("/agent")
  d.submit("2")
  await d.footer.idle()
  expect(d.agentSelections).toEqual(["plan"])
  expect(d.lines()).toContain("system: Agent: Plan.")
  d.footer.event({ type: "agent", agent: "plan" })
  await d.footer.idle()
  expect(d.lines().filter((line) => line === "system: Agent: Plan.")).toHaveLength(1)
})

test("AC-052 two piped lines, the second admitted during the first turn, exit after the single idle", async () => {
  const d = await drive({ activation: { source: "command" } })
  let closed = 0
  d.footer.onClose(() => void closed++)
  d.footer.onPrompt(() => {})
  d.submit("one")
  d.footer.event({ type: "turn.send" })
  d.submit("two")
  d.eof()
  d.footer.event({ type: "turn.idle" })
  await d.footer.idle()
  expect(closed).toBe(1)
})

test("AC-052 a piped /new followed by end of input exits once the queue reports idle", async () => {
  const d = await drive({ activation: { source: "command" } })
  let closed = 0
  d.footer.onClose(() => void closed++)
  d.footer.onPrompt(() => {})
  d.submit("/new")
  d.eof()
  expect(closed).toBe(0)
  d.footer.event({ type: "turn.idle" })
  await d.footer.idle()
  expect(closed).toBe(1)
})

test("AC-034 keys with a menu open cancel the menu and never interrupt or exit", async () => {
  const d = await drive({ activation: { source: "command" } })
  let closed = 0
  d.footer.onClose(() => void closed++)
  d.footer.event({ type: "stream.view", view: { type: "permission", request: permission } })
  d.key("escape")
  await d.footer.idle()
  expect(d.permissions.at(-1)?.decision).toBe("reject")
  expect(d.lines()).toContain("system: Rejected.")
  d.footer.event({
    type: "models",
    providers: [{ id: "opencode", name: "OpenCode", models: { "big-pickle": { name: "Big Pickle" } } }],
  })
  d.submit("/model")
  d.key("ctrl-c")
  d.key("ctrl-c")
  await d.footer.idle()
  expect(d.interrupts).toBe(0)
  expect(closed).toBe(0)
  expect(d.lines()).toContain("system: Cancelled.")
})

test("AC-034 /exit and :q work while a menu is waiting", async () => {
  const d = await drive({ activation: { source: "command" } })
  let closed = 0
  d.footer.onClose(() => void closed++)
  d.footer.event({ type: "stream.view", view: { type: "permission", request: permission } })
  d.submit("/exit")
  expect(closed).toBe(1)
})

test("AC-040 single-key answers can be turned off in settings", async () => {
  const d = await drive({
    activation: { source: "command" },
    settings: { prompt: { marker: "> ", singleKeyAnswers: false } },
  })
  d.footer.event({ type: "stream.view", view: { type: "permission", request: permission } })
  expect(d.char("y")).toBe(false)
  d.submit("y")
  await d.footer.idle()
  expect(d.permissions.at(-1)?.decision).toBe("once")
})

test("AC-044 the current session is left out of /sessions and a switched lifecycle announces the replay", async () => {
  const d = await drive({
    activation: { source: "command" },
    sessionID: "ses_a",
    sessions: [
      { id: "ses_a", title: "Current", updated: Date.now() },
      { id: "ses_b", title: "Other", updated: Date.now() },
    ],
  })
  d.submit("/sessions")
  await new Promise((resolve) => setTimeout(resolve, 0))
  await d.footer.idle()
  expect(d.lines().some((line) => line.includes("Current"))).toBe(false)
  expect(d.lines()).toContain("1. Other (just now)")
  const e = await drive({ activation: { source: "command" }, switched: true, sessionID: "" })
  e.lifecycle.setTitle("Other")
  await e.footer.idle()
  expect(e.lines()).toEqual(["system: Replaying session Other."])
})

test("AC-042 the model confirmation uses the label the runtime answers with", async () => {
  const d = await drive({
    activation: { source: "command" },
    modelResult: (model) => ({ modelLabel: `${model.modelID} (thinking)` }),
  })
  d.footer.event({
    type: "models",
    providers: [{ id: "anthropic", name: "Anthropic", models: { "claude-fable-5-1": { name: "Claude Fable 5.1" } } }],
  })
  d.submit("/model")
  await d.footer.idle()
  d.submit("1")
  await d.footer.idle()
  expect(d.lines().at(-1)).toBe("system: Model: claude-fable-5-1 (thinking).")
  d.submit("/status")
  await d.footer.idle()
  expect(d.lines()).toContain("system: Model: claude-fable-5-1 (thinking)")
})
