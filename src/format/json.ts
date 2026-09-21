import type { EslintResult, EslintRulesMeta } from "./types.js"
import type { UsageMetadata } from "./usage.js"

/** ESLint's result schema verbatim. Nothing but JSON goes to stdout. */
export function json(results: readonly EslintResult[]): string {
  return JSON.stringify(results, null, 2)
}

export interface JsonMetadata {
  readonly rulesMeta: EslintRulesMeta
  readonly usage: UsageMetadata
}

/**
 * ESLint's own `json-with-metadata` shape: `{ results, metadata }`.
 *
 * A separate formatter rather than a key added to `json`, because `json` is
 * a contract — `LintResult[]`, the array every CI consumer indexes into —
 * and wrapping or extending it would break them silently. Callers who want
 * the usage numbers opt in by name.
 */
export function jsonWithMetadata(
  results: readonly EslintResult[],
  metadata: JsonMetadata,
): string {
  return JSON.stringify({ results, metadata }, null, 2)
}
