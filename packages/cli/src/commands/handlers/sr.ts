import { Service } from "@opencode/client/effect/service"
import { OpenCode } from "@opencode/client/promise"
import { Context, Effect, FileSystem, Option } from "effect"
import { createWriteStream } from "node:fs"
import path from "node:path"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { Config } from "../../config"
import { resolve } from "@opencode/tui/config"
import {
  SETTINGS_FILENAME,
  createScreenReaderLifecycle,
  loadSettings,
  saveSettings,
  visibleStreams,
  type SessionSummary,
} from "@opencode/tui/sr"
import { Global } from "@opencode/util/global"

// `opencode sr`: the mini runtime with the screen reader output layer instead of
// the OpenTUI footer. The runtime, transport and session handling stay upstream.
// Switching sessions restarts the runtime in this process with the chosen session.
export default Runtime.handler(Commands.commands.sr, (input) =>
  Effect.gen(function* () {
    const { runMini } = yield* Effect.promise(() => import("../../mini"))
    const serverURL = Option.getOrUndefined(input.server)
    const server = yield* ServerConnection.resolve({
      server: serverURL,
      standalone: input.standalone,
      mismatch: "replace",
    })
    const config = yield* Config.Service
    const global = yield* Global.Service
    const resolved = resolve(yield* config.get(), { terminalSuspend: process.platform !== "win32" })
    const fileSystem = yield* FileSystem.FileSystem
    const runServicePromise = Effect.runPromiseWith(Context.make(FileSystem.FileSystem, fileSystem))
    const service = server.service
    const settingsFile = path.join(global.config, SETTINGS_FILENAME)
    const settings = yield* Effect.promise(() => loadSettings(settingsFile))
    const transcriptPath = Option.getOrUndefined(input.transcript)
    const transcript = transcriptPath ? createWriteStream(transcriptPath, { flags: "a" }) : undefined
    transcript?.on("error", (error) => {
      process.stderr.write(`error: transcript ${transcriptPath}: ${error.message}\n`)
    })
    let prompt = Option.getOrUndefined(input.prompt)
    const directory = process.cwd()
    const client = OpenCode.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
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
    let session = Option.getOrUndefined(input.session)
    let resume = input.continue
    let fork = input.fork
    let switched = false
    for (;;) {
      let switchTo: string | undefined
      const lifecycle = createScreenReaderLifecycle({
        settings,
        activation: { source: "command" },
        tee: transcript ? (chunk) => void transcript.write(chunk) : undefined,
        terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        exitWhenIdle: prompt !== undefined,
        switched,
        sessions,
        onSwitch: (sessionID) => {
          switchTo = sessionID
        },
        saveSettings: (next) => saveSettings(settingsFile, next),
      })
      yield* Effect.promise(() =>
        runMini({
          server: {
            endpoint: server.endpoint,
            reconnect: service ? (signal) => runServicePromise(service.reconnect(), { signal }) : undefined,
          },
          continue: resume,
          session,
          fork,
          model: Option.getOrUndefined(input.model),
          agent: Option.getOrUndefined(input.agent),
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
  }),
)
