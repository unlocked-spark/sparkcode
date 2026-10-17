import type { SessionMessageAssistantTool } from "@opencode/client/promise"
import type { StreamCommit } from "../../src/mini/types"

export function completedTool(input: {
  id?: string
  name: string
  args?: Record<string, string>
  output: string
}): SessionMessageAssistantTool {
  return {
    type: "tool",
    id: input.id ?? "call_1",
    name: input.name,
    state: {
      status: "completed",
      input: input.args ?? {},
      content: [{ type: "text", text: input.output }],
    },
    time: { created: 1, ran: 1, completed: 2 },
  }
}

export function runningTool(input: {
  id?: string
  name: string
  args?: Record<string, string>
}): SessionMessageAssistantTool {
  return {
    type: "tool",
    id: input.id ?? "call_1",
    name: input.name,
    state: { status: "running", input: input.args ?? {}, metadata: {} },
    time: { created: 1, ran: 1 },
  }
}

export function failedTool(input: {
  id?: string
  name: string
  args?: Record<string, string>
  message: string
}): SessionMessageAssistantTool {
  return {
    type: "tool",
    id: input.id ?? "call_1",
    name: input.name,
    state: {
      status: "error",
      input: input.args ?? {},
      error: { type: "unknown", message: input.message },
    },
    time: { created: 1, ran: 1, completed: 2 },
  }
}

export function textDelta(text: string, messageID = "msg_1", partID = "txt_0"): StreamCommit {
  return { kind: "assistant", source: "assistant", text, phase: "progress", messageID, partID }
}

export function reasoningDelta(text: string, messageID = "msg_1", partID = "rsn_0"): StreamCommit {
  return { kind: "reasoning", source: "reasoning", text, phase: "progress", messageID, partID }
}

export function userCommit(text: string, messageID = "msg_u"): StreamCommit {
  return { kind: "user", source: "system", text, phase: "start", messageID }
}

export function systemCommit(text: string): StreamCommit {
  return { kind: "system", source: "system", text, phase: "start" }
}

export function errorCommit(text: string): StreamCommit {
  return { kind: "error", source: "system", text, phase: "start" }
}

export function toolStart(part: SessionMessageAssistantTool, messageID = "msg_1"): StreamCommit {
  return {
    kind: "tool",
    source: "tool",
    text: `running ${part.name}`,
    phase: "start",
    messageID,
    partID: `prt_${part.id}`,
    tool: part.name,
    part,
    toolState: "running",
  }
}

export function toolDone(part: SessionMessageAssistantTool, messageID = "msg_1"): StreamCommit {
  const first = part.state.status === "completed" ? part.state.content[0] : undefined
  const output = first && first.type === "text" ? first.text : ""
  return {
    kind: "tool",
    source: "tool",
    text: output,
    phase: "final",
    messageID,
    partID: `prt_${part.id}`,
    tool: part.name,
    part,
    toolState: "completed",
  }
}

export function toolFailed(part: SessionMessageAssistantTool, message: string, messageID = "msg_1"): StreamCommit {
  return {
    kind: "tool",
    source: "tool",
    text: message,
    phase: "final",
    messageID,
    partID: `prt_${part.id}`,
    tool: part.name,
    part,
    toolState: "error",
    toolError: message,
  }
}

export function shellCommit(
  id: string,
  command: string,
  next: Pick<StreamCommit, "text" | "phase" | "toolState" | "toolError">,
): StreamCommit {
  return { kind: "tool", source: "tool", partID: `shell:${id}`, tool: "shell", shell: { command }, ...next }
}
