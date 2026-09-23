import pc from "picocolors"
import { describe, expect, it } from "vitest"
import type { Finding, RunStats } from "../core/index.js"
import { emptyStats, truncateFindings } from "../core/index.js"
import { stylish } from "./stylish.js"
import { toEslint } from "./to-eslint.js"
import type { Colors } from "./types.js"

/** The CSI prefix every ANSI colour sequence starts with. */
const ANSI_CSI = `${String.fromCharCode(27)}[`

// Never colour in tests, and never rely on TTY heuristics.
const colors = pc.createColors(false) as unknown as Colors

function stats(overrides: Partial<RunStats> = {}): RunStats {
  return { ...emptyStats(), ...overrides }
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "react/pointless-usememo",
    severity: 1,
    messageId: "pointlessUseMemo",
    message:
      "This useMemo does nothing. The computation is constant work and `label` is only read at line 3. Inline the expression and remove the dep array.",
    filePath: "/repo/src/Price.tsx",
    loc: { line: 2, column: 17, endLine: 2, endColumn: 40 },
    nodeType: "CallExpression",
    facts: {},
    ...overrides,
  }
}

describe("stylish", () => {
  it("matches the SPEC §4 layout", () => {
    const output = stylish(toEslint([finding()]), {
      cwd: "/repo",
      colors,
      stats: stats({ candidates: 1, judged: 1 }),
    })
    expect(output).toBe(
      [
        "src/Price.tsx",
        "  2:17  warning  This useMemo does nothing. The computation is constant work and `label` is only read at line 3. Inline the expression and remove the dep array.  react/pointless-usememo",
        "",
        "✖ 1 problem (0 errors, 1 warning)",
        "1 candidates, 0 skipped statically, 1 judged",
      ].join("\n"),
    )
  })

  it("makes an empty result unmistakable", () => {
    const output = stylish([], {
      cwd: "/repo",
      colors,
      stats: stats({ candidates: 14, skippedStatically: 14 }),
    })
    expect(output).toBe("✓ no findings · 14 candidates, 14 skipped statically, 0 judged")
  })

  it("never claims a clean bill of health for an incomplete run", () => {
    const output = stylish([], {
      cwd: "/repo",
      colors,
      stats: stats({ candidates: 1 }),
      incompleteErrors: 1,
    })
    expect(output).not.toContain("✓")
    expect(output).toContain("⚠ no findings, but the run was incomplete (1 error; see stderr)")
  })

  it("flags an incomplete run even when there are findings to show", () => {
    const output = stylish(toEslint([finding()]), {
      cwd: "/repo",
      colors,
      stats: stats({ candidates: 3, judged: 1 }),
      incompleteErrors: 2,
    })
    // The list is partial; an agent reading only stdout must be told so.
    expect(output).toContain("⚠ run incomplete (2 errors; see stderr)")
    const lines = output.split("\n")
    expect(lines.indexOf("⚠ run incomplete (2 errors; see stderr)")).toBe(lines.length - 2)
  })

  it("emits no ANSI when colours are disabled", () => {
    const output = stylish(toEslint([finding()]), { cwd: "/repo", colors, stats: stats() })
    expect(output.includes(ANSI_CSI)).toBe(false)
  })

  it("announces truncation rather than trimming silently", () => {
    const all = [finding(), finding({ loc: { line: 9, column: 3, endLine: 9, endColumn: 20 } })]
    const { findings, truncation } = truncateFindings(all, 1)
    const output = stylish(toEslint(findings), {
      cwd: "/repo",
      colors,
      stats: stats({ candidates: 2, judged: 2 }),
      truncation,
    })
    expect(output).toContain(
      "… showing 1 of 2 findings. Re-run with --max-findings 0 for the rest.",
    )
  })

  it("aligns columns per file and counts errors separately", () => {
    const output = stylish(
      toEslint([
        finding({ message: "short", loc: { line: 2, column: 1, endLine: 2, endColumn: 4 } }),
        finding({
          severity: 2,
          message: "a much longer message",
          loc: { line: 100, column: 12, endLine: 100, endColumn: 20 },
        }),
      ]),
      { cwd: "/repo", colors, stats: stats() },
    )
    const lines = output.split("\n")
    // Both position columns pad to the width of the longest ("100:12").
    expect(lines[1]).toContain("  2:1     warning  short")
    expect(lines[2]).toContain("  100:12  error    a much longer message")
    expect(output).toContain("✖ 2 problems (1 error, 1 warning)")
  })

  it("uses paths relative to cwd (cheaper agent context)", () => {
    const output = stylish(toEslint([finding()]), { cwd: "/repo/src", colors, stats: stats() })
    expect(output.split("\n")[0]).toBe("Price.tsx")
  })
})
