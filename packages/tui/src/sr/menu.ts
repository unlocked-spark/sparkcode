import type { TranscriptLine } from "./writer"

export type MenuKind = "permission" | "question" | "model" | "agent" | "session"

export type MenuItem = {
  index: number
  label: string
  value: string
}

export type Menu = {
  kind: MenuKind
  /** Header lines written before the items. */
  lines: TranscriptLine[]
  items: MenuItem[]
  /** Accept text that is not a number. */
  freeText: boolean
  /** Characters that answer without Enter, mapped to the value they mean. */
  singleKeys?: Record<string, string>
  /** What to say when the input matched nothing. */
  hint?: string
  /** The closing instruction line; `null` writes none. */
  instruction?: string | null
  /** Menus of one request share a group so a cancel dismisses the rest. */
  group?: string
  /** Return "keep" to stay open, for example after an invalid value. */
  onAnswer(value: string, item?: MenuItem): void | "keep"
  onCancel(): void
}

export type MenuQueue = {
  readonly active: Menu | undefined
  open(menu: Menu): void
  /** A typed line; true when a menu consumed it. */
  answer(text: string): boolean
  /** A single key on an empty line; true when a menu consumed it. */
  key(char: string): boolean
  /** Escape; true when a menu was open. */
  cancel(): boolean
  /** Drop menus without calling back, for requests the runtime resolved elsewhere. */
  dismiss(predicate: (menu: Menu) => boolean): void
  close(): void
}

function instructionFor(menu: Menu) {
  if (menu.instruction !== undefined) return menu.instruction
  if (menu.items.length === 0) return null
  return menu.freeText ? "Type the number, or your own answer." : "Type the number."
}

// One menu at a time, in arrival order (AC-045). A menu is a block of lines
// followed by the user's answer; nothing else is spoken while it waits.
export function createMenuQueue(emit: (lines: TranscriptLine[]) => void): MenuQueue {
  let active: Menu | undefined
  const pending: Menu[] = []

  const show = (menu: Menu) => {
    active = menu
    const lines = [...menu.lines, ...menu.items.map((item) => ({ text: `${item.index}. ${item.label}` }))]
    const instruction = instructionFor(menu)
    if (instruction) lines.push({ text: instruction })
    emit(lines)
  }

  const next = () => {
    active = undefined
    const following = pending.shift()
    if (following) show(following)
  }

  const resolve = (menu: Menu, value: string, item?: MenuItem) => {
    if (menu.onAnswer(value, item) === "keep") return
    if (active === menu) next()
  }

  return {
    get active() {
      return active
    },
    open(menu) {
      if (active) pending.push(menu)
      else show(menu)
    },
    answer(text) {
      const menu = active
      if (!menu) return false
      const trimmed = text.trim()
      const single = menu.singleKeys?.[trimmed.toLowerCase()]
      if (single !== undefined) {
        resolve(menu, single)
        return true
      }
      if (menu.items.length > 0 && /^\d+$/.test(trimmed)) {
        const item = menu.items.find((entry) => entry.index === Number(trimmed))
        if (item) {
          resolve(menu, item.value, item)
          return true
        }
        if (!menu.freeText) {
          emit([{ label: "system", text: menu.hint ?? `Type a number from 1 to ${menu.items.length}.` }])
          return true
        }
      }
      if (menu.freeText && trimmed) {
        resolve(menu, trimmed)
        return true
      }
      emit([{ label: "system", text: menu.hint ?? `Type a number from 1 to ${menu.items.length}.` }])
      return true
    },
    key(char) {
      const menu = active
      const value = menu?.singleKeys?.[char.toLowerCase()]
      if (!menu || value === undefined) return false
      resolve(menu, value)
      return true
    },
    cancel() {
      const menu = active
      if (!menu) return false
      menu.onCancel()
      if (active === menu) next()
      return true
    },
    dismiss(predicate) {
      for (let index = pending.length - 1; index >= 0; index--) {
        const menu = pending[index]
        if (menu && predicate(menu)) pending.splice(index, 1)
      }
      if (active && predicate(active)) next()
    },
    close() {
      active = undefined
      pending.length = 0
    },
  }
}
