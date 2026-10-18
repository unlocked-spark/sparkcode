/**
 * Version of upstream opencode that this fork is based on. Bump it whenever upstream is merged.
 *
 * The OpenCode Zen gateway reads the `User-Agent` header (`opencode/<channel>/<version>/cli`) and
 * serves its free models only when the version is a semver of 1.18.0 or newer; the channel is not
 * checked. A local build reports `local` as its version, which the gateway cannot parse, and a
 * version number of Sparkcode's own would be rejected as too old. Outgoing requests therefore
 * identify themselves with the upstream version this code was forked from, while the build
 * version stays untouched everywhere else, including the service health response that the client
 * compares against its registration file.
 */
export const SPARKCODE_UPSTREAM_VERSION = "2.0.32"

/** How the product names itself in every user-facing place. */
export const SPARKCODE_NAME = "Sparkcode"
/** The command users type and the binary name. */
export const SPARKCODE_COMMAND = "sparkcode"
/** Always shown next to the name: the fork condition and the honest description. */
export const SPARKCODE_TAGLINE = "an accessibility fork of opencode"
export const SPARKCODE_INTRO = `${SPARKCODE_NAME}, ${SPARKCODE_TAGLINE}`
