import { typescriptAdapter } from "../adapters/typescript/index.js"
import type { LanguageAdapter, Plugin } from "../core/index.js"
import { react } from "../plugins/react/index.js"

/** What you get with no `hugaw.config.ts` at all. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous adapter list
export const defaultAdapters: LanguageAdapter<any, any>[] = [typescriptAdapter]
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous plugin list
export const defaultPlugins: Plugin<any>[] = [react]

export function defaultConfigObject(): Record<string, unknown> {
  return { plugins: defaultPlugins }
}
