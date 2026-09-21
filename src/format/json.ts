import type { Facts, Finding, Location } from "../core/index.js"
import type { EslintResult, EslintRulesMeta } from "./types.js"
import type { UsageMetadata } from "./usage.js"

/** ESLint's result schema verbatim. Nothing but JSON goes to stdout. */
export function json(results: readonly EslintResult[]): string {
  return JSON.stringify(results, null, 2)
}

/**
 * One finding's evidence, in machine form.
 *
 * The messages deliberately carry no probabilities: a number a reader cannot
 * act on is our distribution leaking into their sentence. The numbers are
 * still real, and anything that computes on them — a calibration run, a
 * dashboard, an agent weighing whether to act — gets them here instead, with
 * enough location to join back onto the `results` array.
 */
export interface FindingMetadata {
  readonly ruleId: string
  readonly filePath: string
  readonly loc: Location
  readonly messageId: string
  readonly facts: Facts
}

export interface JsonMetadata {
  readonly rulesMeta: EslintRulesMeta
  readonly usage: UsageMetadata
  readonly findings: readonly FindingMetadata[]
}

/** Every fact a rule chose to expose, unfiltered — core does not read them. */
export function findingsMetadata(findings: readonly Finding[]): FindingMetadata[] {
  return findings.map((finding) => ({
    ruleId: finding.ruleId,
    filePath: finding.filePath,
    loc: finding.loc,
    messageId: finding.messageId,
    facts: finding.facts,
  }))
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
