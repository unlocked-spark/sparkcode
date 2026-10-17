// Markdown to speech-friendly text (AC-022). The converter is stateful so that a
// fenced code block or a table can arrive line by line while an answer streams.

export type MarkdownConverter = {
  /** Convert one source line; returns zero or more output lines. */
  push(line: string): string[]
  /** Flush buffered state at the end of a message. */
  end(): string[]
}

const fenceOpen = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/
const horizontalRule = /^\s*([-*_])(\s*\1){2,}\s*$/
const heading = /^\s*#{1,6}\s+(.*)$/
const blockquote = /^\s*>\s?/
const bullet = /^(\s*)[-*+]\s+/
const tableSeparator = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function isTableRow(line: string) {
  const trimmed = line.trim()
  if (!trimmed.includes("|")) return false
  return trimmed.startsWith("|") || trimmed.includes(" | ")
}

function cells(line: string): string[] {
  let trimmed = line.trim()
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1)
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1)
  return trimmed.split("|").map((cell) => inline(cell.trim()))
}

function inline(text: string): string {
  const spans: string[] = []
  const protectedText = text
    .replace(/`([^`]+)`/g, (_, code: string) => {
      spans.push(code)
      return `\u0000${spans.length - 1}\u0000`
    })
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
  const converted = protectedText
    .replace(/<[^>]+>/g, "")
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s[^)]*)?\)/g, "image $1 ($2)")
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s[^)]*)?\)/g, "$1 ($2)")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\*(\S(?:.*?\S)?)\*/g, "$1")
    .replace(/(^|[^\w])_(\S(?:.*?\S)?)_(?=[^\w]|$)/g, "$1$2")
  return converted.replace(/\u0000(\d+)\u0000/g, (_, index: string) => spans[Number(index)] ?? "").trimEnd()
}

function plainRow(line: string): string {
  const trimmed = line.trim()
  if (!trimmed.startsWith("|")) return inline(line)
  return cells(line).join(", ")
}

function block(line: string): string[] {
  if (line.trim() === "") return []
  if (horizontalRule.test(line)) return []
  const head = heading.exec(line)
  if (head) {
    const text = inline((head[1] ?? "").trim())
    return text ? [text] : []
  }
  let body = line
  while (blockquote.test(body)) body = body.replace(blockquote, "")
  body = body.replace(bullet, "$1- ")
  const text = inline(body)
  return text.trim() === "" ? [] : [text]
}

export function createMarkdownConverter(): MarkdownConverter {
  let fence: string | undefined
  let pending: string | undefined
  let header: string[] | undefined

  const flushPending = (): string[] => {
    if (pending === undefined) return []
    const row = plainRow(pending)
    pending = undefined
    return row.trim() === "" ? [] : [row]
  }

  const push = (line: string): string[] => {
    if (fence !== undefined) {
      const trimmed = line.trim()
      if (trimmed.startsWith(fence) && trimmed.slice(fence.length).trim() === "") {
        fence = undefined
        return ["end code"]
      }
      return line.trim() === "" ? [] : [line.trimEnd()]
    }
    if (header !== undefined) {
      if (isTableRow(line)) {
        const columns = header
        const values = cells(line)
        return [columns.map((name, index) => `${name}: ${values[index] ?? ""}`).join(", ")]
      }
      header = undefined
    }
    if (pending !== undefined) {
      if (tableSeparator.test(line) && line.includes("-")) {
        header = cells(pending)
        pending = undefined
        return []
      }
      const flushed = flushPending()
      return [...flushed, ...push(line)]
    }
    if (isTableRow(line)) {
      pending = line
      return []
    }
    const open = fenceOpen.exec(line)
    if (open) {
      fence = open[1]
      const language = open[2]
      return [language ? `code (${language}):` : "code:"]
    }
    return block(line)
  }

  return {
    push,
    end() {
      const out = flushPending()
      header = undefined
      if (fence !== undefined) {
        fence = undefined
        out.push("end code")
      }
      return out
    },
  }
}

export function markdownToLines(text: string): string[] {
  const converter = createMarkdownConverter()
  const out = text.split("\n").flatMap((line) => converter.push(line))
  return [...out, ...converter.end()]
}
