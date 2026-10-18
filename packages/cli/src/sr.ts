import { Service, type Endpoint } from "@opencode/client/effect/service"
import { OpenCode } from "@opencode/client/promise"
import { resolve } from "@opencode/tui/config"
import {
  SETTINGS_FILENAME,
  createScreenReaderLifecycle,
  loadSettings,
  resolveActivation,
  saveSettings,
  visibleStreams,
  type ActivationSource,
  type ScreenReaderSettings,
  type SessionSummary,
} from "@opencode/tui/sr"
import { Global } from "@opencode/util/global"
import { SPARKCODE_COMMAND, SPARKCODE_NAME } from "@opencode/util/sparkcode"
import { Context, Effect, FileSystem, Option } from "effect"
import { createWriteStream } from "node:fs"
import path from "node:path"
import { Config } from "./config"
import { checkForUpdate } from "./sparkcode-update"
import { OPENCODE_LOCAL, OPENCODE_VERSION } from "./version"
import type { ServerConnection } from "./services/server-connection"

export type ScreenReaderSessionInput = {
  server: {
    endpoint: Endpoint
    service?: ServerConnection.Resolved["service"]
  }
  activation: ActivationSource
  continue: boolean
  session?: string
  fork?: boolean
  model?: string
  agent?: string
  prompt?: string
  transcript?: string
  /** `opencode sr --prompt` answers once and exits; the default command stays interactive. */
  oneShot?: boolean
  /** --auto and its aliases: not supported by the mini runtime, so the user is told. */
  auto?: boolean
  /** Settings already loaded by the activation step. */
  settings?: ScreenReaderSettings
  /** Runs before the session starts, for example to tear down the update preflight renderer. */
  before?: () => Promise<unknown>
}

/** The screen reader settings file lives in the opencode config directory. */
export const settingsPath = Effect.fn("cli.sr.settings-path")(function* () {
  const global = yield* Global.Service
  return path.join(global.config, SETTINGS_FILENAME)
})

export const loadScreenReaderSettings = Effect.fn("cli.sr.load-settings")(function* () {
  const file = yield* settingsPath()
  return yield* Effect.promise((): Promise<ScreenReaderSettings> => loadSettings(file))
})

// Runs the mini runtime with the screen reader output layer instead of the
// OpenTUI footer, restarting it in this process when the user switches session.
// Shared by `opencode sr` and by the default command when a reader is detected.
export const runScreenReaderSession = Effect.fn("cli.sr.run")(function* (input: ScreenReaderSessionInput) {
  yield* Effect.promise(() => input.before?.() ?? Promise.resolve())
  const { runMini } = yield* Effect.promise(() => import("./mini"))
  const config = yield* Config.Service
  const global = yield* Global.Service
  const resolved = resolve(yield* config.get(), { terminalSuspend: process.platform !== "win32" })
  const fileSystem = yield* FileSystem.FileSystem
  const runServicePromise = Effect.runPromiseWith(Context.make(FileSystem.FileSystem, fileSystem))
  const settingsFile = yield* settingsPath()
  const settings = input.settings ?? (yield* Effect.promise(() => loadSettings(settingsFile)))
  // One feed read at startup in release builds (AC-043). The lifecycle speaks
  // the result after the session line, so a slow network never delays startup.
  const updateNotice: Promise<string[]> =
    OPENCODE_LOCAL || settings.updates === "off"
      ? Promise.resolve([])
      : checkForUpdate({ running: OPENCODE_VERSION }).then((newer) =>
          newer ? [`${SPARKCODE_NAME} ${newer} is available. Run ${SPARKCODE_COMMAND} update after this session.`] : [],
        )
  const transcript = input.transcript ? createWriteStream(input.transcript, { flags: "a" }) : undefined
  transcript?.on("error", (error) => {
    process.stderr.write(`error: transcript ${input.transcript}: ${error.message}\n`)
  })
  const directory = process.cwd()
  // runMini resolves its directory from PWD first; after a `chdir` for the directory argument the two differ on POSIX.
  process.env.PWD = directory
  const client = OpenCode.make({ baseUrl: input.server.endpoint.url, headers: Service.headers(input.server.endpoint) })
  const sessions = {
    list: async (): Promise<SessionSummary[]> => {
      const result = await client.session.list({ directory, parentID: null, limit: 20, order: "desc" })
      return result.data.map((session) => ({
        id: session.id,
        title: session.title ?? "",
        updated: session.time.updated,
      }))
    },
  }
  const service = input.server.service
  let session = input.session
  let resume = input.continue
  let fork = input.fork ?? false
  let prompt = input.prompt
  let switched = false
  // /tools, /thinking and /heartbeat save new settings; a lifecycle started
  // after a session switch must begin from those, not from the ones loaded at startup.
  let current = settings
  const notices = input.auto
    ? ["Automatic permission approval is not available in screen reader mode; you will be asked."]
    : []
  for (;;) {
    let switchTo: string | undefined
    const lifecycle = createScreenReaderLifecycle({
      settings: current,
      activation: input.activation,
      tee: transcript ? (chunk) => void transcript.write(chunk) : undefined,
      terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      exitWhenIdle: input.oneShot === true && prompt !== undefined,
      switched,
      // Notices belong to the first session of this process, not to every switch.
      notices: switched ? [] : notices,
      lateNotices: switched ? undefined : updateNotice,
      sessions,
      onSwitch: (sessionID) => {
        switchTo = sessionID
      },
      saveSettings: (next) => {
        current = next
        return saveSettings(settingsFile, next)
      },
    })
    yield* Effect.promise(() =>
      runMini({
        server: {
          endpoint: input.server.endpoint,
          reconnect: service ? (signal) => runServicePromise(service.reconnect(), { signal }) : undefined,
        },
        continue: resume,
        session,
        fork,
        model: input.model,
        agent: input.agent,
        prompt,
        replay: resolved.mini?.replay ?? true,
        // A resumed session is spoken, not shown, so only its tail is replayed (AC-044).
        replayLimit: 4,
        tuiConfig: visibleStreams(resolved),
        config: {
          update: (update) => runServicePromise(config.update(update)),
        },
        paths: { home: global.home, state: global.state, log: global.log },
        lifecycle,
      }),
    )
    if (!switchTo) break
    session = switchTo
    resume = false
    fork = false
    prompt = undefined
    switched = true
  }
  yield* Effect.promise(() => new Promise<void>((done) => (transcript ? transcript.end(done) : done())))
})

type DefaultCommandInput = {
  readonly continue: boolean
  readonly session: Option.Option<string>
  readonly prompt: Option.Option<string>
  readonly auto: boolean
  readonly yolo: boolean
  readonly dangerouslySkipPermissions: boolean
}

export type ScreenReaderActivationResult = {
  activation: ActivationSource | undefined
  settings: ScreenReaderSettings
}

// The default command's entry into the screen reader frontend: the flag, the
// environment variable, or a detected reader on Windows (AC-002 to AC-004).
export const ScreenReaderActivation = {
  resolve: Effect.fn("cli.sr.activation")(function* (flag: boolean) {
    const settings = yield* loadScreenReaderSettings()
    const activation = yield* Effect.promise(() =>
      resolveActivation({ flag, env: process.env.OPENCODE_SCREEN_READER, detection: settings.detection }),
    )
    const result: ScreenReaderActivationResult = { activation, settings }
    return result
  }),
  input: (
    input: DefaultCommandInput,
    server: ScreenReaderSessionInput["server"],
    found: ScreenReaderActivationResult & { activation: ActivationSource },
    before?: () => Promise<unknown>,
  ): ScreenReaderSessionInput => ({
    server,
    activation: found.activation,
    settings: found.settings,
    before,
    continue: input.continue,
    session: Option.getOrUndefined(input.session),
    prompt: Option.getOrUndefined(input.prompt),
    auto: input.auto || input.yolo || input.dangerouslySkipPermissions,
    oneShot: false,
  }),
}
