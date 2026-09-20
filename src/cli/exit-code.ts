import type { RunReport } from "../core/index.js"

export interface ExitCodeOptions {
  /** ESLint semantics: -1 disables the warning ceiling. */
  readonly maxWarnings: number
}

/**
 * 2 — the run is incomplete (config error, adapter failure, judge error).
 * 1 — an error-severity finding, or warnings above the ceiling.
 * 0 — clean, or warnings only.
 */
export function computeExitCode(report: RunReport, options: ExitCodeOptions): number {
  if (report.errors.length > 0) return 2

  const errors = report.findings.filter((f) => f.severity === 2).length
  if (errors > 0) return 1

  const warnings = report.findings.filter((f) => f.severity === 1).length
  if (options.maxWarnings >= 0 && warnings > options.maxWarnings) return 1

  return 0
}
