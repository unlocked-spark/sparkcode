/**
 * Version of upstream opencode that this fork is based on. Bump it whenever upstream is merged.
 *
 * The OpenCode Zen gateway reads the `User-Agent` header (`opencode/<channel>/<version>/cli`) and
 * serves its free models only when the version is a semver of 1.18.0 or newer; the channel is not
 * checked. A local build reports `local` as its version, which the gateway cannot parse, and a
 * version number of SparkCode's own would be rejected as too old. Outgoing requests therefore
 * identify themselves with the upstream version this code was forked from, while the build
 * version stays untouched everywhere else, including the service health response that the client
 * compares against its registration file.
 */
export const SPARKCODE_UPSTREAM_VERSION = "2.1.4"

/** How the product names itself in every user-facing place. */
export const SPARKCODE_NAME = "SparkCode"
/** The command users type and the binary name. */
export const SPARKCODE_COMMAND = "sparkcode"
/** Always shown next to the name: the fork condition and the honest description. */
export const SPARKCODE_TAGLINE = "an accessibility fork of opencode"
export const SPARKCODE_INTRO = `${SPARKCODE_NAME}, ${SPARKCODE_TAGLINE}`

/** The product site. The installer, the version feed and the upstream-compatible update API live under it. */
export const SPARKCODE_SITE = "https://sparkcode.unlockedspark.org"
/** Base of the feed path upstream's background update check builds: `<base>/<channel>/<artifact>/npm`. */
export const SPARKCODE_UPDATE_API = `${SPARKCODE_SITE}/update/api`
/** The version feed read by `sparkcode update`, the installer and the screen reader startup notice. */
export const SPARKCODE_FEED_URL = `${SPARKCODE_SITE}/update/sparkcode.json`
/** The Windows installer, downloaded and run by `sparkcode update`. */
export const SPARKCODE_INSTALLER_URL = `${SPARKCODE_SITE}/install.ps1`
/** Public repository; releases hang off it. */
export const SPARKCODE_REPOSITORY = "https://github.com/unlocked-spark/sparkcode"
