import { expect, test } from "bun:test"
import { formMenus } from "../../src/sr/forms"
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

function run(menus: Menu[], answers: string[]) {
  let index = 0
  for (const answer of answers) {
    const menu = menus[index]
    if (!menu) throw new Error(`no menu for answer ${answer}`)
    const item = menu.items.find((entry) => String(entry.index) === answer)
    const result = menu.onAnswer(item ? item.value : answer, item)
    if (result !== "keep") index++
  }
}

test("AC-041 string options become numbered items and the reply uses the option value", () => {
  const replies: unknown[] = []
  const menus = formMenus(
    request([{ type: "string", key: "colour", title: "Colour", options: [{ value: "r", label: "Red" }] }]),
    {
      reply: (reply) => void replies.push(reply),
      cancel: () => {},
    },
  )
  expect(menus).toHaveLength(1)
  expect(menus[0]?.lines.map((line) => line.text)).toEqual(["Setup"])
  expect(menus[0]?.items.map((item) => item.label)).toEqual(["Red"])
  run(menus, ["1"])
  expect(replies).toEqual([{ sessionID: "ses_test", formID: "form_1", answer: { colour: "r" }, location: undefined }])
})

test("AC-041 numbers are parsed and validated, booleans use Yes and No, multiselect takes comma separated numbers", () => {
  const replies: { answer: Record<string, unknown> }[] = []
  const menus = formMenus(
    request([
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
    ]),
    { reply: (reply) => void replies.push(reply), cancel: () => {} },
  )
  expect(menus.map((menu) => menu.items.map((item) => item.label))).toEqual([[], ["Yes", "No"], ["A", "B", "C"]])
  expect(menus[0]?.onAnswer("two")).toBe("keep")
  expect(menus[0]?.onAnswer("5")).toBe("keep")
  run(menus, ["0.5", "2", "1, 3"])
  expect(replies).toEqual([
    { sessionID: "ses_test", formID: "form_1", answer: { ratio: 0.5, ok: false, tags: ["a", "c"] } } as never,
  ])
})

test("AC-041 hidden and external fields are skipped and a title-less field falls back to its key", () => {
  const menus = formMenus(
    request([
      { type: "string", key: "secret", hidden: true },
      { type: "external", key: "auth", url: "https://example.com" },
      { type: "string", key: "name" },
    ]),
    { reply: () => {}, cancel: () => {} },
  )
  expect(menus).toHaveLength(1)
  expect(menus[0]?.lines.map((line) => line.text)).toEqual(["Setup"])
})

test("AC-041 a string field with options refuses free text unless custom is allowed", () => {
  const strict = formMenus(request([{ type: "string", key: "c", title: "C", options: [{ value: "a", label: "A" }] }]), {
    reply: () => {},
    cancel: () => {},
  })
  expect(strict[0]?.freeText).toBe(false)
  const custom = formMenus(
    request([{ type: "string", key: "c", title: "C", custom: true, options: [{ value: "a", label: "A" }] }]),
    { reply: () => {}, cancel: () => {} },
  )
  expect(custom[0]?.freeText).toBe(true)
  const replies: { answer: Record<string, unknown> }[] = []
  const bool = formMenus(request([{ type: "boolean", key: "ok", title: "Ok?" }]), {
    reply: (reply) => void replies.push(reply),
    cancel: () => {},
  })
  expect(bool[0]?.onAnswer("yes")).toBeUndefined()
  expect(replies[0]?.answer).toEqual({ ok: true })
})
