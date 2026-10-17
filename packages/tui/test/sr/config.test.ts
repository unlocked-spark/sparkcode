import { expect, test } from "bun:test"
import { visibleStreams } from "../../src/sr/config"

// The mini transport hides tool commits and buffers assistant text when mini.tools is "hide" (the
// upstream default). The screen reader frontend must receive every commit and filter itself (AC-021, AC-025, AC-026).
test("visibleStreams forces tools and thinking on and keeps the rest of the config", () => {
  const config = { theme: { name: "x" }, mini: { tools: "hide" as const, thinking: "hide" as const, mono: true } }
  const result = visibleStreams(config)
  expect(result.mini).toEqual({ tools: "show", thinking: "show", mono: true, splash: "hide", footer: "hide" })
  expect(result.theme).toEqual({ name: "x" })
  expect(config.mini.tools).toBe("hide")
})

test("visibleStreams works when the config has no mini section", () => {
  expect(visibleStreams({}).mini).toEqual({ tools: "show", thinking: "show", splash: "hide", footer: "hide" })
})
