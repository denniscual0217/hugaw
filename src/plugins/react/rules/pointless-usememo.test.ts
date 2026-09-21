import { Node, Project, SyntaxKind, ts } from "ts-morph"
import { describe, expect, it } from "vitest"
import type { Answers, Candidate, Slices, Verdict } from "../../../core/index.js"
import { unitOf } from "../../../adapters/typescript/units.js"
import type { TsTypes } from "../../../adapters/typescript/index.js"
import type { MemoData } from "./memo-data.js"
import type { MemoFacts, MemoQuestions } from "./pointless-usememo.js"
import {
  buildMessage,
  COST_MAX,
  IDENTITY_MATTERS_MAX,
  MIN_CONFIDENCE,
  pointlessUseMemo,
  UNBOUNDED_WORK_MASS_MIN,
  unboundedWorkMass,
  costMode,
} from "./pointless-usememo.js"

function answers(
  cost: number,
  confidence: number,
  identity: number,
  probabilities: Record<string, number> = {},
): Answers<MemoQuestions> {
  return {
    cost: {
      type: "score",
      score: cost,
      confidence,
      probabilities,
      legend: {},
    },
    identity_matters: { type: "noul", noul: identity },
  }
}

/** A cost distribution with `mass` sitting on the unbounded levels (2 and 3). */
function unboundedMass(mass: number): Record<string, number> {
  return { "0": 1 - mass, "1": 0, "2": mass, "3": 0 }
}

/**
 * A real candidate: `decide` computes the render-trigger coverage from the
 * AST, so these tests need genuine nodes rather than a stub.
 *
 * `skippedRenders` adds a piece of state the memo does not depend on, which
 * is what makes the dependency array a proper subset of the inputs.
 */
function candidate(binding = "label", skippedRenders = false): Candidate<TsTypes, MemoData> {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, allowJs: true, strict: false },
  })
  const state = skippedRenders ? 'const [q, setQ] = useState("");' : ""
  const source = project.createSourceFile(
    "t.tsx",
    `import { useMemo, useState } from "react"\n` +
      `function C({ items }) { ${state} const ${binding} = useMemo(() => items.map(f), [items]); return 1 }\n`,
  )
  const call = source
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find((c) => c.getExpression().getText() === "useMemo")!
  const declaration = call.getParent()
  const nameNode = Node.isVariableDeclaration(declaration) ? declaration.getNameNode() : null
  return {
    node: call,
    unit: unitOf(call)!,
    data: { binding: nameNode },
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
      // From the real component the candidate helper builds: one prop, and a
      // dependency array that covers it exactly.
      renderTriggers: ["items"],
      rendersWithUnchangedDeps: false,
    })
    expect(verdict?.messageId).toBe("pointlessUseMemo")
  })
})

describe("pointless-usememo — the unbounded-work gates", () => {
  // Expected score is held below COST_MAX throughout, so the cost gate is
  // never the thing doing the suppressing here.
  const verdictFor = (mass: number, skippedRenders: boolean) =>
    pointlessUseMemo.decide(answers(1.1, 0.9, 0.05, unboundedMass(mass)), {
      candidate: candidate("label", skippedRenders),
      slices: slices(),
    })

  it("suppresses on mass alone, whether or not renders skip work", () => {
    // Fix B: the dep array covering every input does not make "probably
    // unbounded work" weaker evidence of legitimacy.
    expect(verdictFor(UNBOUNDED_WORK_MASS_MIN + 0.01, false)).toBeNull()
    expect(verdictFor(UNBOUNDED_WORK_MASS_MIN + 0.01, true)).toBeNull()
    expect(verdictFor(0.9, false)).toBeNull()
  })

  it("applies one bar only: skipped renders do not lower it", () => {
    // A coverage gate at a lower bar was written and removed for want of a
    // measured threshold. Below the single bar, proof that renders skip the
    // work changes nothing — the work is probably small either way.
    const below = UNBOUNDED_WORK_MASS_MIN - 0.2
    expect(verdictFor(below, true)).not.toBeNull()
    expect(verdictFor(below, false)).not.toBeNull()
    // The signal is still computed and still reported.
    expect(verdictFor(below, true)?.facts.rendersWithUnchangedDeps).toBe(true)
    expect(verdictFor(below, false)?.facts.rendersWithUnchangedDeps).toBe(false)
  })

  it("reports when the mass says the collection is bounded", () => {
    expect(verdictFor(UNBOUNDED_WORK_MASS_MIN, false)).not.toBeNull()
    expect(verdictFor(UNBOUNDED_WORK_MASS_MIN, true)).not.toBeNull()
    expect(verdictFor(0, true)).not.toBeNull()
  })

  it("still reports constant work however often the deps are unchanged", () => {
    // Skipping nothing repeatedly is still skipping nothing.
    expect(verdictFor(0, true)).not.toBeNull()
  })

  it("treats a missing distribution as no evidence, leaving the cost gate to decide", () => {
    expect(unboundedWorkMass({})).toBe(0)
    expect(
      pointlessUseMemo.decide(answers(1.1, 0.9, 0.05), {
        candidate: candidate("label", true),
        slices: slices(),
      }),
    ).not.toBeNull()
  })

  it("exposes the computed inputs as facts", () => {
    expect(verdictFor(0, true)?.facts.renderTriggers).toEqual(["items", "q"])
    expect(verdictFor(0, true)?.facts.rendersWithUnchangedDeps).toBe(true)
    expect(verdictFor(0, false)?.facts.renderTriggers).toEqual(["items"])
    expect(verdictFor(0, false)?.facts.rendersWithUnchangedDeps).toBe(false)
  })
})

describe("costMode — the phrase follows the mass, not the rounded score", () => {
  it("picks the level the model actually put mass on", () => {
    expect(costMode({ "0": 0.1, "1": 0.9, "2": 0, "3": 0 }, 0.9)).toBe(1)
    expect(costMode({ "0": 0, "1": 0, "2": 0.95, "3": 0.05 }, 2.05)).toBe(2)
  })

  it("does not round onto a level the model gave zero mass", () => {
    // The reviewer's probe: score 1.1 rounds to 1, but level 1 got nothing.
    expect(costMode({ "0": 0.45, "1": 0, "2": 0.55, "3": 0 }, 1.1)).toBe(2)
    // Survives Fix B (mass 0.45), scores ~0.9 and would round to 1; the mode
    // is 0, so the phrase is "constant work" and never the level-1 claim.
    expect(costMode({ "0": 0.55, "1": 0, "2": 0.45, "3": 0 }, 0.9)).toBe(0)
  })

  it("breaks ties upward so the phrase never under-states the work", () => {
    expect(costMode({ "0": 0.5, "1": 0, "2": 0.5, "3": 0 }, 1)).toBe(2)
  })

  it("falls back to the rounded score with no distribution", () => {
    expect(costMode({}, 0.4)).toBe(0)
    expect(costMode({}, 1.1)).toBe(1)
  })

  it("never claims level 1 when level 1 has zero mass", () => {
    const distributions: Record<string, number>[] = [
      { "0": 0.45, "1": 0, "2": 0.55, "3": 0 },
      { "0": 0.55, "1": 0, "2": 0.45, "3": 0 },
      { "0": 0.5, "1": 0, "2": 0.5, "3": 0 },
      { "0": 0.6, "1": 0, "2": 0.2, "3": 0.2 },
      { "0": 0.34, "1": 0, "2": 0.33, "3": 0.33 },
    ]
    for (const probabilities of distributions) {
      const verdict = pointlessUseMemo.decide(answers(1.0, 0.9, 0.05, probabilities), {
        candidate: candidate(),
        slices: slices(),
      })
      if (verdict === null) continue
      expect(verdict.message, JSON.stringify(probabilities)).not.toContain("fixed right here")
    }
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
    renderTriggers: [],
    rendersWithUnchangedDeps: false,
  }

  it("describes level 1 as a collection bounded in view", () => {
    expect(buildMessage({ ...base, costScore: 0.9, costLevel: 1 })).toContain(
      "one pass over a collection whose size is fixed right here",
    )
  })

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
      "weak identity signal — verify no consumer compares references",
    )
    // 0.2 and below is noise, not a blind spot.
    expect(buildMessage({ ...base, identityMatters: 0.2 })).not.toContain("weak identity signal")
  })
})
