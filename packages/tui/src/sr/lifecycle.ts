import { SPARKCODE_INTRO } from "@opencode/util/sparkcode"
import type { Lifecycle, LifecycleInput } from "../mini/runtime.lifecycle"
import type {
  FooterApi,
  FooterEvent,
  FooterQueuedPrompt,
  FooterView,
  RunAgent,
  RunPrompt,
  RunProvider,
  StreamCommit,
} from "../mini/types"
import { helpLines, parseCommand, type Command } from "./commands"
import { askForm } from "./forms"
import { createTerminalInput, type InputSource, type TerminalInput } from "./input"
import { createMenuQueue, type Menu, type MenuItem } from "./menu"
import { createNarrator } from "./narration"
import type { ScreenReaderSettings } from "./settings"
import { createTurnSignals, type Timers } from "./turn"
import { createWriter, type TranscriptLine } from "./writer"

export type ActivationSource = {
  source: "command" | "flag" | "env" | "detection"
  reader?: "NVDA" | "JAWS"
}

export type SessionSummary = {
  id: string
  title: string
  /** Milliseconds since the epoch. */
  updated: number
}

export type ScreenReaderLifecycleOptions = {
  settings: ScreenReaderSettings
  activation: ActivationSource
  /** Defaults to the host's stdout. */
  write?: (chunk: string) => void
  /** Receives every chunk written, for `--transcript` and for tests. */
  tee?: (chunk: string) => void
  eol?: string
  /** Defaults to a line editor on the host's stdin. Tests inject a fake. */
  input?: InputSource | TerminalInput
  /** Whether stdin and stdout are both a terminal; a pipe on either side disables raw mode. */
  terminal?: boolean
  /** One-shot mode: close the footer after the first turn ends. */
  exitWhenIdle?: boolean
  /** This lifecycle continues a session the user switched to; announce the replay, not the activation. */
  switched?: boolean
  /** Spoken once after the activation line, for example an unsupported flag. */
  notices?: string[]
  /**
   * Lines that arrive later, such as the update notice (AC-043): spoken as soon
   * as they are known, so a slow lookup never delays the first spoken words and
   * a user who leaves before the first prompt still hears them.
   */
  lateNotices?: Promise<string[]>
  sessions?: { list(): Promise<SessionSummary[]> }
  /** The user chose another session; the caller restarts the runtime with it. */
  onSwitch?: (sessionID: string) => void
  saveSettings?: (settings: ScreenReaderSettings) => Promise<void>
  timers?: Timers
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type ScreenReaderLifecycleFactory = (input: LifecycleInput) => Promise<Lifecycle>

const CTRL_C_WINDOW_MS = 2000
const MENU_LIMIT = 30

function activationLine(activation: ActivationSource) {
  if (activation.source === "detection" && activation.reader)
    return `${SPARKCODE_INTRO}. Screen reader detected (${activation.reader}). Screen reader mode on via detection. Set OPENCODE_SCREEN_READER=0 to use the visual interface.`
  return `${SPARKCODE_INTRO}. Screen reader mode on via ${activation.source}.`
}

function isTerminalInput(input: InputSource | TerminalInput): input is TerminalInput {
  return "onKey" in input
}

function relativeTime(then: number, now: number) {
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"} ago`
  if (seconds < 60) return "just now"
  if (seconds < 3600) return unit(Math.round(seconds / 60), "minute")
  if (seconds < 86400) return unit(Math.round(seconds / 3600), "hour")
  return unit(Math.round(seconds / 86400), "day")
}

function modelItems(
  providers: RunProvider[],
  current: { providerID: string; modelID: string } | undefined,
  filter: string,
) {
  const needle = filter.toLowerCase()
  const items: MenuItem[] = []
  for (const provider of providers) {
    for (const [modelID, model] of Object.entries(provider.models)) {
      const label = `${provider.name} ${model.name ?? modelID}`
      if (needle && !label.toLowerCase().includes(needle) && !modelID.includes(needle)) continue
      const active = current?.providerID === provider.id && current.modelID === modelID
      items.push({
        index: items.length + 1,
        label: active ? `${label} (current)` : label,
        value: `${provider.id}/${modelID}`,
      })
    }
  }
  return items
}

function agentItems(agents: RunAgent[], current: string | undefined) {
  return agents
    .filter((agent) => agent.mode !== "subagent" && !agent.hidden)
    .map((agent, index) => {
      const label = agent.description ? `${agent.name}: ${agent.description}` : agent.name
      return { index: index + 1, label: agent.id === current ? `${label} (current)` : label, value: agent.id }
    })
}

// The screen reader frontend's Lifecycle: a FooterApi that turns runtime commits
// and events into appended text lines, with no renderer behind it (AC-010), and
// a line editor whose lines become prompts, answers or commands.
export function createScreenReaderLifecycle(options: ScreenReaderLifecycleOptions): ScreenReaderLifecycleFactory {
  return async (input) => {
    let settings = { ...options.settings }
    const now = options.now ?? Date.now
    const terminal: InputSource | TerminalInput =
      options.input ??
      createTerminalInput({
        stdin: input.host.terminal.stdin,
        stdout: input.host.stdout,
        marker: settings.prompt.marker,
        terminal: options.terminal,
      })
    const keys = isTerminalInput(terminal) ? terminal : undefined

    const writer = createWriter({
      write: options.write ?? ((chunk) => input.host.stdout.write(chunk)),
      eol: options.eol,
      tee: options.tee,
      sleep: options.sleep,
      pacing:
        settings.delivery.lineDelayMs > 0 || settings.delivery.msPerChar > 0
          ? { lineDelayMs: settings.delivery.lineDelayMs, msPerChar: settings.delivery.msPerChar }
          : undefined,
      around: keys ? { before: () => keys.beforeWrite(), after: () => keys.afterWrite() } : undefined,
    })
    const narrator = createNarrator({
      tools: settings.tools,
      thinking: settings.thinking === "on",
      directory: input.getDirectory(),
    })

    const promptListeners = new Set<(prompt: RunPrompt) => void>()
    const closeListeners = new Set<() => void>()
    // Prompts echoed as `you:` here; the runtime's own user commit for them is skipped.
    const echoed: string[] = []
    // The runtime's prompt queue subscribes only once the session is resolved; a
    // prompt typed before that would be lost, so it waits for the first subscriber.
    const pendingPrompts: RunPrompt[] = []
    const state = {
      closed: false,
      exited: false,
      eof: false,
      /** A prompt went to the runtime and its turn has not ended yet. */
      awaitingIdle: false,
      lastModel: undefined as string | undefined,
      selection: input.model,
      agent: input.agent,
      session: undefined as string | undefined,
      providers: [] as RunProvider[],
      agents: input.agents,
      usage: undefined as { tokens: number; cost?: number } | undefined,
      queued: [] as FooterQueuedPrompt[],
      lastAnswer: [] as TranscriptLine[],
      collecting: false,
      ctrlC: Number.NEGATIVE_INFINITY,
    }

    const speak = (line: TranscriptLine) => {
      void writer.line(line)
      turn.activity()
    }
    const say = (line: TranscriptLine) => {
      speak(line)
      if (line.label === "assistant") {
        state.collecting = true
        state.lastAnswer.push(line)
      } else if (line.label) state.collecting = false
      else if (state.collecting) state.lastAnswer.push(line)
    }
    const sayAll = (lines: TranscriptLine[]) => {
      for (const line of lines) say(line)
    }
    const menus = createMenuQueue(sayAll)

    // The marker follows everything already queued for the terminal (AC-030).
    const showPrompt = () => {
      void writer.drain().then(() => {
        if (state.closed || turn.running || menus.active) return
        keys?.prompt(true)
      })
    }

    const turn = createTurnSignals({
      emit: (line) => void writer.line(line),
      bell: () => void writer.bell(),
      flush: () => sayAll(narrator.flush()),
      heartbeatSeconds: settings.heartbeat.seconds,
      isTyping: () => terminal.typing?.() ?? false,
      isWaiting: () => menus.active !== undefined,
      timers: options.timers,
    })

    const close = () => {
      if (state.closed) return
      state.closed = true
      turn.dispose()
      menus.close()
      terminal.close?.()
      for (const listener of [...closeListeners]) listener()
    }

    // End of piped input exits once every prompt sent has had its turn (AC-052).
    const maybeExit = () => {
      if (options.exitWhenIdle) return
      if (state.closed || turn.running || menus.active) return
      if (!state.eof || state.awaitingIdle || state.queued.length > 0 || pendingPrompts.length > 0) return
      close()
    }

    const sendPrompt = (text: string) => {
      const prompt: RunPrompt = { text, parts: [] }
      state.awaitingIdle = true
      if (promptListeners.size === 0) return void pendingPrompts.push(prompt)
      for (const listener of [...promptListeners]) listener(prompt)
    }

    const submit = (text: string) => {
      if (turn.running) say({ label: "system", text: `Queued: ${text}` })
      else {
        echoed.push(text)
        say({ label: "you", text })
      }
      sendPrompt(text)
    }

    const interrupt = () => {
      input.onInterrupt?.()
      turn.interrupted()
      showPrompt()
    }

    const openMenu = (menu: Menu) => {
      keys?.prompt(false)
      menus.open(menu)
    }

    const persist = () => void options.saveSettings?.(settings).catch(() => {})

    const status = () => {
      const lines: TranscriptLine[] = [
        { label: "system", text: `Session: ${state.session || input.sessionTitle || input.sessionID || "none"}` },
        { label: "system", text: `Model: ${state.lastModel ?? "not chosen"}` },
        { label: "system", text: `Agent: ${state.agent ?? "default"}` },
      ]
      if (state.usage) lines.push({ label: "system", text: `Tokens: ${state.usage.tokens}` })
      lines.push({ label: "system", text: `State: ${turn.running ? "running" : "idle"}` })
      if (state.queued.length > 0) lines.push({ label: "system", text: `Queued: ${state.queued.length}` })
      sayAll(lines)
    }

    const last = () => {
      if (state.lastAnswer.length === 0) return speak({ label: "system", text: "No answer yet." })
      const [first, ...rest] = state.lastAnswer
      if (first) speak({ label: "assistant", text: first.text })
      for (const line of rest) speak({ text: line.text })
    }

    const chooseModel = (command: Command) => {
      const all = modelItems(state.providers, state.selection, command.args)
      if (all.length === 0) return say({ label: "system", text: "No models match." })
      const items = all.slice(0, MENU_LIMIT)
      const lines: TranscriptLine[] = [{ label: "system", text: "Models:" }]
      if (all.length > items.length)
        lines.push({ text: `Showing ${items.length} of ${all.length}; type /model <text> to narrow.` })
      openMenu({
        kind: "model",
        lines,
        items,
        freeText: false,
        onAnswer: (value, item) => {
          const [providerID, ...rest] = value.split("/")
          const modelID = rest.join("/")
          if (!providerID || !modelID) return
          const chosen = item?.label.replace(/ \(current\)$/, "") ?? value
          // The runtime applies the choice and answers with the label it will
          // use; it emits no model event for it, so the confirmation and the
          // state behind /status are updated here.
          const applied = (result: { modelLabel?: string } | void) => {
            const label = result?.modelLabel ?? chosen
            state.selection = { providerID, modelID }
            if (label === state.lastModel) return
            state.lastModel = label
            say({ label: "system", text: `Model: ${label}.` })
          }
          const failed = () => say({ label: "error", text: `Could not switch to ${chosen}.` })
          try {
            const outcome = input.onModelSelect?.({ providerID, modelID })
            if (outcome instanceof Promise) void outcome.then(applied, failed)
            else applied(outcome)
          } catch {
            failed()
          }
        },
        onCancel: () => say({ label: "system", text: "Cancelled." }),
      })
    }

    const chooseAgent = () => {
      const items = agentItems(state.agents, state.agent)
      if (items.length === 0) return say({ label: "system", text: "No agents available." })
      openMenu({
        kind: "agent",
        lines: [{ label: "system", text: "Agents:" }],
        items,
        freeText: false,
        onAnswer: (value) => {
          // The runtime records the choice silently, so the confirmation is ours.
          state.agent = value
          input.onAgentSelect?.(value)
          const name = state.agents.find((agent) => agent.id === value)?.name ?? value
          say({ label: "system", text: `Agent: ${name}.` })
        },
        onCancel: () => say({ label: "system", text: "Cancelled." }),
      })
    }

    const chooseSession = () => {
      const list = options.sessions
      if (!list) return say({ label: "system", text: "Session switching is not available here." })
      void list
        .list()
        .then((all) => {
          if (state.closed) return
          const current = input.getSessionID?.() ?? input.sessionID
          const sessions = all.filter((session) => session.id !== current).slice(0, 20)
          if (sessions.length === 0) return say({ label: "system", text: "No other sessions." })
          const at = now()
          openMenu({
            kind: "session",
            lines: [{ label: "system", text: "Sessions:" }],
            items: sessions.map((session, index) => ({
              index: index + 1,
              label: `${session.title || session.id} (${relativeTime(session.updated, at)})`,
              value: session.id,
            })),
            freeText: false,
            onAnswer: (value) => {
              const title = sessions.find((session) => session.id === value)?.title || value
              say({ label: "system", text: `Switching to session ${title}.` })
              options.onSwitch?.(value)
              close()
            },
            onCancel: () => say({ label: "system", text: "Cancelled." }),
          })
        })
        .catch((error: unknown) => say({ label: "error", text: `Could not list sessions: ${String(error)}` }))
    }

    const setTools = (command: Command) => {
      if (command.args !== "off" && command.args !== "brief" && command.args !== "full")
        return say({ label: "system", text: "Usage: /tools off|brief|full" })
      settings = { ...settings, tools: command.args }
      narrator.update({ tools: command.args })
      persist()
      say({ label: "system", text: `Tools: ${command.args}.` })
    }

    const setThinking = (command: Command) => {
      if (command.args !== "on" && command.args !== "off")
        return say({ label: "system", text: "Usage: /thinking on|off" })
      settings = { ...settings, thinking: command.args }
      narrator.update({ thinking: command.args === "on" })
      persist()
      say({ label: "system", text: `Thinking: ${command.args}.` })
    }

    const setHeartbeat = (command: Command) => {
      const seconds = Number(command.args)
      if (!/^\d+$/.test(command.args) || seconds > 3600)
        return say({ label: "system", text: "Usage: /heartbeat <seconds>, 0 to turn it off" })
      settings = { ...settings, heartbeat: { seconds } }
      turn.update({ heartbeatSeconds: seconds })
      persist()
      say({ label: "system", text: seconds === 0 ? "Heartbeat: off." : `Heartbeat: ${seconds} seconds.` })
    }

    const undo = () => {
      const latest = state.queued.at(-1)
      if (!latest) return say({ label: "system", text: "Nothing queued." })
      void Promise.resolve(input.onQueuedPromptAction?.("cancel", latest.messageID))
        .then(() => say({ label: "system", text: "Queued prompt removed." }))
        .catch(() => say({ label: "error", text: "Could not remove the queued prompt." }))
    }

    const commands = new Map<string, (command: Command) => void>([
      ["help", () => sayAll(helpLines())],
      ["exit", () => close()],
      ["quit", () => close()],
      ["q", () => close()],
      ["new", (command) => sendPrompt(command.args ? `/new ${command.args}` : "/new")],
      ["compact", () => sendPrompt("/compact")],
      ["status", status],
      ["last", last],
      ["undo", undo],
      ["model", chooseModel],
      ["agent", chooseAgent],
      ["sessions", chooseSession],
      ["tools", setTools],
      ["thinking", setThinking],
      ["heartbeat", setHeartbeat],
    ])

    const handleLine = (raw: string) => {
      if (state.closed) return
      const text = raw.trim()
      const command = parseCommand(text)
      // Leaving must always work, even while a menu waits for an answer.
      if (command && (command.name === "exit" || command.name === "quit" || command.name === "q")) return close()
      if (text === ":q") return close()
      if (menus.answer(text)) return void (menus.active || showPrompt())
      if (!text) return showPrompt()
      if (command) {
        const handler = commands.get(command.name)
        if (handler) handler(command)
        else say({ label: "system", text: `Unknown command /${command.name}. Type /help.` })
        return void (menus.active || showPrompt())
      }
      submit(text)
    }

    const permissionView = (view: Extract<FooterView, { type: "permission" }>) => {
      const request = view.request
      const resources = request.resources.join(" ")
      const reply = (decision: "once" | "always" | "reject") => {
        void input.onPermissionReply({ sessionID: request.sessionID, requestID: request.id, decision })
        say({ label: "system", text: decision === "reject" ? "Rejected." : `Allowed ${decision}.` })
      }
      openMenu({
        kind: "permission",
        group: `permission:${request.id}`,
        lines: [
          {
            label: "permission",
            text: `${resources ? `${request.action} ${resources}` : request.action}. Answer y for once, a for always, n to reject.`,
          },
        ],
        items: [],
        freeText: false,
        singleKeys: { y: "once", a: "always", n: "reject" },
        hint: "Answer y, a or n.",
        instruction: null,
        onAnswer: (value) => {
          if (value === "once" || value === "always" || value === "reject") reply(value)
        },
        onCancel: () => reply("reject"),
      })
    }

    const formView = (view: Extract<FooterView, { type: "form" }>) => {
      const request = view.request
      const group = `form:${request.id}`
      const cancel = () => {
        menus.dismiss((menu) => menu.group === group)
        void input.onFormCancel({ sessionID: request.sessionID, formID: request.id, location: request.location })
        say({ label: "system", text: "Question cancelled." })
      }
      const asked = askForm(request, {
        open: openMenu,
        reply: (reply) => void input.onFormReply(reply),
        cancel,
        say,
        openExternal: (url) => import("@opencode/util/open").then((mod) => mod.openUrl(url)),
      })
      if (!asked) void input.onFormCancel({ sessionID: request.sessionID, formID: request.id, location: request.location })
    }

    const append = (commit: StreamCommit) => {
      if (state.closed) return
      if (commit.kind === "user") {
        const index = echoed.indexOf(commit.text.trim())
        if (index >= 0) {
          echoed.splice(index, 1)
          return
        }
      }
      sayAll(narrator.commit(commit))
    }

    const event = (next: FooterEvent) => {
      if (state.closed) return
      switch (next.type) {
        case "turn.send":
          state.lastAnswer = []
          state.collecting = false
          keys?.prompt(false)
          turn.send()
          return
        case "turn.idle":
          state.awaitingIdle = false
          turn.idle()
          if (options.exitWhenIdle) return close()
          maybeExit()
          showPrompt()
          return
        case "model":
          state.selection = next.selection
          if (next.model !== state.lastModel) {
            state.lastModel = next.model
            say({ label: "system", text: `Model: ${next.model}.` })
          }
          return
        case "agent":
          if (next.agent && next.agent !== state.agent) say({ label: "system", text: `Agent: ${next.agent}.` })
          state.agent = next.agent ?? state.agent
          return
        case "models":
          state.providers = next.providers
          return
        case "catalog":
          state.agents = next.agents
          return
        case "stream.patch":
          if (next.patch.usage) state.usage = next.patch.usage
          return
        case "queued.prompts":
          state.queued = next.prompts
          maybeExit()
          return
        case "stream.view":
          if (next.view.type === "permission") permissionView(next.view)
          else if (next.view.type === "form") formView(next.view)
          else {
            // The server no longer waits for the answer (a timeout, or another
            // client answered): say so, or the user keeps trying to answer.
            const withdrawn = menus.active?.kind
            menus.dismiss((menu) => menu.kind === "permission" || menu.kind === "question")
            if (withdrawn === "permission") say({ label: "system", text: "Permission request withdrawn." })
            else if (withdrawn === "question") say({ label: "system", text: "Question withdrawn." })
          }
          if (!menus.active) showPrompt()
          return
        default:
          return
      }
    }

    const footer: FooterApi = {
      get isClosed() {
        return state.closed
      },
      onPrompt(fn) {
        promptListeners.add(fn)
        for (const prompt of pendingPrompts.splice(0)) fn(prompt)
        return () => void promptListeners.delete(fn)
      },
      onClose(fn) {
        closeListeners.add(fn)
        if (state.closed) fn()
        return () => void closeListeners.delete(fn)
      },
      event,
      append,
      idle: () => writer.drain(),
      close,
      destroy: close,
    }

    terminal.onLine(handleLine)
    keys?.onSingleKey((char) => (settings.prompt.singleKeyAnswers ? menus.key(char) : false))
    keys?.onEnd(() => {
      state.eof = true
      maybeExit()
    })
    keys?.onKey((key) => {
      if (state.closed) return
      if (key === "ctrl-d") return close()
      // With a menu open, Escape and Ctrl+C answer the menu (cancel); nothing else.
      if (menus.active) {
        menus.cancel()
        if (!menus.active) showPrompt()
        return
      }
      if (turn.running) return interrupt()
      if (key === "escape") return
      const at = now()
      if (at - state.ctrlC <= CTRL_C_WINDOW_MS) return close()
      state.ctrlC = at
      say({ label: "system", text: "Press Ctrl+C again to exit." })
    })

    // The runtime builds the lifecycle before the session is resolved, so the
    // title usually arrives later through setTitle; announce it once, whenever it comes.
    const announceSession = (title: string | undefined) => {
      const name = title?.trim()
      if (!name || name === state.session) return
      const first = state.session === undefined
      state.session = name
      say({ label: "system", text: options.switched && first ? `Replaying session ${name}.` : `Session ${name}.` })
    }
    // The session line usually arrives only after the first prompt, so a notice
    // that waited for it was never heard by someone who looked around and left.
    options.lateNotices
      ?.then((lines) => {
        if (state.exited) return
        for (const line of lines) say({ label: "system", text: line })
      })
      .catch(() => {})

    if (!options.switched) say({ label: "system", text: activationLine(options.activation) })
    for (const notice of options.notices ?? []) say({ label: "system", text: notice })
    announceSession(input.sessionTitle || input.sessionID)
    showPrompt()

    return {
      footer,
      onResize: () => () => {},
      refreshTheme: () => {},
      setTitle: announceSession,
      // Called once the resumed history has been replayed: the last paragraph
      // usually ends without a newline and is still buffered, so it is spoken
      // here rather than dropped, which also keeps it available to /last.
      async resetForReplay() {
        sayAll(narrator.flush())
        await writer.drain()
      },
      async close(exit) {
        if (state.exited) return writer.drain()
        state.exited = true
        sayAll(narrator.flush())
        turn.dispose()
        keys?.prompt(false)
        const title = (exit.sessionTitle || state.session || exit.sessionID || input.sessionID || "").trim()
        void writer.line({ label: "system", text: title ? `Session ${title} saved. Goodbye.` : "Goodbye." })
        close()
        await writer.drain()
      },
    }
  }
}
