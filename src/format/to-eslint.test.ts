import { describe, expect, it } from "vitest"
import type { Finding } from "../core/index.js"
import { countProblems, toEslint } from "./to-eslint.js"

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "react/pointless-usememo",
    severity: 1,
    messageId: "pointlessUseMemo",
    message: "useMemo has no effect",
    filePath: "/repo/src/Price.tsx",
    loc: { line: 2, column: 17, endLine: 2, endColumn: 40 },
    nodeType: "CallExpression",
    facts: {},
    ...overrides,
  }
}

describe("toEslint", () => {
  it("emits ESLint's result schema verbatim", () => {
    expect(toEslint([finding()])).toEqual([
      {
        filePath: "/repo/src/Price.tsx",
        messages: [
          {
            ruleId: "react/pointless-usememo",
            severity: 1,
            message: "useMemo has no effect",
            messageId: "pointlessUseMemo",
            line: 2,
            column: 17,
            endLine: 2,
            endColumn: 40,
            nodeType: "CallExpression",
          },
        ],
        suppressedMessages: [],
        errorCount: 0,
        fatalErrorCount: 0,
        warningCount: 1,
        fixableErrorCount: 0,
        fixableWarningCount: 0,
        usedDeprecatedRules: [],
      },
    ])
  })

  it("never emits a fix field", () => {
    const [result] = toEslint([finding()])
    expect(Object.hasOwn(result!.messages[0]!, "fix")).toBe(false)
    expect(Object.hasOwn(result!.messages[0]!, "suggestions")).toBe(false)
  })

  it("groups by file and counts each severity", () => {
    const results = toEslint([
      finding({ filePath: "/repo/b.tsx", severity: 2 }),
      finding({ filePath: "/repo/a.tsx" }),
      finding({ filePath: "/repo/a.tsx", severity: 2 }),
    ])
    expect(results.map((r) => r.filePath)).toEqual(["/repo/a.tsx", "/repo/b.tsx"])
    expect(results[0]).toMatchObject({ errorCount: 1, warningCount: 1 })
    expect(results[1]).toMatchObject({ errorCount: 1, warningCount: 0 })
    expect(countProblems(results)).toEqual({ errors: 2, warnings: 1, total: 3 })
  })

  it("keeps paths absolute (SPEC §4)", () => {
    expect(toEslint([finding()])[0]!.filePath).toBe("/repo/src/Price.tsx")
  })
})
