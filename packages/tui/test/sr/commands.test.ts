import { expect, test } from "bun:test"
import { helpLines, parseCommand } from "../../src/sr/commands"

test("parseCommand splits the name and the rest, case-insensitively", () => {
  expect(parseCommand("/Model fable 5")).toEqual({ name: "model", args: "fable 5" })
  expect(parseCommand("/exit")).toEqual({ name: "exit", args: "" })
  expect(parseCommand("  /help  ")).toEqual({ name: "help", args: "" })
})

test("parseCommand leaves ordinary text and lone slashes alone", () => {
  expect(parseCommand("hello /model")).toBeUndefined()
  expect(parseCommand("/")).toBeUndefined()
  expect(parseCommand("/ model")).toBeUndefined()
})

test("helpLines names every command once with its purpose", () => {
  const names = helpLines().map((line) => line.text.split(/[: ]/)[0])
  for (const name of [
    "/help",
    "/status",
    "/last",
    "/model",
    "/agent",
    "/sessions",
    "/new",
    "/compact",
    "/tools",
    "/thinking",
    "/heartbeat",
    "/undo",
    "/exit",
  ])
    expect(names).toContain(name)
  expect(new Set(names).size).toBe(names.length)
  for (const line of helpLines()) expect(line.text).toMatch(/^\/\S+( [^:]*)?: .+/)
})
