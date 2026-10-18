import type { FormValue } from "@opencode/client"
import type { FormReply, MiniFormRequest } from "../mini/types"
import { formLabel, formValidateValue, isFormAnswerField, type FormAnswerField } from "../util/form"
import type { Menu, MenuItem } from "./menu"
import type { TranscriptLine } from "./writer"

export type FormHandlers = {
  reply(reply: FormReply): void
  cancel(): void
  /** Spoken feedback: an accepted value or why one was refused. */
  say?(line: TranscriptLine): void
}

type Field = FormAnswerField

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
      return parseSelection(text, items)
    default:
      return item ? item.value : text
  }
}

function describe(field: Field, value: FormValue, item: MenuItem | undefined, items: MenuItem[]) {
  if (item) return item.label
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

// A form becomes one numbered menu per answerable field, asked in order (AC-041).
// Answers are collected and sent once the last field is answered.
export function formMenus(request: MiniFormRequest, handlers: FormHandlers): Menu[] {
  const fields = request.fields.filter((field): field is Field => isFormAnswerField(field) && !field.hidden)
  const answers: Record<string, FormValue> = {}
  const group = `form:${request.id}`
  const title = request.title.trim()
  const single = fields.length === 1

  return fields.map((field, position) => {
    const items = options(field)
    const label = formLabel(field)
    const lines: TranscriptLine[] = []
    if (position === 0 && title) lines.push({ label: "question", text: title })
    if (!single || !title) lines.push({ label: "question", text: label })
    return {
      kind: "question",
      group,
      lines,
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
        if (position === fields.length - 1)
          handlers.reply({
            sessionID: request.sessionID,
            formID: request.id,
            answer: answers,
            location: request.location,
          })
      },
      onCancel: handlers.cancel,
    }
  })
}
