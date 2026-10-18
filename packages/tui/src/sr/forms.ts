import type { FormField, FormValue, FormWhen } from "@opencode/client"
import type { FormReply, MiniFormRequest } from "../mini/types"
import { formLabel, formValidateValue, isFormAnswerField, type FormAnswerField } from "../util/form"
import type { Menu, MenuItem } from "./menu"
import type { TranscriptLine } from "./writer"

export type FormHandlers = {
  /** Shows the next question; the form opens one at a time. */
  open(menu: Menu): void
  reply(reply: FormReply): void
  cancel(): void
  /** Spoken feedback: an accepted value or why one was refused. */
  say?(line: TranscriptLine): void
  /** Opens an external field's URL in the browser; rejects when it cannot. */
  openExternal?(url: string): Promise<unknown>
}

type Field = FormAnswerField
type ExternalField = Extract<FormField, { type: "external" }>

const OPEN = "open"
const DONE = "done"

function options(field: Field): MenuItem[] {
  if (field.type === "boolean")
    return [
      { index: 1, label: "Yes", value: "true" },
      { index: 2, label: "No", value: "false" },
    ]
  if ((field.type === "string" || field.type === "multiselect") && field.options)
    return field.options.map((option, index) => ({ index: index + 1, label: option.label, value: option.value }))
  return []
}

function parseSelection(text: string, items: MenuItem[]): string[] | undefined {
  const parts = text.split(/[\s,;]+/).filter(Boolean)
  if (parts.length === 0 || !parts.every((part) => /^\d+$/.test(part))) return undefined
  const values = parts.map((part) => items.find((item) => item.index === Number(part))?.value)
  return values.every((value): value is string => value !== undefined) ? values : undefined
}

function parseValue(field: Field, text: string, item: MenuItem | undefined, items: MenuItem[]): FormValue | undefined {
  switch (field.type) {
    case "boolean":
      if (item) return item.value === "true"
      if (/^(y|yes|true)$/i.test(text)) return true
      if (/^(n|no|false)$/i.test(text)) return false
      return undefined
    case "number":
    case "integer": {
      const value = Number(text)
      return Number.isFinite(value) ? value : undefined
    }
    case "multiselect":
      // A single number arrives resolved by the menu; a list is typed.
      return item ? [item.value] : parseSelection(text, items)
    default:
      return item ? item.value : text
  }
}

function describe(field: Field, value: FormValue, item: MenuItem | undefined, items: MenuItem[]) {
  if (item && !Array.isArray(value)) return item.label
  if (Array.isArray(value))
    return value.map((entry) => items.find((candidate) => candidate.value === entry)?.label ?? entry).join(", ")
  if (typeof value === "boolean") return value ? "Yes" : "No"
  return String(value)
}

function expectation(field: Field) {
  if (field.type === "number" || field.type === "integer") return "enter a number"
  if (field.type === "boolean") return "answer yes or no"
  if (field.type === "multiselect") return "type the numbers separated by commas"
  return "enter a value"
}

function matches(when: FormWhen, value: FormValue | undefined) {
  const hit = Array.isArray(value) ? value.some((item) => item === when.value) : value === when.value
  return when.op === "eq" ? hit : !hit
}

// The server's own rule: a field with `when` conditions is asked only while
// every condition holds for the answers given so far, and an answer to an
// inactive field is rejected.
function isActive(field: Field, answers: Record<string, FormValue>) {
  return (field.when ?? []).every((when) => matches(when, answers[when.key]))
}

/**
 * Asks a form one field at a time (AC-041): each answer decides which field
 * comes next, so `when` conditions are honoured, and the reply is sent after
 * the last one. External fields are spoken as an address to open and must be
 * acknowledged. Returns false when the form has nothing to ask.
 */
export function askForm(request: MiniFormRequest, handlers: FormHandlers): boolean {
  const fields = request.fields.filter((field) => field.type === "external" || !field.hidden)
  if (fields.length === 0) return false
  const answers: Record<string, FormValue> = {}
  const group = `form:${request.id}`
  const title = request.title.trim()
  const single = fields.length === 1

  // The title stands in for the label of a lone field; an address is always read out.
  const header = (first: boolean, label: string, always = false) => {
    const lines: TranscriptLine[] = []
    if (first && title) lines.push({ label: "question", text: title })
    if (always || !single || !title) lines.push({ label: "question", text: label })
    return lines
  }

  const reply = () =>
    handlers.reply({ sessionID: request.sessionID, formID: request.id, answer: answers, location: request.location })

  const external = (field: ExternalField, first: boolean, next: () => void): Menu => ({
    kind: "question",
    group,
    lines: header(first, field.title ? `${field.title}: ${field.url}` : field.url, true),
    items: [
      { index: 1, label: "Open it in your browser", value: OPEN },
      { index: 2, label: "Done, continue", value: DONE },
    ],
    freeText: false,
    hint: "Type 1 to open the address, 2 when you are done.",
    onAnswer(value) {
      if (value === OPEN) {
        const opener = handlers.openExternal ?? (() => Promise.reject(new Error("no browser")))
        opener(field.url).then(
          () => handlers.say?.({ label: "system", text: "Opened in your browser. Type 2 when you are done." }),
          () => handlers.say?.({ label: "system", text: `Could not open the browser. Open this address yourself: ${field.url}` }),
        )
        return "keep"
      }
      answers[field.key] = true
      next()
    },
    onCancel: handlers.cancel,
  })

  const input = (field: Field, first: boolean, next: () => void): Menu => {
    const items = options(field)
    const label = formLabel(field)
    return {
      kind: "question",
      group,
      lines: header(first, label),
      items,
      // A string field with options accepts free text only when the form allows a custom value;
      // booleans take yes/no words; numbers and multiselects are typed.
      freeText: field.type === "string" ? !field.options || field.custom === true : true,
      onAnswer(text, item) {
        const value = parseValue(field, text, item, items)
        const invalid = value === undefined ? expectation(field) : formValidateValue(field, value)
        if (invalid || value === undefined) {
          handlers.say?.({ label: "system", text: `${label}: ${invalid ?? expectation(field)}.` })
          return "keep"
        }
        answers[field.key] = value
        handlers.say?.({ label: "system", text: `Answered: ${describe(field, value, item, items)}.` })
        next()
      },
      onCancel: handlers.cancel,
    }
  }

  let opened = 0
  const ask = (from: number) => {
    for (let index = from; index < fields.length; index++) {
      const field = fields[index]
      if (field.type !== "external" && !isActive(field, answers)) continue
      const next = () => ask(index + 1)
      handlers.open(
        isFormAnswerField(field) ? input(field, opened === 0, next) : external(field as ExternalField, opened === 0, next),
      )
      opened++
      return
    }
    reply()
  }
  ask(0)
  return opened > 0
}
