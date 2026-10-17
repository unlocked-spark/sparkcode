import { expect, test } from "bun:test"
import { createMarkdownConverter, markdownToLines } from "../../src/sr/markdown"

// AC-022: markdown becomes speech-friendly plain text.
test("AC-022 headings become their text", () => {
  expect(markdownToLines("# Title\n## Sub title\n###   Deep")).toEqual(["Title", "Sub title", "Deep"])
})

test("AC-022 emphasis and strikethrough markers are removed", () => {
  expect(markdownToLines("This is **bold**, *italic*, __strong__, _em_ and ~~gone~~.")).toEqual([
    "This is bold, italic, strong, em and gone.",
  ])
})

test("AC-022 underscores inside identifiers survive", () => {
  expect(markdownToLines("Use snake_case_names and __init__.py")).toEqual(["Use snake_case_names and init.py"])
})

test("AC-022 inline code keeps its text without backticks", () => {
  expect(markdownToLines("Run `bun test` now")).toEqual(["Run bun test now"])
})

test("AC-022 links become text (url) and images are announced", () => {
  expect(markdownToLines("See [the docs](https://example.com/d) and ![logo](img.png)")).toEqual([
    "See the docs (https://example.com/d) and image logo (img.png)",
  ])
})

test("AC-022 bullet lists keep a dash and numbered lists keep their numbers", () => {
  expect(markdownToLines("* one\n+ two\n- three\n  * nested\n1. first\n2) second")).toEqual([
    "- one",
    "- two",
    "- three",
    "  - nested",
    "1. first",
    "2) second",
  ])
})

test("AC-022 blockquotes lose the marker, rules are dropped, blank lines are dropped", () => {
  expect(markdownToLines("> quoted\n\n---\n\ntext\n***")).toEqual(["quoted", "text"])
})

test("AC-022 fenced code blocks are framed by code and end code lines", () => {
  expect(markdownToLines("Before\n```ts\nconst a = 1\n\nconst b = 2\n```\nAfter")).toEqual([
    "Before",
    "code (ts):",
    "const a = 1",
    "const b = 2",
    "end code",
    "After",
  ])
})

test("AC-022 fenced code without a language uses a bare code label and keeps markdown inside verbatim", () => {
  expect(markdownToLines("```\n# not a heading\n**not bold**\n```")).toEqual([
    "code:",
    "# not a heading",
    "**not bold**",
    "end code",
  ])
})

test("AC-022 tables become one line per row in Header: value form", () => {
  expect(markdownToLines("| Name | Size |\n|------|-----:|\n| a.ts | 12 |\n| b.ts | 3 |")).toEqual([
    "Name: a.ts, Size: 12",
    "Name: b.ts, Size: 3",
  ])
})

test("AC-022 a pipe line without a separator row is plain text", () => {
  expect(markdownToLines("a | b\nnext line")).toEqual(["a | b", "next line"])
})

test("AC-022 the converter is stateful across pushes so fences survive streaming", () => {
  const md = createMarkdownConverter()
  expect(md.push("```sh")).toEqual(["code (sh):"])
  expect(md.push("# comment")).toEqual(["# comment"])
  expect(md.push("```")).toEqual(["end code"])
  expect(md.push("| h |")).toEqual([])
  expect(md.end()).toEqual(["h"])
})

test("AC-022 an unterminated fence is closed at end", () => {
  const md = createMarkdownConverter()
  md.push("```")
  md.push("x")
  expect(md.end()).toEqual(["end code"])
})

test("AC-022 html tags are removed", () => {
  expect(markdownToLines("line<br>break <b>bold</b>")).toEqual(["linebreak bold"])
})

test("AC-022 inline code keeps generics, dunder names and angle brackets", () => {
  expect(markdownToLines("Returns `Promise<void>` from `__init__.py` via `Map<string, number>`")).toEqual([
    "Returns Promise<void> from __init__.py via Map<string, number>",
  ])
})

test("AC-022 autolinks keep their url", () => {
  expect(markdownToLines("See <https://example.com/x> now")).toEqual(["See https://example.com/x now"])
})
