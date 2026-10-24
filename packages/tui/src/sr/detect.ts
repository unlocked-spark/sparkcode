import { execFile } from "node:child_process"
import type { ActivationSource } from "./lifecycle"
import type { ScreenReaderSettings } from "./settings"

export type ScreenReaderName = "NVDA" | "JAWS"

export type DetectOptions = {
  platform?: NodeJS.Platform
  /** Returns the raw output of the process list; defaults to `tasklist /FO CSV /NH`. */
  listProcesses?: () => Promise<string>
  timeoutMs?: number
}

// tasklist regularly needs one to two seconds on Windows; half a second made a
// running NVDA look absent and started the visual interface (seen 2026-10-24).
const DEFAULT_TIMEOUT_MS = 3000

const readers: ReadonlyArray<readonly [image: string, name: ScreenReaderName]> = [
  ["nvda.exe", "NVDA"],
  ["jfw.exe", "JAWS"],
]

function tasklist(timeoutMs: number) {
  return new Promise<string>((resolve, reject) => {
    execFile("tasklist", ["/FO", "CSV", "/NH"], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) return reject(error)
      resolve(stdout)
    })
  })
}

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    task.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })
}

/** Image names from `tasklist` CSV output: the first quoted field of each line. */
function imageNames(output: string) {
  return output
    .split(/\r?\n/)
    .map((line) => /^"([^"]+)"/.exec(line)?.[1]?.toLowerCase())
    .filter((name): name is string => name !== undefined)
}

// Windows only in v1 (AC-004): a running nvda.exe or jfw.exe means a screen
// reader user. The lookup is bounded (AC-003) and the default command runs it
// alongside the server connection, so it rarely adds anything to startup.
export async function detectScreenReader(options: DetectOptions = {}): Promise<ScreenReaderName | undefined> {
  const platform = options.platform ?? process.platform
  if (platform !== "win32") return undefined
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const list = options.listProcesses ?? (() => tasklist(timeoutMs))
  const output = await withTimeout(Promise.resolve().then(list), timeoutMs)
  if (!output) return undefined
  const names = new Set(imageNames(output))
  return readers.find(([image]) => names.has(image))?.[1]
}

export type ActivationOptions = {
  /** `--screen-reader` on the command line. */
  flag: boolean
  /** The value of OPENCODE_SCREEN_READER, if set. */
  env: string | undefined
  platform?: NodeJS.Platform
  detection: ScreenReaderSettings["detection"]
  detect?: () => Promise<ScreenReaderName | undefined>
}

function truthy(value: string) {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())
}

// Precedence (AC-002, AC-003): the flag, then the environment variable (which
// can also veto detection), then process detection where the settings allow it.
export async function resolveActivation(options: ActivationOptions): Promise<ActivationSource | undefined> {
  if (options.flag) return { source: "flag" }
  if (options.env !== undefined) return truthy(options.env) ? { source: "env" } : undefined
  if (options.detection !== "auto") return undefined
  const platform = options.platform ?? process.platform
  if (platform !== "win32") return undefined
  const reader = await (options.detect ?? (() => detectScreenReader({ platform })))()
  return reader ? { source: "detection", reader } : undefined
}
