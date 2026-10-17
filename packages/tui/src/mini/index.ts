import { runInteractiveDeferredMode, type RunDeferredInput, type RunRuntimeDeps } from "./runtime"

export type MiniFrontendInput = RunDeferredInput & {
  /** Replaces the OpenTUI footer with another output layer, such as the screen reader frontend. */
  lifecycle?: RunRuntimeDeps["createRuntimeLifecycle"]
}

export async function runMiniFrontend(input: MiniFrontendInput): Promise<void> {
  const { lifecycle, ...rest } = input
  await runInteractiveDeferredMode(rest, lifecycle ? { createRuntimeLifecycle: lifecycle } : undefined)
}
