import { expect, test } from "bun:test"
import { createMenuQueue, type Menu } from "../../src/sr/menu"
import type { TranscriptLine } from "../../src/sr/writer"

function harness() {
  const shown: TranscriptLine[] = []
  const queue = createMenuQueue((lines) => void shown.push(...lines))
  return { shown, queue }
}

function numbered(answers: string[], extra: Partial<Menu> = {}): Menu {
  return {
    kind: "question",
    lines: [{ label: "question", text: "Pick" }],
    items: [
      { index: 1, label: "One", value: "one" },
      { index: 2, label: "Two", value: "two" },
    ],
    freeText: false,
    onAnswer: (value) => void answers.push(value),
    onCancel: () => void answers.push("<cancel>"),
    ...extra,
  }
}

test("AC-045 a menu shows its lines once and answers by number", () => {
  const h = harness()
  const answers: string[] = []
  h.queue.open(numbered(answers))
  expect(h.shown.map((line) => line.text)).toEqual(["Pick", "1. One", "2. Two", "Type the number."])
  expect(h.queue.answer("2")).toBe(true)
  expect(answers).toEqual(["two"])
  expect(h.queue.active).toBeUndefined()
})

test("AC-045 out of range numbers and other text are rejected with a hint when free text is off", () => {
  const h = harness()
  const answers: string[] = []
  h.queue.open(numbered(answers))
  expect(h.queue.answer("7")).toBe(true)
  expect(h.queue.answer("purple")).toBe(true)
  expect(answers).toEqual([])
  expect(h.shown.at(-1)).toEqual({ label: "system", text: "Type a number from 1 to 2." })
})

test("AC-041 free text is accepted when the menu allows it", () => {
  const h = harness()
  const answers: string[] = []
  h.queue.open(numbered(answers, { freeText: true }))
  expect(h.shown.at(-1)?.text).toBe("Type the number, or your own answer.")
  h.queue.answer("purple")
  expect(answers).toEqual(["purple"])
})

test("AC-040 single keys answer without Enter and other keys are ignored", () => {
  const h = harness()
  const answers: string[] = []
  h.queue.open({
    kind: "permission",
    lines: [{ label: "permission", text: "shell ls. Answer y for once, a for always, n to reject." }],
    items: [],
    freeText: false,
    singleKeys: { y: "once", a: "always", n: "reject" },
    hint: "Answer y, a or n.",
    onAnswer: (value) => void answers.push(value),
    onCancel: () => {},
  })
  expect(h.queue.key("x")).toBe(false)
  expect(h.queue.key("Y")).toBe(true)
  expect(answers).toEqual(["once"])
})

test("AC-045 menus queue: the second shows only after the first resolves; cancel moves on too", () => {
  const h = harness()
  const answers: string[] = []
  h.queue.open(numbered(answers, { lines: [{ label: "question", text: "First" }] }))
  h.queue.open(numbered(answers, { lines: [{ label: "question", text: "Second" }] }))
  expect(h.shown.filter((line) => line.label === "question").map((line) => line.text)).toEqual(["First"])
  h.queue.cancel()
  expect(answers).toEqual(["<cancel>"])
  expect(h.shown.filter((line) => line.label === "question").map((line) => line.text)).toEqual(["First", "Second"])
  h.queue.answer("1")
  expect(answers).toEqual(["<cancel>", "one"])
})

test("AC-045 dismiss drops the active menu without calling back and answer returns false when nothing is open", () => {
  const h = harness()
  const answers: string[] = []
  h.queue.open(numbered(answers))
  h.queue.dismiss((menu) => menu.kind === "question")
  expect(answers).toEqual([])
  expect(h.queue.answer("1")).toBe(false)
})

test("a menu can keep itself open by returning keep from onAnswer", () => {
  const h = harness()
  let calls = 0
  h.queue.open(numbered([], { freeText: true, onAnswer: () => (++calls < 2 ? "keep" : undefined) }))
  h.queue.answer("a")
  expect(h.queue.active).toBeDefined()
  h.queue.answer("b")
  expect(h.queue.active).toBeUndefined()
})
