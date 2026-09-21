import type { JudgeRequest } from "./judge.js"
import type { Finding, Location } from "./types.js"

export interface SkipRecord {
  readonly ruleId: string
  readonly filePath: string
  readonly loc: Location
  /** The exact string the rule's `skip` returned. */
  readonly reason: string
}

export interface RequestCandidateRef {
  readonly ruleId: string
  readonly loc: Location
}

export interface RequestRecord {
  readonly unitKey: string
  readonly unitName: string
  readonly filePath: string
  readonly candidates: readonly RequestCandidateRef[]
  readonly request: JudgeRequest
  /** False when the judge declined (dry-run) or errored. */
  judged: boolean
}

export interface RunError {
  readonly message: string
  readonly fatal: boolean
  readonly filePath?: string
  readonly ruleId?: string
  readonly cause?: unknown
}

export interface RunStats {
  files: number
  candidates: number
  skippedStatically: number
  judged: number
  requests: number
  inputTokens: number
  outputTokens: number
  /**
   * The model the judge reported answering with, or null when nothing was
   * judged.
   *
   * The *resolved* id, not the configured one: `jev-latest` is an alias, and
   * pricing an alias against whatever it pointed at last is how a cost figure
   * becomes quietly wrong. Every request in a run goes to one configured
   * model, so the first id reported is the id for the run.
   */
  model: string | null
}

export interface RunReport {
  readonly findings: readonly Finding[]
  readonly skipped: readonly SkipRecord[]
  readonly requests: readonly RequestRecord[]
  readonly stats: RunStats
  readonly errors: readonly RunError[]
}

export interface Truncation {
  readonly shown: number
  readonly total: number
  readonly truncated: boolean
}

/**
 * `--max-findings` is a presentation concern, not a runner concern:
 * the run always produces every finding, the formatter announces the trim.
 */
export function truncateFindings(
  findings: readonly Finding[],
  max: number,
): { findings: readonly Finding[]; truncation: Truncation } {
  const total = findings.length
  if (!Number.isFinite(max) || max <= 0 || total <= max) {
    return { findings, truncation: { shown: total, total, truncated: false } }
  }
  return {
    findings: findings.slice(0, max),
    truncation: { shown: max, total, truncated: true },
  }
}

export function emptyStats(): RunStats {
  return {
    files: 0,
    candidates: 0,
    skippedStatically: 0,
    judged: 0,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    model: null,
  }
}
