import { Effect, Option } from "effect"
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { OPENCODE_VERSION } from "../../version"
import { runUpdate } from "../../sparkcode-update"

/** Exit code of a command; rejects when it cannot be started at all. */
function exitCodeOf(command: string, args: string[], stdio: "inherit" | "ignore") {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { stdio, windowsHide: true })
    child.on("error", (cause) => reject(new Error(`${command} could not be started (${cause.message})`, { cause })))
    child.on("exit", (code) => resolve(code ?? 1))
  })
}

// `sparkcode update`: SparkCode's own updater in place of upstream's package
// manager detection. The logic lives in sparkcode-update.ts; this file only
// supplies the real network, file system and terminal.
export default Runtime.handler(Commands.commands.upgrade, (input) =>
  Effect.promise(async () => {
    let directory: string | undefined
    try {
      const result = await runUpdate(
        {
          running: OPENCODE_VERSION,
          platform: process.platform,
          arch: process.arch,
          fetch: (url, init) => fetch(url, init),
          write: (line) => void process.stdout.write(`${line}\n`),
          writeTemp: async (name, content) => {
            directory = await mkdtemp(path.join(tmpdir(), "sparkcode-update-"))
            const file = path.join(directory, name)
            await writeFile(file, content, "utf8")
            return file
          },
          run: (command, args) => exitCodeOf(command, args, "inherit"),
          hasPowerShell: (command) =>
            exitCodeOf(command, ["-NoProfile", "-Command", "exit 0"], "ignore").then(
              (code) => code === 0,
              () => false,
            ),
        },
        { target: Option.getOrUndefined(input.target), method: Option.getOrUndefined(input.method) },
      )
      process.exitCode = result.exitCode
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {})
    }
  }),
)
