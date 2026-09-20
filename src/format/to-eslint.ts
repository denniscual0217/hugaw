import type { Finding } from "../core/index.js"
import type { EslintMessage, EslintResult } from "./types.js"

/** Absolute paths in JSON (SPEC §4); relative paths are a stylish-only nicety. */
export function toEslint(findings: readonly Finding[]): EslintResult[] {
  const byFile = new Map<string, EslintMessage[]>()

  for (const finding of findings) {
    const message: EslintMessage = {
      ruleId: finding.ruleId,
      severity: finding.severity,
      message: finding.message,
      messageId: finding.messageId,
      line: finding.loc.line,
      column: finding.loc.column,
      endLine: finding.loc.endLine,
      endColumn: finding.loc.endColumn,
      nodeType: finding.nodeType,
    }
    const bucket = byFile.get(finding.filePath)
    if (bucket) bucket.push(message)
    else byFile.set(finding.filePath, [message])
  }

  return [...byFile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filePath, messages]) => ({
      filePath,
      messages,
      suppressedMessages: [],
      errorCount: messages.filter((m) => m.severity === 2).length,
      fatalErrorCount: 0,
      warningCount: messages.filter((m) => m.severity === 1).length,
      fixableErrorCount: 0,
      fixableWarningCount: 0,
      usedDeprecatedRules: [],
    }))
}

export function countProblems(results: readonly EslintResult[]): {
  errors: number
  warnings: number
  total: number
} {
  const errors = results.reduce((sum, r) => sum + r.errorCount, 0)
  const warnings = results.reduce((sum, r) => sum + r.warningCount, 0)
  return { errors, warnings, total: errors + warnings }
}
