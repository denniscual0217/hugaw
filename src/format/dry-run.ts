import { relative } from "node:path"
import type { RunReport } from "../core/index.js"

/**
 * The exact payloads that would be sent, and nothing else. This is how every
 * bad finding gets debugged later, so it prints the whole request — state,
 * questions and model — not a summary of it.
 */
export function dryRun(report: RunReport, cwd: string): string {
  return JSON.stringify(
    {
      requests: report.requests.map((record) => ({
        unit: record.unitName,
        file: relative(cwd, record.filePath) || record.filePath,
        candidates: record.candidates.map((c) => ({
          ruleId: c.ruleId,
          line: c.loc.line,
          column: c.loc.column,
        })),
        request: {
          model: record.request.model,
          state: record.request.state,
          questions: record.request.questions,
        },
      })),
      skipped: report.skipped.map((skip) => ({
        ruleId: skip.ruleId,
        file: relative(cwd, skip.filePath) || skip.filePath,
        line: skip.loc.line,
        column: skip.loc.column,
        reason: skip.reason,
      })),
      stats: report.stats,
    },
    null,
    2,
  )
}
