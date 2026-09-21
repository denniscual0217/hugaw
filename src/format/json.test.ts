import { describe, expect, it } from "vitest"
import { json, jsonWithMetadata } from "./json.js"
import type { EslintResult } from "./types.js"

const RESULT: EslintResult = {
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
}

describe("--format json is a contract", () => {
  it("is exactly the LintResult array, byte for byte", () => {
    // Every CI consumer indexes into this array. Adding a sibling key or
    // wrapping it — however useful the addition — breaks them silently, so
    // the usage numbers went into a second formatter instead.
    expect(json([RESULT])).toBe(JSON.stringify([RESULT], null, 2))
  })

  it("is an array at the top level, not an object", () => {
    expect(JSON.parse(json([RESULT]))).toBeInstanceOf(Array)
    expect(json([])).toBe("[]")
  })
})

describe("--format json-with-metadata", () => {
  const metadata = {
    rulesMeta: {
      "react/pointless-usememo": { type: "suggestion", docs: { description: "…" } },
    },
    usage: {
      model: "jev-1.13.0",
      requests: 38,
      inputTokens: 133_402,
      outputTokens: 4_180,
      estimatedCostUsd: 0.005603,
      rate: { inputPerMTok: 0.042, outputPerMTok: 0 },
    },
  }

  it("keeps the results array untouched under a `results` key", () => {
    const parsed = JSON.parse(jsonWithMetadata([RESULT], metadata)) as {
      results: EslintResult[]
      metadata: typeof metadata
    }
    expect(parsed.results).toEqual([RESULT])
    // The same array, verbatim: switching formats must not change a finding.
    expect(JSON.stringify(parsed.results, null, 2)).toBe(json([RESULT]))
  })

  it("carries the usage record beside the rule metadata", () => {
    const parsed = JSON.parse(jsonWithMetadata([], metadata)) as { metadata: typeof metadata }
    expect(parsed.metadata.usage).toEqual(metadata.usage)
    expect(Object.keys(parsed.metadata).sort()).toEqual(["rulesMeta", "usage"])
  })
})
