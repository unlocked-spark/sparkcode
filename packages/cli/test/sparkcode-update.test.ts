import { describe, expect, test } from "bun:test"
import { SPARKCODE_FEED_URL, SPARKCODE_INSTALLER_URL, SPARKCODE_NAME } from "@opencode/util/sparkcode"
import {
  checkForUpdate,
  compareVersions,
  feedTarget,
  fetchFeed,
  parseFeed,
  runUpdate,
  type UpdateDeps,
} from "../src/sparkcode-update"

const feed = {
  version: "2.0.32-sparkcode.2",
  upstream: "2.0.32",
  released: "2026-10-20T18:00:00Z",
  notes: "https://github.com/unlocked-spark/sparkcode/releases/tag/v2.0.32-sparkcode.2",
  assets: {
    "windows-x64": {
      url: "https://github.com/unlocked-spark/sparkcode/releases/download/v2.0.32-sparkcode.2/sparkcode-windows-x64.zip",
      sha256: "a".repeat(64),
      size: 123,
    },
  },
}

function json(body: unknown, status = 200) {
  return async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

type Fake = {
  deps: UpdateDeps
  lines: string[]
  runs: { command: string; args: string[] }[]
  written: { name: string; content: string }[]
}

function fake(input: Partial<UpdateDeps> & { installerCode?: number; pwsh?: boolean } = {}): Fake {
  const lines: string[] = []
  const runs: Fake["runs"] = []
  const written: Fake["written"] = []
  const deps: UpdateDeps = {
    running: "2.0.32-sparkcode.1",
    platform: "win32",
    arch: "x64",
    fetch: async (url) => {
      if (url === SPARKCODE_INSTALLER_URL) return new Response("Write-Host 'installer'", { status: 200 })
      return json(feed)()
    },
    write: (line) => lines.push(line),
    writeTemp: async (name, content) => {
      written.push({ name, content })
      return `C:\\Temp\\${name}`
    },
    run: async (command, args) => {
      runs.push({ command, args })
      return input.installerCode ?? 0
    },
    hasPowerShell: async (command) => command === "pwsh" && input.pwsh === true,
    ...input,
  }
  return { deps, lines, runs, written }
}

describe("AC-031 version comparison", () => {
  test("test_AC_031_fork_counter_orders_releases", () => {
    expect(compareVersions("2.0.32-sparkcode.2", "2.0.32-sparkcode.1")).toBeGreaterThan(0)
    expect(compareVersions("2.0.32-sparkcode.1", "2.0.32-sparkcode.2")).toBeLessThan(0)
    expect(compareVersions("2.0.32-sparkcode.1", "2.0.32-sparkcode.1")).toBe(0)
  })

  test("test_AC_031_upstream_base_outranks_the_counter", () => {
    expect(compareVersions("2.0.33-sparkcode.1", "2.0.32-sparkcode.2")).toBeGreaterThan(0)
    expect(compareVersions("2.0.32-sparkcode.10", "2.0.32-sparkcode.9")).toBeGreaterThan(0)
    expect(compareVersions("2.1.0-sparkcode.1", "2.0.99-sparkcode.1")).toBeGreaterThan(0)
  })

  test("test_AC_031_prerelease_sorts_before_the_plain_release_and_v_prefix_is_ignored", () => {
    expect(compareVersions("2.0.32", "2.0.32-sparkcode.1")).toBeGreaterThan(0)
    expect(compareVersions("v2.0.32-sparkcode.1", "2.0.32-sparkcode.1")).toBe(0)
    expect(compareVersions("local", "2.0.32-sparkcode.1")).toBeUndefined()
  })
})

describe("AC-031 feed parsing", () => {
  test("test_AC_031_accepts_the_documented_feed", () => {
    const parsed = parseFeed(feed)
    expect(parsed?.version).toBe("2.0.32-sparkcode.2")
    expect(parsed?.assets["windows-x64"]?.sha256).toBe("a".repeat(64))
  })

  test("test_AC_031_rejects_feeds_without_a_version_or_assets", () => {
    expect(parseFeed({ ...feed, version: undefined })).toBeUndefined()
    expect(parseFeed({ ...feed, version: "latest" })).toBeUndefined()
    expect(parseFeed({ ...feed, assets: undefined })).toBeUndefined()
    expect(parseFeed({ ...feed, assets: { "windows-x64": { url: "x" } } })).toBeUndefined()
    expect(parseFeed("not json")).toBeUndefined()
  })

  test("test_AC_031_feed_target_follows_platform_and_arch", () => {
    expect(feedTarget("win32", "x64")).toBe("windows-x64")
    expect(feedTarget("darwin", "arm64")).toBe("darwin-arm64")
    expect(feedTarget("darwin", "x64")).toBe("darwin-x64")
    expect(feedTarget("linux", "x64")).toBe("linux-x64")
    expect(feedTarget("freebsd", "x64")).toBeUndefined()
  })

  test("test_AC_031_fetch_feed_names_the_url_on_failure", async () => {
    await expect(fetchFeed(SPARKCODE_FEED_URL, json({}, 404), 1000)).rejects.toThrow(/published yet/)
    await expect(
      fetchFeed(SPARKCODE_FEED_URL, async () => Promise.reject(new Error("getaddrinfo ENOTFOUND")), 1000),
    ).rejects.toThrow(/ENOTFOUND/)
    await expect(fetchFeed(SPARKCODE_FEED_URL, json({ hello: 1 }), 1000)).rejects.toThrow(/not valid/)
  })
})

describe("AC-034 development build", () => {
  test("test_AC_034_local_build_is_told_to_update_from_git", async () => {
    const f = fake({ running: "local" })
    const result = await runUpdate(f.deps)
    expect(result).toMatchObject({ state: "development", exitCode: 0 })
    expect(f.lines).toEqual(["This is a development build; update from git instead."])
    expect(f.runs).toEqual([])
  })
})

describe("AC-031 up to date", () => {
  test("test_AC_031_same_version_is_up_to_date", async () => {
    const f = fake({ running: "2.0.32-sparkcode.2" })
    const result = await runUpdate(f.deps)
    expect(result).toMatchObject({ state: "up-to-date", exitCode: 0, latest: "2.0.32-sparkcode.2" })
    expect(f.lines).toEqual(["Checking for updates.", `${SPARKCODE_NAME} 2.0.32-sparkcode.2 is up to date.`])
    expect(f.runs).toEqual([])
  })

  test("test_AC_031_newer_running_version_is_up_to_date", async () => {
    const f = fake({ running: "2.0.33-sparkcode.1" })
    const result = await runUpdate(f.deps)
    expect(result.state).toBe("up-to-date")
  })
})

describe("AC-032 updating on Windows", () => {
  test("test_AC_032_downloads_the_installer_and_runs_it_with_the_version", async () => {
    const f = fake()
    const result = await runUpdate(f.deps)
    expect(result).toMatchObject({ state: "updated", exitCode: 0, running: "2.0.32-sparkcode.1", latest: "2.0.32-sparkcode.2" })
    expect(f.lines).toEqual([
      "Checking for updates.",
      `Updating ${SPARKCODE_NAME} 2.0.32-sparkcode.1 to 2.0.32-sparkcode.2.`,
      `Restart ${SPARKCODE_NAME} to use 2.0.32-sparkcode.2.`,
    ])
    expect(f.written).toEqual([{ name: "install.ps1", content: "Write-Host 'installer'" }])
    expect(f.runs).toEqual([
      {
        command: "powershell",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\Temp\\install.ps1", "-Version", "2.0.32-sparkcode.2"],
      },
    ])
  })

  test("test_AC_032_prefers_pwsh_when_present", async () => {
    const f = fake({ pwsh: true })
    await runUpdate(f.deps)
    expect(f.runs[0]?.command).toBe("pwsh")
  })

  test("test_AC_032_installer_exit_code_is_passed_through", async () => {
    const f = fake({ installerCode: 3 })
    const result = await runUpdate(f.deps)
    expect(result).toMatchObject({ state: "failed", exitCode: 3 })
    expect(f.lines.at(-1)).toBe("Error: The installer exited with code 3.")
  })

  test("test_AC_031_target_selects_a_version_without_reading_the_feed", async () => {
    let feedRequests = 0
    const f = fake({
      fetch: async (url) => {
        if (url === SPARKCODE_FEED_URL) feedRequests++
        return new Response("installer", { status: 200 })
      },
    })
    const result = await runUpdate(f.deps, { target: "v2.0.32-sparkcode.5" })
    expect(feedRequests).toBe(0)
    expect(result).toMatchObject({ state: "updated", latest: "2.0.32-sparkcode.5" })
    expect(f.runs[0]?.args.at(-1)).toBe("2.0.32-sparkcode.5")
  })

  test("test_AC_031_older_target_is_installed_as_a_rollback", async () => {
    const f = fake({ running: "2.0.32-sparkcode.3" })
    const result = await runUpdate(f.deps, { target: "2.0.32-sparkcode.2" })
    expect(result).toMatchObject({ state: "updated", latest: "2.0.32-sparkcode.2" })
    expect(f.lines[0]).toBe(`Installing ${SPARKCODE_NAME} 2.0.32-sparkcode.2 over 2.0.32-sparkcode.3.`)
    expect(f.runs[0]?.args.at(-1)).toBe("2.0.32-sparkcode.2")
  })

  test("test_AC_027_installer_that_cannot_start_is_one_error_line", async () => {
    const noTemp = fake({ writeTemp: async () => Promise.reject(new Error("EACCES: permission denied")) })
    const first = await runUpdate(noTemp.deps)
    expect(first).toMatchObject({ state: "failed", exitCode: 1 })
    expect(noTemp.lines.at(-1)).toBe("Error: Could not start the installer: EACCES: permission denied.")
    const noShell = fake({ run: async () => Promise.reject(new Error("powershell could not be started (ENOENT)")) })
    const second = await runUpdate(noShell.deps)
    expect(second.state).toBe("failed")
    expect(noShell.lines.at(-1)).toBe("Error: Could not start the installer: powershell could not be started (ENOENT).")
  })

  test("test_AC_031_target_equal_to_the_running_version_is_up_to_date", async () => {
    const f = fake()
    const result = await runUpdate(f.deps, { target: "2.0.32-sparkcode.1" })
    expect(result.state).toBe("up-to-date")
    expect(f.runs).toEqual([])
  })

  test("test_AC_031_invalid_target_is_an_error", async () => {
    const f = fake()
    const result = await runUpdate(f.deps, { target: "latest" })
    expect(result).toMatchObject({ state: "failed", exitCode: 1 })
    expect(f.lines).toEqual(["Error: Invalid version: latest."])
  })

  test("test_AC_030_method_is_accepted_and_ignored_with_a_notice", async () => {
    const f = fake()
    await runUpdate(f.deps, { method: "npm" })
    expect(f.lines[0]).toBe(`${SPARKCODE_NAME} is installed by its own installer; --method is ignored.`)
    expect(f.runs).toHaveLength(1)
  })

  test("test_AC_032_installer_download_failure_is_one_error_line", async () => {
    const f = fake({
      fetch: async (url) => (url === SPARKCODE_INSTALLER_URL ? new Response("", { status: 500 }) : json(feed)()),
    })
    const result = await runUpdate(f.deps)
    expect(result).toMatchObject({ state: "failed", exitCode: 1 })
    expect(f.lines.at(-1)).toBe(`Error: Could not download ${SPARKCODE_INSTALLER_URL}: HTTP 500.`)
    expect(f.runs).toEqual([])
  })
})

describe("AC-033 other platforms", () => {
  test("test_AC_033_darwin_without_an_asset_points_at_the_release_page", async () => {
    const f = fake({ platform: "darwin", arch: "arm64" })
    const result = await runUpdate(f.deps)
    expect(result).toMatchObject({ state: "unsupported", exitCode: 1 })
    expect(f.lines.at(-1)).toBe(
      "Automatic update is not available on this platform yet. Download https://github.com/unlocked-spark/sparkcode/releases/tag/v2.0.32-sparkcode.2 from the releases page.",
    )
    expect(f.runs).toEqual([])
  })

  test("test_AC_033_darwin_with_an_asset_names_the_asset", async () => {
    const mac = { ...feed, assets: { ...feed.assets, "darwin-arm64": { url: "https://example.test/mac.zip", sha256: "b".repeat(64) } } }
    const f = fake({ platform: "darwin", arch: "arm64", fetch: json(mac) })
    const result = await runUpdate(f.deps)
    expect(result.state).toBe("unsupported")
    expect(f.lines.at(-1)).toContain("Download https://example.test/mac.zip from the releases page.")
  })

  test("test_AC_033_up_to_date_wins_over_the_platform_notice", async () => {
    const f = fake({ platform: "linux", arch: "x64", running: "2.0.32-sparkcode.2" })
    const result = await runUpdate(f.deps)
    expect(result.state).toBe("up-to-date")
  })
})

describe("TC-004 feed failures", () => {
  test("test_TC_004_offline_is_one_error_line_naming_the_feed", async () => {
    const f = fake({ fetch: async () => Promise.reject(new Error("fetch failed")) })
    const result = await runUpdate(f.deps)
    expect(result).toMatchObject({ state: "failed", exitCode: 1 })
    expect(f.lines).toEqual(["Checking for updates.", `Error: Could not read ${SPARKCODE_FEED_URL}: fetch failed.`])
  })

  test("test_TC_004_no_release_yet", async () => {
    const f = fake({ fetch: json({}, 404) })
    const result = await runUpdate(f.deps)
    expect(result.exitCode).toBe(1)
    expect(f.lines.at(-1)).toBe(`Error: No ${SPARKCODE_NAME} release is published yet (${SPARKCODE_FEED_URL}).`)
  })

  test("test_AC_031_feed_fetch_times_out", async () => {
    const f = fake({
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
      timeoutMs: 20,
    })
    const result = await runUpdate(f.deps)
    expect(result.state).toBe("failed")
    expect(f.lines.at(-1)).toMatch(/^Error: Could not read .*aborted\.$/)
  })
})

describe("AC-035 plain output", () => {
  test("test_AC_035_lines_carry_no_escape_sequences_or_line_breaks", async () => {
    const cases = [fake(), fake({ running: "local" }), fake({ platform: "darwin", arch: "arm64" }), fake({ installerCode: 2 })]
    for (const f of cases) await runUpdate(f.deps, { method: "curl" })
    for (const f of cases) {
      expect(f.lines.length).toBeGreaterThan(0)
      for (const line of f.lines) {
        expect(line).not.toMatch(/[\u001b\r\n]/)
        expect(line.trim()).toBe(line)
      }
    }
  })
})

describe("AC-043 startup check for the screen reader frontend", () => {
  test("test_AC_043_newer_version_is_reported", async () => {
    await expect(checkForUpdate({ running: "2.0.32-sparkcode.1", fetch: json(feed) })).resolves.toBe("2.0.32-sparkcode.2")
  })

  test("test_AC_043_same_or_newer_running_version_is_silent", async () => {
    await expect(checkForUpdate({ running: "2.0.32-sparkcode.2", fetch: json(feed) })).resolves.toBeUndefined()
    await expect(checkForUpdate({ running: "2.0.33-sparkcode.1", fetch: json(feed) })).resolves.toBeUndefined()
  })

  test("test_AC_043_failures_are_silent", async () => {
    await expect(checkForUpdate({ running: "2.0.32-sparkcode.1", fetch: json({}, 404) })).resolves.toBeUndefined()
    await expect(checkForUpdate({ running: "2.0.32-sparkcode.1", fetch: json("garbage") })).resolves.toBeUndefined()
    await expect(
      checkForUpdate({ running: "2.0.32-sparkcode.1", fetch: async () => Promise.reject(new Error("offline")) }),
    ).resolves.toBeUndefined()
  })

  test("test_AC_043_slow_feed_is_abandoned_after_the_timeout", async () => {
    const started = Date.now()
    const result = await checkForUpdate({
      running: "2.0.32-sparkcode.1",
      timeoutMs: 30,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    })
    expect(result).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test("test_AC_043_local_build_never_asks_the_feed", async () => {
    let calls = 0
    const result = await checkForUpdate({
      running: "local",
      fetch: async () => {
        calls++
        return json(feed)()
      },
    })
    expect(result).toBeUndefined()
    expect(calls).toBe(0)
  })
})
