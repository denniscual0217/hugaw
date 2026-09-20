import type { EslintResult } from "./types.js"

/** ESLint's result schema verbatim. Nothing but JSON goes to stdout. */
export function json(results: readonly EslintResult[]): string {
  return JSON.stringify(results, null, 2)
}
