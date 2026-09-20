import { describe, expect, it } from "vitest"
import type { Answers, Candidate, Slices, Verdict } from "../../../core/index.js"
import type { TsTypes } from "../../../adapters/typescript/index.js"
import type { MemoData } from "./memo-data.js"
import type { MemoFacts, MemoQuestions } from "./pointless-usememo.js"
import {
  buildMessage,
  COST_MAX,
  IDENTITY_MATTERS_MAX,
  MIN_CONFIDENCE,
  pointlessUseMemo,
} from "./pointless-usememo.js"

function answers(cost: number, confidence: number, identity: number): Answers<MemoQuestions> {
  return {
    cost: {
      type: "score",
      score: cost,
      confidence,
      probabilities: {},
      legend: {},
    },
    identity_matters: { type: "noul", noul: identity },
  }
}

function candidate(binding = "label"): Candidate<TsTypes, MemoData> {
  return {
    data: { binding: { getText: () => binding } },
  } as unknown as Candidate<TsTypes, MemoData>
}

function slices(usageLines: number[] = [9], unresolvedCallees: string[] = []): Slices {
  return {
    value_usages: usageLines.map((line) => ({
      line,
      kind: "member-access",
      description: "read",
      resolved: true,
    })),
    callee_sources: { resolved: {}, unresolved: unresolvedCallees },
  }
}

/** Mixed resolved / spread / unclassified rows, to exercise the caveat split. */
function mixedSlices(): Slices {
  return {
    value_usages: [
      { line: 4, kind: "jsx-child", description: "read", resolved: true },
      { line: 5, kind: "spread", description: "spread", resolved: false },
      { line: 7, kind: "other", description: "unknown", resolved: false },
    ],
    callee_sources: { resolved: {}, unresolved: [] },
  }
}

function decide(cost: number, confidence: number, identity: number): Verdict<MemoFacts> | null {
  return pointlessUseMemo.decide(answers(cost, confidence, identity), {
    candidate: candidate(),
    slices: slices(),
  })
}

describe("pointless-usememo decide() thresholds", () => {
  const cases: { name: string; cost: number; confidence: number; identity: number; reports: boolean }[] = [
    { name: "cheap, confident, no identity need", cost: 0.0, confidence: 1.0, identity: 0.08, reports: true },
    // CALIBRATION.md case D — the inlined callee makes it cheap.
    { name: "calibration D", cost: 0.11, confidence: 0.89, identity: 0.08, reports: true },
    // CALIBRATION.md case E — a sort is not free.
    { name: "calibration E (cost)", cost: 2.0, confidence: 1.0, identity: 0.12, reports: false },
    // CALIBRATION.md case F — a context value must keep its identity.
    { name: "calibration F (identity)", cost: 0.0, confidence: 1.0, identity: 0.85, reports: false },
    { name: "identity exactly at the ceiling", cost: 0, confidence: 1, identity: IDENTITY_MATTERS_MAX, reports: true },
    { name: "identity just over the ceiling", cost: 0, confidence: 1, identity: IDENTITY_MATTERS_MAX + 0.01, reports: false },
    { name: "cost exactly at the ceiling", cost: COST_MAX, confidence: 1, identity: 0, reports: true },
    { name: "cost just over the ceiling", cost: COST_MAX + 0.01, confidence: 1, identity: 0, reports: false },
    { name: "confidence exactly at the floor", cost: 0, confidence: MIN_CONFIDENCE, identity: 0, reports: true },
    { name: "confidence just under the floor", cost: 0, confidence: MIN_CONFIDENCE - 0.01, identity: 0, reports: false },
  ]

  it.each(cases)("$name", ({ cost, confidence, identity, reports }) => {
    const verdict = decide(cost, confidence, identity)
    expect(verdict === null).toBe(!reports)
  })

  it("identity is checked before cost, so a legitimate expensive memo stays silent", () => {
    // Both gates would fire; the rule must not report either way.
    expect(decide(3, 1, 0.9)).toBeNull()
  })

  it("counts spread and unclassifiable usages separately", () => {
    const verdict = pointlessUseMemo.decide(answers(0.1, 0.9, 0.05), {
      candidate: candidate(),
      slices: mixedSlices(),
    })
    expect(verdict?.facts.usageCount).toBe(3)
    expect(verdict?.facts.spreadUsages).toBe(1)
    expect(verdict?.facts.unclassifiedUsages).toBe(1)
    expect(verdict?.facts.unclassifiedLines).toEqual([7])
    expect(verdict?.message).toContain("1 of 3 usages unresolved behind a spread")
    expect(verdict?.message).toContain("1 of 3 usages could not be classified (line 7)")
  })

  it("exposes the facts the message and config overrides are built from", () => {
    const verdict = pointlessUseMemo.decide(answers(0.1, 0.9, 0.05), {
      candidate: candidate("price"),
      slices: slices([4, 9, 9], ["slugify"]),
    })
    expect(verdict?.facts).toEqual({
      binding: "price",
      costScore: 0.1,
      costLevel: 0,
      costConfidence: 0.9,
      identityMatters: 0.05,
      usageLines: [4, 9],
      usageCount: 3,
      spreadUsages: 0,
      unclassifiedUsages: 0,
      unclassifiedLines: [],
      unresolvedCallees: ["slugify"],
    })
    expect(verdict?.messageId).toBe("pointlessUseMemo")
  })
})

describe("pointless-usememo message", () => {
  const base: MemoFacts = {
    binding: "label",
    costScore: 0.1,
    costLevel: 0,
    costConfidence: 0.9,
    identityMatters: 0.05,
    usageLines: [3],
    usageCount: 1,
    spreadUsages: 0,
    unclassifiedUsages: 0,
    unclassifiedLines: [],
    unresolvedCallees: [],
  }

  it("matches the SPEC example", () => {
    expect(buildMessage(base)).toBe(
      "useMemo has no effect — constant work, and `label` is only read at line 3; " +
        "inline the expression and remove the dep array",
    )
  })

  it("pluralises the read lines", () => {
    expect(buildMessage({ ...base, usageLines: [4, 9], usageCount: 2 })).toContain(
      "`label` is only read at lines 4, 9",
    )
  })

  it("says so when the value is never read", () => {
    expect(buildMessage({ ...base, usageLines: [], usageCount: 0 })).toContain("`label` is never read")
  })

  it("describes a single pass at cost level 1", () => {
    expect(buildMessage({ ...base, costScore: 0.9, costLevel: 1 })).toContain(
      "a single pass over a small collection",
    )
  })

  it("appends a caveat only for a real blind spot", () => {
    expect(buildMessage(base)).not.toContain("verify before removing")

    expect(buildMessage({ ...base, unresolvedCallees: ["slugify"] })).toContain(
      "1 callee (slugify) unresolved across files — verify before removing",
    )
    expect(buildMessage({ ...base, unresolvedCallees: ["a", "b"] })).toContain(
      "2 callees (a, b) unresolved across files",
    )
    expect(buildMessage({ ...base, usageCount: 5, spreadUsages: 2 })).toContain(
      "2 of 5 usages unresolved behind a spread — verify before removing",
    )
    // A usage we simply could not place must not be reported as a spread.
    const unclassified = buildMessage({
      ...base,
      usageCount: 3,
      unclassifiedUsages: 1,
      unclassifiedLines: [7],
    })
    expect(unclassified).toContain(
      "1 of 3 usages could not be classified (line 7) — verify before removing",
    )
    expect(unclassified).not.toContain("behind a spread")
    expect(buildMessage({ ...base, identityMatters: 0.3 })).toContain(
      "weak identity signal (30%) — verify no consumer compares references",
    )
    // 0.2 and below is noise, not a blind spot.
    expect(buildMessage({ ...base, identityMatters: 0.2 })).not.toContain("weak identity signal")
  })
})
