import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { defaultSettings, loadSettings, parseSettings, saveSettings } from "../../src/sr/settings"

// AC-050: settings live in their own file with safe defaults.
test("AC-050 defaults match the spec", () => {
  expect(defaultSettings()).toEqual({
    version: 1,
    tools: "brief",
    thinking: "off",
    heartbeat: { seconds: 15 },
    delivery: { mode: "stream", lineDelayMs: 0, msPerChar: 0 },
    prompt: { marker: "> ", singleKeyAnswers: true },
    detection: "auto",
  })
})

test("AC-050 parse merges partial and invalid values onto the defaults", () => {
  const parsed = parseSettings({ tools: "full", heartbeat: { seconds: "x" }, delivery: { msPerChar: 7 }, junk: 1 })
  expect(parsed.tools).toBe("full")
  expect(parsed.heartbeat.seconds).toBe(15)
  expect(parsed.delivery).toEqual({ mode: "stream", lineDelayMs: 0, msPerChar: 7 })
  expect(parseSettings(null)).toEqual(defaultSettings())
  expect(parseSettings({ tools: "loud" }).tools).toBe("brief")
})

test("AC-050 load returns defaults for a missing or corrupt file and save round-trips", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sr-settings-"))
  const file = path.join(dir, "screen-reader.json")
  expect(await loadSettings(file)).toEqual(defaultSettings())
  writeFileSync(file, "{ not json")
  expect(await loadSettings(file)).toEqual(defaultSettings())
  const next = { ...defaultSettings(), tools: "off" as const, heartbeat: { seconds: 30 } }
  await saveSettings(file, next)
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(next)
  expect(await loadSettings(file)).toEqual(next)
})

test("AC-050 out of range numbers and unknown versions fall back to defaults", () => {
  expect(parseSettings({ heartbeat: { seconds: 1e9 } }).heartbeat.seconds).toBe(15)
  expect(parseSettings({ delivery: { lineDelayMs: -1, msPerChar: 5000 } }).delivery).toEqual(defaultSettings().delivery)
  expect(parseSettings({ version: 2, tools: "full" })).toEqual(defaultSettings())
  expect(parseSettings({ version: 1, tools: "full" }).tools).toBe("full")
})
