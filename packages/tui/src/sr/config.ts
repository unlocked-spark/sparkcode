import type { MiniSettings } from "../mini/types"

type MiniConfig = { mini?: Partial<MiniSettings> }

// The mini transport drops tool commits and buffers assistant text whenever the
// user's `mini.tools` is "hide" (the upstream default) and skips reasoning when
// `mini.thinking` is "hide". The screen reader frontend filters those itself, so
// the transport must see everything. Splash and footer are OpenTUI concerns.
export function visibleStreams<T extends MiniConfig>(config: T): Omit<T, "mini"> & { mini: Partial<MiniSettings> } {
  return {
    ...config,
    mini: { ...config.mini, tools: "show", thinking: "show", splash: "hide", footer: "hide" },
  }
}
