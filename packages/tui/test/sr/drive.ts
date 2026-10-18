import type { Lifecycle, LifecycleInput } from "../../src/mini/runtime.lifecycle"
import type {
  FooterApi,
  FormCancel,
  FormReply,
  MiniHost,
  PermissionReply,
  QueuedPromptAction,
  RunAgent,
  RunInput,
  RunTuiConfig,
} from "../../src/mini/types"
import type { Key, TerminalInput } from "../../src/sr/input"
import {
  createScreenReaderLifecycle,
  type ActivationSource,
  type ScreenReaderLifecycleOptions,
  type SessionSummary,
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
  now?: () => number
  agents?: RunAgent[]
  sessions?: SessionSummary[]
  /** Push the prompt marker into `writes` so ordering can be asserted. */
  recordMarker?: boolean
  switched?: boolean
}

export type Drive = {
  lifecycle: Lifecycle
  footer: FooterApi
  /** Every chunk written to the fake terminal, in order. */
  writes: string[]
  /** The writes without their end of line, for readable assertions. */
  lines(): string[]
  /** Type a line as the user would and press Enter. */
  submit(text: string): void
  /** Press a special key. */
  key(key: Key): void
  /** Type one character on an empty line (single-key answers). */
  char(char: string): boolean
  /** Signal end of input (pipe closed). */
  eof(): void
  /** Whether the prompt marker is currently shown. */
  prompting(): boolean
  permissions: PermissionReply[]
  forms: FormReply[]
  cancels: FormCancel[]
  interrupts: number
  modelSelections: NonNullable<RunInput["model"]>[]
  agentSelections: string[]
  queuedActions: { action: QueuedPromptAction; inboxID: string }[]
  switches: string[]
  saved: ScreenReaderSettings[]
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

function fakeInput(record: (chunk: string) => void) {
  const lineListeners = new Set<(text: string) => void>()
  const keyListeners = new Set<(key: Key) => void>()
  const singleKeyListeners = new Set<(char: string) => boolean>()
  const eofListeners = new Set<() => void>()
  let shown = false
  const input: TerminalInput = {
    onLine(listener) {
      lineListeners.add(listener)
      return () => void lineListeners.delete(listener)
    },
    onKey(listener) {
      keyListeners.add(listener)
      return () => void keyListeners.delete(listener)
    },
    onSingleKey(listener) {
      singleKeyListeners.add(listener)
      return () => void singleKeyListeners.delete(listener)
    },
    onEnd(listener) {
      eofListeners.add(listener)
      return () => void eofListeners.delete(listener)
    },
    prompt(show) {
      shown = show
      if (show) record("> ")
    },
    typing: () => false,
    beforeWrite() {},
    afterWrite() {},
    close() {},
  }
  return {
    input,
    submit: (text: string) => void [...lineListeners].forEach((fn) => fn(text)),
    key: (key: Key) => void [...keyListeners].forEach((fn) => fn(key)),
    char: (char: string) => [...singleKeyListeners].some((fn) => fn(char)),
    eof: () => void [...eofListeners].forEach((fn) => fn()),
    prompting: () => shown,
  }
}

// Builds a LifecycleInput the way the mini runtime would and returns the
// footer so tests can feed StreamCommits and FooterEvents directly (TC-009).
export async function drive(options: DriveOptions): Promise<Drive> {
  const writes: string[] = []
  const permissions: PermissionReply[] = []
  const forms: FormReply[] = []
  const cancels: FormCancel[] = []
  const modelSelections: NonNullable<RunInput["model"]>[] = []
  const agentSelections: string[] = []
  const queuedActions: { action: QueuedPromptAction; inboxID: string }[] = []
  const switches: string[] = []
  const saved: ScreenReaderSettings[] = []
  const counters = { interrupts: 0 }
  const fake = fakeInput((chunk) => void (options.recordMarker && writes.push(chunk)))
  const factory = createScreenReaderLifecycle({
    settings: { ...defaultSettings(), ...options.settings },
    activation: options.activation,
    write: (chunk) => void writes.push(chunk),
    eol: "\n",
    exitWhenIdle: options.exitWhenIdle,
    switched: options.switched,
    timers: options.timers,
    now: options.now,
    input: fake.input,
    sessions: { list: async () => options.sessions ?? [] },
    onSwitch: (sessionID) => void switches.push(sessionID),
    saveSettings: async (settings) => void saved.push(settings),
  })
  const input: LifecycleInput = {
    host: fakeHost((chunk) => void writes.push(chunk)),
    getDirectory: () => "/repo",
    findFiles: async () => [],
    agents: options.agents ?? [],
    references: [],
    sessionID: options.sessionID ?? "ses_test",
    getSessionID: () => options.sessionID ?? "ses_test",
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
    onInterrupt: () => void counters.interrupts++,
    onModelSelect: (model) => void modelSelections.push(model),
    onAgentSelect: (agent) => void agentSelections.push(agent),
    onQueuedPromptAction: async (action, inboxID) => void queuedActions.push({ action, inboxID }),
  }
  const lifecycle = await factory(input)
  await lifecycle.footer.idle()
  return {
    lifecycle,
    footer: lifecycle.footer,
    writes,
    lines: () => writes.map((chunk) => (chunk === BELL ? BELL : chunk.replace(/\n$/, ""))),
    submit: fake.submit,
    key: fake.key,
    char: fake.char,
    eof: fake.eof,
    prompting: fake.prompting,
    permissions,
    forms,
    cancels,
    get interrupts() {
      return counters.interrupts
    },
    modelSelections,
    agentSelections,
    queuedActions,
    switches,
    saved,
  }
}
