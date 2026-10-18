import { expect, test } from "bun:test"
import { detectScreenReader, resolveActivation } from "../../src/sr/detect"

const tasklist =
  (...images: string[]) =>
  async () =>
    [
      '"System Idle Process","0","Services","0","8 K"',
      ...images.map((image) => `"${image}","4242","Console","1","10 000 K"`),
    ].join("\r\n")

// AC-003 / AC-004: detection looks for NVDA and JAWS processes, on Windows only, within 500 ms.
test("AC-003 finds NVDA and JAWS by their process image names", async () => {
  expect(await detectScreenReader({ platform: "win32", listProcesses: tasklist("explorer.exe", "nvda.exe") })).toBe(
    "NVDA",
  )
  expect(await detectScreenReader({ platform: "win32", listProcesses: tasklist("JFW.EXE") })).toBe("JAWS")
  expect(await detectScreenReader({ platform: "win32", listProcesses: tasklist("jfw.exe", "nvda.exe") })).toBe("NVDA")
  expect(await detectScreenReader({ platform: "win32", listProcesses: tasklist("explorer.exe") })).toBeUndefined()
})

test("AC-004 never looks at processes outside Windows", async () => {
  let calls = 0
  const listProcesses = async () => {
    calls++
    return ""
  }
  expect(await detectScreenReader({ platform: "darwin", listProcesses })).toBeUndefined()
  expect(await detectScreenReader({ platform: "linux", listProcesses })).toBeUndefined()
  expect(calls).toBe(0)
})

test("AC-003 a failing or slow process list means no detection and no crash, within the timeout", async () => {
  expect(
    await detectScreenReader({
      platform: "win32",
      listProcesses: async () => {
        throw new Error("tasklist missing")
      },
    }),
  ).toBeUndefined()
  const started = Date.now()
  const result = await detectScreenReader({
    platform: "win32",
    timeoutMs: 20,
    listProcesses: () => new Promise(() => {}),
  })
  expect(result).toBeUndefined()
  expect(Date.now() - started).toBeLessThan(500)
})

// AC-002 / AC-003 / AC-005: precedence of flag, environment variable and detection.
test("AC-002 the flag wins and skips detection", async () => {
  let calls = 0
  const detect = async () => {
    calls++
    return "NVDA" as const
  }
  expect(await resolveActivation({ flag: true, env: undefined, platform: "win32", detection: "auto", detect })).toEqual(
    {
      source: "flag",
    },
  )
  expect(calls).toBe(0)
})

test("AC-002 OPENCODE_SCREEN_READER=1 activates and =0 disables even with a reader running", async () => {
  const detect = async () => "NVDA" as const
  for (const on of ["1", "true", "TRUE", "yes"])
    expect(await resolveActivation({ flag: false, env: on, platform: "win32", detection: "auto", detect })).toEqual({
      source: "env",
    })
  for (const off of ["0", "false", "no", ""])
    expect(
      await resolveActivation({ flag: false, env: off, platform: "win32", detection: "auto", detect }),
    ).toBeUndefined()
})

test("AC-003 detection on Windows reports the reader; elsewhere or when turned off nothing happens", async () => {
  let calls = 0
  const detect = async () => {
    calls++
    return "JAWS" as const
  }
  expect(
    await resolveActivation({ flag: false, env: undefined, platform: "win32", detection: "auto", detect }),
  ).toEqual({
    source: "detection",
    reader: "JAWS",
  })
  expect(
    await resolveActivation({ flag: false, env: undefined, platform: "win32", detection: "off", detect }),
  ).toBeUndefined()
  expect(
    await resolveActivation({ flag: false, env: undefined, platform: "darwin", detection: "auto", detect }),
  ).toBeUndefined()
  expect(calls).toBe(1)
  const none = async () => undefined
  expect(
    await resolveActivation({ flag: false, env: undefined, platform: "win32", detection: "auto", detect: none }),
  ).toBeUndefined()
})

test("AC-003 real tasklist output: CRLF, a header, an INFO line, thousands separators, empty output", async () => {
  const output = [
    '"Image Name","PID","Session Name","Session#","Mem Usage"',
    '"System Idle Process","0","Services","0","8 K"',
    "INFO: No tasks are running which match the specified criteria.",
    '"Zażółć Gęślą.exe","1200","Console","1","12 345 K"',
    '"nvda.exe","5120","Console","1","103 220 K"',
    "",
  ].join("\r\n")
  expect(await detectScreenReader({ platform: "win32", listProcesses: async () => output })).toBe("NVDA")
  expect(await detectScreenReader({ platform: "win32", listProcesses: async () => "" })).toBeUndefined()
  expect(
    await detectScreenReader({ platform: "win32", listProcesses: async () => "ERROR: Access denied.\r\n" }),
  ).toBeUndefined()
})
