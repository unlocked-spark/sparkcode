import { expect, test } from "bun:test"
import { askForm, type FormHandlers } from "../../src/sr/forms"
import type { Menu } from "../../src/sr/menu"
import type { MiniFormRequest } from "../../src/mini/types"

function request(fields: MiniFormRequest["fields"]): MiniFormRequest {
  return {
    id: "form_1",
    sessionID: "ses_test",
    title: "Setup",
    fields,
  }
}

// Drives a form the way the lifecycle does: one menu open at a time, each
// answer handed to the menu that is currently showing.
function ask(fields: MiniFormRequest["fields"], extra: Partial<FormHandlers> = {}) {
  const menus: Menu[] = []
  const replies: { answer: Record<string, unknown> }[] = []
  const said: string[] = []
  let cancels = 0
  const asked = askForm(request(fields), {
    open: (menu) => void menus.push(menu),
    reply: (reply) => void replies.push(reply as never),
    cancel: () => void cancels++,
    say: (line) => void said.push(line.text),
    ...extra,
  })
  const current = () => menus[menus.length - 1]
  const answer = (text: string) => {
    const menu = current()
    if (!menu) throw new Error(`no menu open for answer ${text}`)
    const item = /^\d+$/.test(text) ? menu.items.find((entry) => String(entry.index) === text) : undefined
    return menu.onAnswer(item ? item.value : text, item)
  }
  return { asked, menus, replies, said, answer, current, cancels: () => cancels }
}

test("AC-041 string options become numbered items and the reply uses the option value", () => {
  const f = ask([{ type: "string", key: "colour", title: "Colour", options: [{ value: "r", label: "Red" }] }])
  expect(f.asked).toBe(true)
  expect(f.menus).toHaveLength(1)
  expect(f.current()?.lines.map((line) => line.text)).toEqual(["Setup"])
  expect(f.current()?.items.map((item) => item.label)).toEqual(["Red"])
  f.answer("1")
  expect(f.replies).toEqual([{ sessionID: "ses_test", formID: "form_1", answer: { colour: "r" }, location: undefined } as never])
})

test("AC-041 numbers are parsed and validated, booleans use Yes and No, multiselect takes comma separated numbers", () => {
  const f = ask([
    { type: "number", key: "ratio", title: "Ratio", minimum: 0, maximum: 1 },
    { type: "boolean", key: "ok", title: "Proceed?" },
    {
      type: "multiselect",
      key: "tags",
      title: "Tags",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
        { value: "c", label: "C" },
      ],
    },
  ])
  expect(f.menus).toHaveLength(1)
  expect(f.answer("two")).toBe("keep")
  expect(f.answer("5")).toBe("keep")
  f.answer("0.5")
  f.answer("2")
  expect(f.menus.map((menu) => menu.items.map((item) => item.label))).toEqual([[], ["Yes", "No"], ["A", "B", "C"]])
  f.answer("1, 3")
  expect(f.replies).toEqual([
    { sessionID: "ses_test", formID: "form_1", answer: { ratio: 0.5, ok: false, tags: ["a", "c"] } } as never,
  ])
  expect(f.said.at(-1)).toBe("Answered: A, C.")
})

test("AC-041 a multiselect accepts a single number as well", () => {
  const f = ask([
    {
      type: "multiselect",
      key: "tags",
      title: "Tags",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    },
  ])
  expect(f.answer("2")).toBeUndefined()
  expect(f.replies[0]?.answer).toEqual({ tags: ["b"] })
  expect(f.said.at(-1)).toBe("Answered: B.")
})

test("AC-041 hidden fields are skipped and a title-less field falls back to its key", () => {
  const f = ask([
    { type: "string", key: "secret", hidden: true },
    { type: "string", key: "name" },
  ])
  expect(f.menus).toHaveLength(1)
  expect(f.current()?.lines.map((line) => line.text)).toEqual(["Setup"])
  f.answer("Ada")
  expect(f.replies[0]?.answer).toEqual({ name: "Ada" })
})

test("AC-041 an external field is read as an address, can be opened, and must be acknowledged", async () => {
  const opened: string[] = []
  const f = ask(
    [
      { type: "external", key: "auth", title: "Sign in", url: "https://example.com/auth" },
      { type: "string", key: "code", title: "Code" },
    ],
    { openExternal: async (url) => void opened.push(url) },
  )
  expect(f.current()?.lines.map((line) => line.text)).toEqual(["Setup", "Sign in: https://example.com/auth"])
  expect(f.current()?.items.map((item) => item.label)).toEqual(["Open it in your browser", "Done, continue"])
  expect(f.answer("1")).toBe("keep")
  await Promise.resolve()
  expect(opened).toEqual(["https://example.com/auth"])
  expect(f.said.at(-1)).toBe("Opened in your browser. Type 2 when you are done.")
  f.answer("2")
  expect(f.menus).toHaveLength(2)
  f.answer("1234")
  expect(f.replies[0]?.answer).toEqual({ auth: true, code: "1234" })
})

test("AC-041 a form with only an external field is asked, not cancelled, and a failed opener names the address", async () => {
  const f = ask([{ type: "external", key: "auth", url: "https://example.com/auth" }], {
    openExternal: () => Promise.reject(new Error("no browser")),
  })
  expect(f.asked).toBe(true)
  expect(f.current()?.lines.map((line) => line.text)).toEqual(["Setup", "https://example.com/auth"])
  f.answer("1")
  await Promise.resolve()
  await Promise.resolve()
  expect(f.said.at(-1)).toBe("Could not open the browser. Open this address yourself: https://example.com/auth")
  f.answer("2")
  expect(f.replies[0]?.answer).toEqual({ auth: true })
  expect(f.cancels()).toBe(0)
})

test("AC-041 fields with when conditions are asked only while the conditions hold", () => {
  const fields: MiniFormRequest["fields"] = [
    { type: "boolean", key: "ok", title: "Proceed?" },
    { type: "string", key: "reason", title: "Reason", when: [{ key: "ok", op: "eq", value: false }] },
    { type: "string", key: "note", title: "Note" },
  ]
  const yes = ask(fields)
  yes.answer("1")
  expect(yes.current()?.lines.map((line) => line.text)).toEqual(["Note"])
  yes.answer("fine")
  expect(yes.replies[0]?.answer).toEqual({ ok: true, note: "fine" })

  const no = ask(fields)
  no.answer("2")
  expect(no.current()?.lines.map((line) => line.text)).toEqual(["Reason"])
  no.answer("busy")
  no.answer("later")
  expect(no.replies[0]?.answer).toEqual({ ok: false, reason: "busy", note: "later" })
})

test("AC-041 a string field with options refuses free text unless custom is allowed", () => {
  const strict = ask([{ type: "string", key: "c", title: "C", options: [{ value: "a", label: "A" }] }])
  expect(strict.current()?.freeText).toBe(false)
  const custom = ask([{ type: "string", key: "c", title: "C", custom: true, options: [{ value: "a", label: "A" }] }])
  expect(custom.current()?.freeText).toBe(true)
  const bool = ask([{ type: "boolean", key: "ok", title: "Ok?" }])
  expect(bool.answer("yes")).toBeUndefined()
  expect(bool.replies[0]?.answer).toEqual({ ok: true })
})

test("AC-041 a form with nothing to ask reports false", () => {
  const f = ask([{ type: "string", key: "secret", hidden: true }])
  expect(f.asked).toBe(false)
  expect(f.replies).toEqual([])
})
