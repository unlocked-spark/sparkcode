import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export type ScreenReaderSettings = {
  version: 1
  tools: "off" | "brief" | "full"
  thinking: "on" | "off"
  heartbeat: { seconds: number }
  delivery: { mode: "stream" | "whole"; lineDelayMs: number; msPerChar: number }
  prompt: { marker: string; singleKeyAnswers: boolean }
  detection: "auto" | "off"
}

export const SETTINGS_FILENAME = "screen-reader.json"

export function defaultSettings(): ScreenReaderSettings {
  return {
    version: 1,
    tools: "brief",
    thinking: "off",
    heartbeat: { seconds: 15 },
    delivery: { mode: "stream", lineDelayMs: 0, msPerChar: 0 },
    prompt: { marker: "> ", singleKeyAnswers: true },
    detection: "auto",
  }
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

function record(value: Json | undefined): { [key: string]: Json } | undefined {
  if (value === null || value === undefined || Array.isArray(value)) return undefined
  return typeof value === "object" ? value : undefined
}

function oneOf<const T extends string>(value: Json | undefined, allowed: readonly T[], fallback: T): T {
  for (const item of allowed) if (value === item) return item
  return fallback
}

function bounded(value: Json | undefined, fallback: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : fallback
}

const MAX_HEARTBEAT_SECONDS = 3600
const MAX_LINE_DELAY_MS = 60_000
const MAX_MS_PER_CHAR = 1000

function text(value: Json | undefined, fallback: string) {
  return typeof value === "string" ? value : fallback
}

function flag(value: Json | undefined, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback
}

/** Merge whatever is on disk onto the defaults; unknown or invalid values fall back silently. */
export function parseSettings(raw: Json | undefined): ScreenReaderSettings {
  const base = defaultSettings()
  const root = record(raw)
  if (!root) return base
  if (root.version !== undefined && root.version !== 1) return base
  const heartbeat = record(root.heartbeat)
  const delivery = record(root.delivery)
  const prompt = record(root.prompt)
  return {
    version: 1,
    tools: oneOf(root.tools, ["off", "brief", "full"], base.tools),
    thinking: oneOf(root.thinking, ["on", "off"], base.thinking),
    heartbeat: { seconds: bounded(heartbeat?.seconds, base.heartbeat.seconds, MAX_HEARTBEAT_SECONDS) },
    delivery: {
      mode: oneOf(delivery?.mode, ["stream", "whole"], base.delivery.mode),
      lineDelayMs: bounded(delivery?.lineDelayMs, base.delivery.lineDelayMs, MAX_LINE_DELAY_MS),
      msPerChar: bounded(delivery?.msPerChar, base.delivery.msPerChar, MAX_MS_PER_CHAR),
    },
    prompt: {
      marker: text(prompt?.marker, base.prompt.marker),
      singleKeyAnswers: flag(prompt?.singleKeyAnswers, base.prompt.singleKeyAnswers),
    },
    detection: oneOf(root.detection, ["auto", "off"], base.detection),
  }
}

export async function loadSettings(file: string): Promise<ScreenReaderSettings> {
  const content = await readFile(file, "utf8").catch(() => undefined)
  if (content === undefined) return defaultSettings()
  try {
    return parseSettings(JSON.parse(content) as Json)
  } catch {
    return defaultSettings()
  }
}

export async function saveSettings(file: string, settings: ScreenReaderSettings): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(settings, null, 2) + "\n", "utf8")
}
