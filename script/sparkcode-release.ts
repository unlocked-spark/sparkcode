#!/usr/bin/env bun
// Release helpers for SparkCode, used by .github/workflows/release.yml and
// unit tested from packages/cli/test/sparkcode-release.test.ts.
//
//   bun script/sparkcode-release.ts check --version 2.0.32-sparkcode.1
//   bun script/sparkcode-release.ts package --version <v> --exe <opencode.exe> --installer installer/install.ps1 --out release
//
// `check` fails unless the version starts with SPARKCODE_UPSTREAM_VERSION, so
// the human-visible version and the User-Agent version cannot drift apart.
// `package` renames the built binary to sparkcode.exe, zips it, copies the
// installer, writes both feeds and SHA256SUMS into the output directory.
import { $ } from "bun"
import { mkdir, copyFile, rm } from "node:fs/promises"
import path from "node:path"
import { SPARKCODE_REPOSITORY, SPARKCODE_UPSTREAM_VERSION } from "../packages/util/src/sparkcode"

export const WINDOWS_ASSET = "sparkcode-windows-x64.zip"

const versionPattern = /^v?(\d+\.\d+\.\d+)-sparkcode\.(\d+)$/

/** `v2.0.32-sparkcode.1` or `2.0.32-sparkcode.1` to `2.0.32-sparkcode.1`; anything else is not a release version. */
export function releaseVersion(input: string) {
  const match = versionPattern.exec(input.trim())
  return match ? `${match[1]}-sparkcode.${match[2]}` : undefined
}

export function versionMatchesUpstream(version: string, upstream: string) {
  return releaseVersion(version)?.startsWith(`${upstream}-sparkcode.`) ?? false
}

export type ReleaseAsset = { target: string; name: string; sha256: string; size: number }

/** The two feeds attached to every release: SparkCode's own and the upstream-compatible one. */
export function feeds(input: { version: string; upstream: string; released: string; assets: ReleaseAsset[] }) {
  const tag = `v${input.version}`
  const assets: Record<string, { url: string; sha256: string; size: number }> = {}
  for (const asset of input.assets) {
    assets[asset.target] = {
      url: `${SPARKCODE_REPOSITORY}/releases/download/${tag}/${asset.name}`,
      sha256: asset.sha256,
      size: asset.size,
    }
  }
  return {
    sparkcode: {
      version: input.version,
      upstream: input.upstream,
      released: input.released,
      notes: `${SPARKCODE_REPOSITORY}/releases/tag/${tag}`,
      assets,
    },
    npm: { version: input.version, metadata: { package: "sparkcode" } },
  }
}

/** The format `sha256sum -c` accepts: two spaces between the digest and the name. */
export function checksums(entries: { name: string; sha256: string }[]) {
  return entries.map((entry) => `${entry.sha256}  ${entry.name}\n`).join("")
}

async function sha256(file: string) {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(await Bun.file(file).arrayBuffer())
  return hasher.digest("hex")
}

function flag(name: string) {
  const prefix = `--${name}=`
  const inline = process.argv.find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

function fail(message: string): never {
  console.error(`Error: ${message}`)
  process.exit(1)
}

async function main() {
  const command = process.argv[2]
  const requested = flag("version") ?? fail("--version is required")
  const version = releaseVersion(requested) ?? fail(`${requested} is not a release version (expected <upstream>-sparkcode.<n>)`)
  if (!versionMatchesUpstream(version, SPARKCODE_UPSTREAM_VERSION))
    fail(
      `version ${version} does not start with SPARKCODE_UPSTREAM_VERSION ${SPARKCODE_UPSTREAM_VERSION} (packages/util/src/sparkcode.ts)`,
    )
  if (command === "check") {
    console.log(`version ${version} matches upstream ${SPARKCODE_UPSTREAM_VERSION}`)
    return
  }
  if (command !== "package") fail(`unknown command ${command ?? ""}; use check or package`)

  const exe = flag("exe") ?? fail("--exe is required")
  const installer = flag("installer") ?? fail("--installer is required")
  const out = path.resolve(flag("out") ?? "release")
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })

  const staging = path.join(out, ".staging")
  await mkdir(staging, { recursive: true })
  await copyFile(exe, path.join(staging, "sparkcode.exe"))
  const zip = path.join(out, WINDOWS_ASSET)
  await $`zip -j -q ${zip} ${path.join(staging, "sparkcode.exe")}`
  await rm(staging, { recursive: true, force: true })
  await copyFile(installer, path.join(out, "install.ps1"))

  const asset: ReleaseAsset = { target: "windows-x64", name: WINDOWS_ASSET, sha256: await sha256(zip), size: Bun.file(zip).size }
  const built = feeds({ version, upstream: SPARKCODE_UPSTREAM_VERSION, released: new Date().toISOString(), assets: [asset] })
  await Bun.write(path.join(out, "sparkcode.json"), JSON.stringify(built.sparkcode, null, 2) + "\n")
  await Bun.write(path.join(out, "npm.json"), JSON.stringify(built.npm, null, 2) + "\n")

  const names = [WINDOWS_ASSET, "install.ps1", "sparkcode.json", "npm.json"]
  const entries = []
  for (const name of names) entries.push({ name, sha256: await sha256(path.join(out, name)) })
  await Bun.write(path.join(out, "SHA256SUMS"), checksums(entries))
  console.log(`packaged ${version} into ${out}: ${[...names, "SHA256SUMS"].join(", ")}`)
}

if (import.meta.main) await main()
