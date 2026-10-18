import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { runScreenReaderSession } from "../../sr"

// `opencode sr`: the screen reader frontend, chosen explicitly.
export default Runtime.handler(Commands.commands.sr, (input) =>
  Effect.gen(function* () {
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
      mismatch: "replace",
    })
    yield* runScreenReaderSession({
      server: { endpoint: server.endpoint, service: server.service },
      activation: { source: "command" },
      continue: input.continue,
      session: Option.getOrUndefined(input.session),
      fork: input.fork,
      model: Option.getOrUndefined(input.model),
      agent: Option.getOrUndefined(input.agent),
      prompt: Option.getOrUndefined(input.prompt),
      transcript: Option.getOrUndefined(input.transcript),
      oneShot: true,
    })
  }),
)
