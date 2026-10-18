import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { SPARKCODE_UPSTREAM_VERSION } from "@opencode/util/sparkcode"
import { checksums, feeds, releaseVersion, versionMatchesUpstream } from "../../../script/sparkcode-release"

describe("AC-004 version check", () => {
  test("test_AC_004_release_version_strips_the_v_and_requires_the_fork_counter", () => {
    expect(releaseVersion("v2.0.32-sparkcode.1")).toBe("2.0.32-sparkcode.1")
    expect(releaseVersion("2.0.32-sparkcode.12")).toBe("2.0.32-sparkcode.12")
    expect(releaseVersion("2.0.32")).toBeUndefined()
    expect(releaseVersion("2.0.32-sparkcode.")).toBeUndefined()
    expect(releaseVersion("2.0.32-beta.1")).toBeUndefined()
  })

  test("test_AC_004_version_must_start_with_the_upstream_constant", () => {
    expect(versionMatchesUpstream("2.0.32-sparkcode.1", "2.0.32")).toBe(true)
    expect(versionMatchesUpstream("2.0.33-sparkcode.1", "2.0.32")).toBe(false)
    expect(versionMatchesUpstream("2.0.320-sparkcode.1", "2.0.32")).toBe(false)
    expect(versionMatchesUpstream(`${SPARKCODE_UPSTREAM_VERSION}-sparkcode.1`, SPARKCODE_UPSTREAM_VERSION)).toBe(true)
  })
})

describe("AC-003 feeds", () => {
  const input = {
    version: "2.0.32-sparkcode.1",
    upstream: "2.0.32",
    released: "2026-10-20T18:00:00Z",
    assets: [{ target: "windows-x64", name: "sparkcode-windows-x64.zip", sha256: "f".repeat(64), size: 42 }],
  }

  test("test_AC_003_sparkcode_feed_matches_the_data_model", () => {
    const out = feeds(input)
    expect(out.sparkcode).toEqual({
      version: "2.0.32-sparkcode.1",
      upstream: "2.0.32",
      released: "2026-10-20T18:00:00Z",
      notes: "https://github.com/unlocked-spark/sparkcode/releases/tag/v2.0.32-sparkcode.1",
      assets: {
        "windows-x64": {
          url: "https://github.com/unlocked-spark/sparkcode/releases/download/v2.0.32-sparkcode.1/sparkcode-windows-x64.zip",
          sha256: "f".repeat(64),
          size: 42,
        },
      },
    })
  })

  test("test_AC_003_npm_feed_is_upstream_compatible", () => {
    expect(feeds(input).npm).toEqual({ version: "2.0.32-sparkcode.1", metadata: { package: "sparkcode" } })
  })

  test("test_AC_002_checksums_use_the_sha256sum_format", () => {
    const text = checksums([
      { name: "sparkcode-windows-x64.zip", sha256: "f".repeat(64) },
      { name: "install.ps1", sha256: "0".repeat(64) },
    ])
    expect(text).toBe(`${"f".repeat(64)}  sparkcode-windows-x64.zip\n${"0".repeat(64)}  install.ps1\n`)
  })
})

describe("install.ps1 as served", () => {
  // Windows PowerShell 5.1 reads a BOM-less file as ANSI and decodes the iex
  // download as Latin-1 when no charset is sent, so the scripts stay ASCII.
  test("test_AC_020_installer_scripts_are_ascii_without_bom_with_crlf", () => {
    for (const name of ["install.ps1", "smoke.ps1"]) {
      const bytes = readFileSync(path.join(import.meta.dir, "..", "..", "..", "installer", name))
      expect(bytes.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
      expect(bytes.every((byte) => byte < 0x80)).toBe(true)
      const text = bytes.toString("ascii")
      expect(text.includes("\n")).toBe(true)
      expect(text.replaceAll("\r\n", "")).not.toContain("\n")
    }
  })
})
