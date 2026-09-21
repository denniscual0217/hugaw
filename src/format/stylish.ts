import { relative } from "node:path"
import type { RunStats, Truncation } from "../core/index.js"
import { countProblems } from "./to-eslint.js"
import type { Colors, EslintResult } from "./types.js"
import { usageClause } from "./usage.js"

export interface StylishContext {
  readonly cwd: string
  readonly colors: Colors
  readonly stats: RunStats
  readonly truncation?: Truncation
  /** Set when the run hit non-fatal errors: the result is not a clean bill of health. */
  readonly incompleteErrors?: number
}

function statsLine(stats: RunStats): string {
  const line = `${stats.candidates} candidates, ${stats.skippedStatically} skipped statically, ${stats.judged} judged`
  // Appended, never its own line: what a run cost belongs beside what it did.
  const usage = usageClause(stats)
  return usage === null ? line : `${line} · ${usage}`
}

/**
 * ESLint's stylish layout, with two additions the spec requires: the stats
 * line is always printed, and an empty result is unmistakable rather than
 * silent.
 */
export function stylish(results: readonly EslintResult[], context: StylishContext): string {
  const { cwd, colors, stats, truncation, incompleteErrors = 0 } = context
  const { errors, warnings, total } = countProblems(results)

  if (total === 0) {
    // Never report a clean bill of health for a run that did not finish:
    // the agent reading stdout would take it as "this file is fine".
    if (incompleteErrors > 0) {
      const noun = incompleteErrors === 1 ? "error" : "errors"
      return colors.yellow(
        `⚠ no findings, but the run was incomplete (${incompleteErrors} ${noun}; see stderr) · ${statsLine(stats)}`,
      )
    }
    return colors.green(`✓ no findings · ${statsLine(stats)}`)
  }

  const blocks: string[] = []
  for (const result of results) {
    const rows = result.messages.map((message) => ({
      position: `${message.line}:${message.column}`,
      severity: message.severity === 2 ? "error" : "warning",
      text: message.message,
      ruleId: message.ruleId ?? "",
    }))
    const positionWidth = Math.max(...rows.map((r) => r.position.length))
    const severityWidth = Math.max(...rows.map((r) => r.severity.length))
    const textWidth = Math.max(...rows.map((r) => r.text.length))

    const lines = rows.map((row) => {
      const severity = row.severity === "error" ? colors.red(row.severity) : colors.yellow(row.severity)
      const pad = " ".repeat(severityWidth - row.severity.length)
      return (
        `  ${colors.dim(row.position.padEnd(positionWidth))}  ${severity}${pad}` +
        `  ${row.text.padEnd(textWidth)}  ${colors.dim(row.ruleId)}`
      )
    })
    // Relative paths in the console: cheaper agent context (SPEC §4).
    blocks.push([colors.underline(relative(cwd, result.filePath) || result.filePath), ...lines].join("\n"))
  }

  const parts: string[] = [blocks.join("\n\n"), ""]

  const problems = `✖ ${total} ${total === 1 ? "problem" : "problems"} (${errors} ${
    errors === 1 ? "error" : "errors"
  }, ${warnings} ${warnings === 1 ? "warning" : "warnings"})`
  parts.push(errors > 0 ? colors.red(colors.bold(problems)) : colors.yellow(colors.bold(problems)))

  // Findings *and* errors still means the result is partial — an agent that
  // only reads stdout must not take this list as the complete picture.
  if (incompleteErrors > 0) {
    const noun = incompleteErrors === 1 ? "error" : "errors"
    parts.push(colors.yellow(`⚠ run incomplete (${incompleteErrors} ${noun}; see stderr)`))
  }

  if (truncation?.truncated === true) {
    parts.push(
      colors.dim(
        `… showing ${truncation.shown} of ${truncation.total} findings. Re-run with --max-findings 0 for the rest.`,
      ),
    )
  }
  parts.push(colors.dim(statsLine(stats)))

  return parts.join("\n")
}
