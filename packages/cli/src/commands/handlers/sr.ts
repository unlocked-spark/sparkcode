import { Context, Effect, FileSystem, Option } from "effect"
import { createWriteStream } from "node:fs"
import path from "node:path"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { Config } from "../../config"
import { resolve } from "@opencode/tui/config"
import { SETTINGS_FILENAME, createScreenReaderLifecycle, loadSettings, visibleStreams } from "@opencode/tui/sr"
import { Global } from "@opencode/util/global"

// `opencode sr`: the mini runtime with the screen reader output layer instead of
// the OpenTUI footer. The runtime, transport and session handling stay upstream.
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
    const settings = yield* Effect.promise(() => loadSettings(path.join(global.config, SETTINGS_FILENAME)))
    const transcriptPath = Option.getOrUndefined(input.transcript)
    const transcript = transcriptPath ? createWriteStream(transcriptPath, { flags: "a" }) : undefined
    transcript?.on("error", (error) => {
      process.stderr.write(`error: transcript ${transcriptPath}: ${error.message}\n`)
    })
    const prompt = Option.getOrUndefined(input.prompt)
    const lifecycle = createScreenReaderLifecycle({
      settings,
      activation: { source: "command" },
      tee: transcript ? (chunk) => void transcript.write(chunk) : undefined,
      // Interactive input arrives in a later cycle; with --prompt the session is one turn long.
      exitWhenIdle: prompt !== undefined,
    })
    yield* Effect.promise(() =>
      runMini({
        server: {
          endpoint: server.endpoint,
          reconnect: service ? (signal) => runServicePromise(service.reconnect(), { signal }) : undefined,
        },
        continue: input.continue,
        session: Option.getOrUndefined(input.session),
        fork: input.fork,
        model: Option.getOrUndefined(input.model),
        agent: Option.getOrUndefined(input.agent),
        prompt,
        replay: resolved.mini?.replay ?? true,
        // A resumed session is spoken, not shown, so only its tail is replayed until /sessions lands (AC-044).
        replayLimit: 4,
        tuiConfig: visibleStreams(resolved),
        config: {
          update: (update) => runServicePromise(config.update(update)),
        },
        paths: { home: global.home, state: global.state, log: global.log },
        lifecycle,
      }),
    )
    yield* Effect.promise(() => new Promise<void>((resolve) => (transcript ? transcript.end(resolve) : resolve())))
  }),
)
