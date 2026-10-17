import type { Lifecycle, LifecycleInput } from "../../src/mini/runtime.lifecycle"
import type { FooterApi, FormCancel, FormReply, MiniHost, PermissionReply, RunTuiConfig } from "../../src/mini/types"
import {
  createScreenReaderLifecycle,
  type ActivationSource,
  type ScreenReaderLifecycleOptions,
} from "../../src/sr/lifecycle"
import { defaultSettings, type ScreenReaderSettings } from "../../src/sr/settings"

export type DriveOptions = {
  activation: ActivationSource
  sessionTitle?: string
  /** Defaults to a fake id; pass "" to mimic the runtime before the session is resolved. */
  sessionID?: string
  settings?: Partial<ScreenReaderSettings>
  exitWhenIdle?: boolean
  timers?: ScreenReaderLifecycleOptions["timers"]
}

export type Drive = {
  lifecycle: Lifecycle
  footer: FooterApi
  /** Every chunk written to the fake terminal, in order. */
  writes: string[]
  /** The writes without their end of line, for readable assertions. */
  lines(): string[]
  /** Type a prompt as the user would. */
  submit(text: string): void
  permissions: PermissionReply[]
  forms: FormReply[]
  cancels: FormCancel[]
}

const BELL = "\x07"

function fakeHost(write: (chunk: string) => void): MiniHost {
  return {
    version: "test",
    terminal: { stdin: process.stdin },
    platform: process.platform,
    stdout: { write },
    files: { readText: async () => "" },
    editor: { open: async () => undefined },
    paths: { home: "/" },
    signals: {
      sigint: { subscribe: () => () => {} },
      sigusr2: { subscribe: () => () => {} },
    },
    startup: { showTiming: false, now: () => 0 },
    diagnostics: {},
    preferences: {
      resolveVariant: async () => undefined,
      saveVariant: async () => {},
    },
  }
}

// Builds a LifecycleInput the way the mini runtime would and returns the
// footer so tests can feed StreamCommits and FooterEvents directly (TC-009).
export async function drive(options: DriveOptions): Promise<Drive> {
  const writes: string[] = []
  const permissions: PermissionReply[] = []
  const forms: FormReply[] = []
  const cancels: FormCancel[] = []
  const lineListeners = new Set<(text: string) => void>()
  const factory = createScreenReaderLifecycle({
    settings: { ...defaultSettings(), ...options.settings },
    activation: options.activation,
    write: (chunk) => void writes.push(chunk),
    eol: "\n",
    exitWhenIdle: options.exitWhenIdle,
    timers: options.timers,
    input: {
      onLine(listener) {
        lineListeners.add(listener)
        return () => void lineListeners.delete(listener)
      },
    },
  })
  const input: LifecycleInput = {
    host: fakeHost((chunk) => void writes.push(chunk)),
    getDirectory: () => "/repo",
    findFiles: async () => [],
    agents: [],
    references: [],
    sessionID: options.sessionID ?? "ses_test",
    sessionTitle: options.sessionTitle,
    first: true,
    history: [],
    agent: undefined,
    model: undefined,
    variant: undefined,
    tuiConfig: new Promise<RunTuiConfig>(() => {}),
    onPermissionReply: (reply) => void permissions.push(reply),
    onFormReply: (reply) => void forms.push(reply),
    onFormCancel: (cancel) => void cancels.push(cancel),
  }
  const lifecycle = await factory(input)
  await lifecycle.footer.idle()
  return {
    lifecycle,
    footer: lifecycle.footer,
    writes,
    lines: () => writes.map((chunk) => (chunk === BELL ? BELL : chunk.replace(/\n$/, ""))),
    submit(text) {
      for (const listener of [...lineListeners]) listener(text)
    },
    permissions,
    forms,
    cancels,
  }
}
