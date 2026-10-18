import {
  SPARKCODE_FEED_URL,
  SPARKCODE_INSTALLER_URL,
  SPARKCODE_NAME,
  SPARKCODE_REPOSITORY,
} from "@opencode/util/sparkcode"
import { parseReleaseVersion } from "./services/updater-action"

// SparkCode's own update path: a static version feed on the product site, the
// PowerShell installer for Windows, and plain one-line output that a screen
// reader can follow. Everything that touches the network or the system is
// injected (UpdateDeps), so the whole flow is unit tested without either.

export type FeedAsset = { url: string; sha256: string; size?: number }

export type Feed = {
  version: string
  upstream: string
  released: string
  notes?: string
  assets: Record<string, FeedAsset>
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>

export class FeedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "FeedError"
  }
}

export type UpdateDeps = {
  /** The running build's version, `local` for a source checkout. */
  running: string
  platform: NodeJS.Platform
  arch: string
  fetch: FetchLike
  /** One logical line, without a line break. */
  write: (line: string) => void
  /** Stores the downloaded installer and returns its path. */
  writeTemp: (name: string, content: string) => Promise<string>
  /** Runs a command with the terminal attached and resolves with its exit code. */
  run: (command: string, args: string[]) => Promise<number>
  /** Whether this PowerShell executable (`pwsh` or `powershell`) can be started. */
  hasPowerShell: (command: string) => Promise<boolean>
  feedUrl?: string
  installerUrl?: string
  timeoutMs?: number
}

export type UpdateOptions = { target?: string; method?: string }

export type UpdateState = "up-to-date" | "updated" | "unsupported" | "development" | "failed"

export type UpdateResult = { state: UpdateState; running: string; latest?: string; exitCode: number }

const FEED_TIMEOUT_MS = 10_000
const STARTUP_CHECK_TIMEOUT_MS = 3_000

const targets: Partial<Record<NodeJS.Platform, Record<string, string>>> = {
  win32: { x64: "windows-x64", arm64: "windows-arm64" },
  darwin: { arm64: "darwin-arm64", x64: "darwin-x64" },
  linux: { x64: "linux-x64", arm64: "linux-arm64" },
}

/** The feed's asset key for a platform, or undefined where no build is planned. */
export function feedTarget(platform: NodeJS.Platform, arch: string) {
  return targets[platform]?.[arch]
}

function compareIdentifiers(left: string, right: string) {
  const leftNumeric = /^[0-9]+$/.test(left)
  const rightNumeric = /^[0-9]+$/.test(right)
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right))
  // Numeric identifiers sort before alphanumeric ones (semver 11.4.3).
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Semver precedence with prerelease identifiers, which is where the fork
 * counter lives: `2.0.32-sparkcode.2` is newer than `2.0.32-sparkcode.1`,
 * `2.0.33-sparkcode.1` is newer than both, and a plain `2.0.32` is newer than
 * every `2.0.32-sparkcode.n`. Negative when `a` is older, undefined when either
 * side is not a version.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parseReleaseVersion(a)
  const right = parseReleaseVersion(b)
  if (!left || !right) return undefined
  const leftCore = left.core.split(".")
  const rightCore = right.core.split(".")
  for (let index = 0; index < 3; index++) {
    const order = compareIdentifiers(leftCore[index], rightCore[index])
    if (order !== 0) return order
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0
    return left.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index++) {
    const leftId = left.prerelease[index]
    const rightId = right.prerelease[index]
    if (leftId === undefined) return -1
    if (rightId === undefined) return 1
    const order = compareIdentifiers(leftId, rightId)
    if (order !== 0) return order
  }
  return 0
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function asAsset(value: unknown): FeedAsset | undefined {
  const record = asRecord(value)
  if (!record || typeof record.url !== "string" || typeof record.sha256 !== "string") return undefined
  const asset: FeedAsset = { url: record.url, sha256: record.sha256 }
  if (typeof record.size === "number") asset.size = record.size
  return asset
}

/** The feed as the release workflow writes it; anything else is treated as no feed. */
export function parseFeed(input: unknown): Feed | undefined {
  const record = asRecord(input)
  if (!record) return undefined
  if (typeof record.version !== "string" || !parseReleaseVersion(record.version)) return undefined
  if (typeof record.upstream !== "string" || typeof record.released !== "string") return undefined
  const rawAssets = asRecord(record.assets)
  if (!rawAssets) return undefined
  const assets: Record<string, FeedAsset> = {}
  for (const [target, value] of Object.entries(rawAssets)) {
    const asset = asAsset(value)
    if (!asset) return undefined
    assets[target] = asset
  }
  const feed: Feed = { version: record.version, upstream: record.upstream, released: record.released, assets }
  if (typeof record.notes === "string") feed.notes = record.notes
  return feed
}

function reason(cause: unknown) {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

/** Reads and validates the feed; every failure is a FeedError whose message names the URL. */
export async function fetchFeed(url: string, fetchFn: FetchLike, timeoutMs: number): Promise<Feed> {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) }).catch((cause: unknown) => {
    throw new FeedError(`Could not read ${url}: ${reason(cause)}`, { cause })
  })
  if (response.status === 404) throw new FeedError(`No ${SPARKCODE_NAME} release is published yet (${url})`)
  if (!response.ok) throw new FeedError(`Could not read ${url}: HTTP ${response.status}`)
  const data: unknown = await response.json().catch(() => undefined)
  const feed = parseFeed(data)
  if (!feed) throw new FeedError(`The update feed at ${url} is not valid`)
  return feed
}

/**
 * The screen reader frontend's startup check: the newer version when the feed
 * answers in time with one, otherwise nothing. Never throws, never retries.
 */
export async function checkForUpdate(input: {
  running: string
  fetch?: FetchLike
  url?: string
  timeoutMs?: number
}): Promise<string | undefined> {
  if (!parseReleaseVersion(input.running)) return undefined
  const fetchFn = input.fetch ?? ((url, init) => fetch(url, init))
  const feed = await fetchFeed(input.url ?? SPARKCODE_FEED_URL, fetchFn, input.timeoutMs ?? STARTUP_CHECK_TIMEOUT_MS).catch(
    () => undefined,
  )
  if (!feed) return undefined
  const order = compareVersions(feed.version, input.running)
  return order !== undefined && order > 0 ? feed.version : undefined
}

function failed(running: string, latest: string | undefined, exitCode = 1): UpdateResult {
  return { state: "failed", running, latest, exitCode }
}

type Resolved = { latest: string; feed?: Feed } | { error: string }

/** The version to install: the explicit target, or the feed's latest. */
async function resolveLatest(deps: UpdateDeps, options: UpdateOptions, feedUrl: string, timeoutMs: number): Promise<Resolved> {
  if (options.target !== undefined) {
    if (!parseReleaseVersion(options.target)) return { error: `Invalid version: ${options.target}` }
    return { latest: options.target.trim().replace(/^v/, "") }
  }
  deps.write("Checking for updates.")
  try {
    const feed = await fetchFeed(feedUrl, deps.fetch, timeoutMs)
    return { latest: feed.version, feed }
  } catch (cause) {
    return { error: reason(cause) }
  }
}

/** `sparkcode update`: see the spec's UI states; one line per `write`, exit code in the result. */
export async function runUpdate(deps: UpdateDeps, options: UpdateOptions = {}): Promise<UpdateResult> {
  const { running, write } = deps
  const feedUrl = deps.feedUrl ?? SPARKCODE_FEED_URL
  const installerUrl = deps.installerUrl ?? SPARKCODE_INSTALLER_URL
  const timeoutMs = deps.timeoutMs ?? FEED_TIMEOUT_MS

  if (running === "local") {
    write("This is a development build; update from git instead.")
    return { state: "development", running, exitCode: 0 }
  }
  if (options.method !== undefined) write(`${SPARKCODE_NAME} is installed by its own installer; --method is ignored.`)

  const resolved = await resolveLatest(deps, options, feedUrl, timeoutMs)
  if ("error" in resolved) {
    write(`Error: ${resolved.error}.`)
    return failed(running, undefined)
  }
  const { latest, feed } = resolved

  // The latest release is installed only when it is newer; an explicit target
  // is installed whenever it differs, which is how a bad release is rolled back.
  const order = compareVersions(latest, running)
  const wanted = options.target !== undefined ? order !== 0 : order === undefined || order > 0
  if (!wanted) {
    write(`${SPARKCODE_NAME} ${running} is up to date.`)
    return { state: "up-to-date", running, latest, exitCode: 0 }
  }

  if (deps.platform !== "win32") {
    const target = feedTarget(deps.platform, deps.arch)
    const url = (target && feed?.assets[target]?.url) ?? feed?.notes ?? `${SPARKCODE_REPOSITORY}/releases/tag/v${latest}`
    write(`Automatic update is not available on this platform yet. Download ${url} from the releases page.`)
    return { state: "unsupported", running, latest, exitCode: 1 }
  }

  write(
    order !== undefined && order < 0
      ? `Installing ${SPARKCODE_NAME} ${latest} over ${running}.`
      : `Updating ${SPARKCODE_NAME} ${running} to ${latest}.`,
  )
  let script: string
  try {
    const response = await deps.fetch(installerUrl, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    script = await response.text()
  } catch (cause) {
    write(`Error: Could not download ${installerUrl}: ${reason(cause)}.`)
    return failed(running, latest)
  }
  let code: number
  try {
    const file = await deps.writeTemp("install.ps1", script)
    const shell = (await deps.hasPowerShell("pwsh")) ? "pwsh" : "powershell"
    code = await deps.run(shell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, "-Version", latest])
  } catch (cause) {
    write(`Error: Could not start the installer: ${reason(cause)}.`)
    return failed(running, latest)
  }
  if (code !== 0) {
    write(`Error: The installer exited with code ${code}.`)
    return failed(running, latest, code)
  }
  write(`Restart ${SPARKCODE_NAME} to use ${latest}.`)
  return { state: "updated", running, latest, exitCode: 0 }
}
