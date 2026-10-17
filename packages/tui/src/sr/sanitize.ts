// Text that reaches a screen reader must be plain: no terminal escape sequences,
// no control characters, no glyphs whose names would be read aloud instead of
// their meaning. Everything written by the screen reader frontend passes through
// here, whatever its origin (model, tool output, upstream helpers, file names).

const escapeSequence =
  // OSC (title, hyperlinks) ended by BEL or ST; DCS/PM/APC ended by ST; CSI; charset selection; any other ESC pair.
  /\x1b(?:\][^\x07\x1b\n]*(?:\x07|\x1b\\)?|[PX^_][^\x1b\n]*\x1b\\|\[[0-?]*[ -/]*[@-~]|[()*+][0-9A-Za-z]|[@-Z\\-_])/g

const controlCharacters = /[\x00-\x08\x0b-\x1f\x7f\u0080-\u009f]/g

const replacements: Record<number, string> = {
  0x00a0: " ",
  0x00b7: "-",
  0x2010: "-",
  0x2011: "-",
  0x2012: "-",
  0x2013: "-",
  0x2014: "--",
  0x2018: "'",
  0x2019: "'",
  0x201c: '"',
  0x201d: '"',
  0x2022: "*",
  0x2026: "...",
  0x2190: "<-",
  0x2191: "up",
  0x2192: "->",
  0x2193: "down",
  0x2699: "*",
  0x2713: "ok",
  0x2714: "ok",
  0x2716: "!",
  0x2717: "!",
  0x2718: "!",
  0x2731: "*",
  0x25c8: "*",
  0x25c9: "*",
  0x27f3: "*",
}

const horizontalBoxDrawing = new Set([
  0x2500, 0x2501, 0x2504, 0x2505, 0x2508, 0x2509, 0x254c, 0x254d, 0x2550, 0x2574, 0x2576, 0x2578, 0x257a, 0x257c,
  0x257e,
])

const verticalBoxDrawing = new Set([
  0x2502, 0x2503, 0x2506, 0x2507, 0x250a, 0x250b, 0x254e, 0x254f, 0x2551, 0x2575, 0x2577, 0x2579, 0x257b, 0x257d,
  0x257f,
])

function replaceGlyph(point: number): string | undefined {
  const mapped = replacements[point]
  if (mapped !== undefined) return mapped
  if (point >= 0x2500 && point <= 0x257f) {
    if (horizontalBoxDrawing.has(point)) return "-"
    if (verticalBoxDrawing.has(point)) return "|"
    return "+"
  }
  // Block elements, braille patterns (spinners) and private use glyphs (icon fonts) carry no speech value.
  if (point >= 0x2580 && point <= 0x259f) return ""
  if (point >= 0x2800 && point <= 0x28ff) return ""
  if (point >= 0xe000 && point <= 0xf8ff) return ""
  if (point >= 0xf0000) return ""
  return undefined
}

/** Strip escape sequences and control characters, replace decorative glyphs with ASCII, trim trailing whitespace. */
export function sanitizeText(value: string): string {
  const stripped = value.replace(escapeSequence, "").replace(controlCharacters, "")
  let result = ""
  for (const char of stripped) {
    const point = char.codePointAt(0)
    if (point === undefined) continue
    const mapped = replaceGlyph(point)
    result += mapped ?? char
  }
  return result.replace(/[ \t]+$/gm, "")
}
