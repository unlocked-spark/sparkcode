import { expect, test } from "bun:test"
import { sanitizeText } from "../../src/sr/sanitize"

// AC-014: text from models, tools and files is stripped of ESC sequences and control characters.
test("AC-014 removes CSI colour and cursor sequences", () => {
  expect(sanitizeText("\x1b[31mred\x1b[0m and \x1b[2K\x1b[1Gline")).toBe("red and line")
})

test("AC-014 removes OSC sequences terminated by BEL or ST", () => {
  expect(sanitizeText("\x1b]0;title\x07text \x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\")).toBe("text link")
})

test("AC-014 removes lone ESC with one following byte and other C0 controls", () => {
  expect(sanitizeText("a\x1b(Bb\x00c\x08d\x07e")).toBe("abcde")
})

test("AC-014 keeps tab and newline, drops carriage return", () => {
  expect(sanitizeText("col1\tcol2\r\nnext\r")).toBe("col1\tcol2\nnext")
})

// AC-015: box drawing, block characters and private-use glyphs are replaced with ASCII.
test("AC-015 replaces box drawing with ASCII and drops block characters", () => {
  expect(sanitizeText("┌──┐ │x│ └──┘")).toBe("+--+ |x| +--+")
  expect(sanitizeText("█▀▀█ ▄▄ ▓▒░")).toBe("")
})

test("AC-015 maps arrows, bullets and typographic punctuation to ASCII", () => {
  expect(sanitizeText("→ next • item … done “quoted” — dash nbsp")).toBe(
    '-> next * item ... done "quoted" -- dash nbsp',
  )
})

test("AC-015 drops private use and braille spinner glyphs", () => {
  expect(sanitizeText(" prompt ⠀⣿ spin")).toBe(" prompt  spin")
})

test("AC-015 maps check marks to words a screen reader can say", () => {
  expect(sanitizeText("✓ passed ✗ failed")).toBe("ok passed ! failed")
})

test("AC-014 a lone ESC P or an unterminated OSC never swallows the following lines", () => {
  expect(sanitizeText("\x1bPress any key\nnext line")).toBe("ress any key\nnext line")
  expect(sanitizeText("\x1b]0;unterminated\nvisible")).toBe("\nvisible")
})

test("AC-014 C1 control characters are removed", () => {
  expect(sanitizeText("a\u009b31mb\u0085c")).toBe("a31mbc")
})
