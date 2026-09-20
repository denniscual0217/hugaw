import { describe, expect, it } from "vitest"
import { createMockJudge } from "../../../test/helpers/mock-judge.js"
import type { MockScript } from "../../../test/helpers/mock-judge.js"
import { fixturePath, runFixture } from "../../../test/helpers/run-fixture.js"

/** CALIBRATION.md case A: cheap constant work, no identity consumer. */
const CHEAP: MockScript = () => ({ cost: 0.1, identity_matters: 0.05 })

interface WarnCase {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly contains: readonly string[]
  readonly absent?: readonly string[]
  readonly script?: MockScript
}

const WARN_CASES: readonly WarnCase[] = [
  {
    file: "should-warn/constant-object.tsx",
    line: 8,
    column: 17,
    contains: [
      "useMemo has no effect — constant work",
      "`label` is only read at line 9",
      "inline the expression and remove the dep array",
    ],
    absent: ["verify before removing", "weak identity signal"],
  },
  {
    file: "should-warn/string-format.tsx",
    line: 4,
    column: 17,
    contains: ["`label` is only read at lines 7, 12"],
  },
  {
    file: "should-warn/arithmetic.tsx",
    line: 4,
    column: 16,
    contains: ["`area` is only read at line 5"],
  },
  {
    file: "should-warn/plain-child-prop.tsx",
    line: 8,
    column: 16,
    contains: ["`info` is only read at line 9"],
  },
  {
    file: "should-warn/cross-file-callee.tsx",
    line: 5,
    column: 16,
    contains: ["1 callee (slugify) unresolved across files — verify before removing"],
  },
  {
    // Over-skip regression: `return show && <em/>` is the everyday render
    // guard — a truthiness test, not an escape from the component.
    file: "should-warn/logical-and-guard.tsx",
    line: 4,
    column: 16,
    contains: ["`show` is only read at line 5"],
    absent: ["verify before removing"],
  },
  {
    // Over-skip regression: useState reads its initial value once on mount
    // and never compares it, so the memo buys nothing.
    file: "should-warn/usestate-initial.tsx",
    line: 4,
    column: 19,
    contains: ["`initial` is only read at line 5"],
    absent: ["verify before removing"],
  },
  {
    // Guards the cost-rubric rewrite: a collection whose size is bounded in
    // view is still level-1 work, and still a pointless memo.
    file: "should-warn/bounded-literal.tsx",
    line: 4,
    column: 18,
    contains: ["`values` is only read at line 5"],
  },
  {
    file: "should-warn/spread-usage.tsx",
    line: 4,
    column: 17,
    contains: ["1 of 1 usages unresolved behind a spread — verify before removing"],
  },
  {
    file: "should-warn/react-namespace.tsx",
    line: 4,
    column: 20,
    contains: ["`greeting` is only read at line 5"],
  },
  {
    file: "should-warn/weak-identity-caveat.tsx",
    line: 4,
    column: 17,
    contains: ["weak identity signal (30%) — verify no consumer compares references"],
    script: () => ({ cost: 0.1, identity_matters: 0.3 }),
  },
]

describe("react/pointless-usememo — should-warn", () => {
  it.each(WARN_CASES)("$file reports exactly one finding", async (testCase) => {
    const { judge, calls } = createMockJudge(testCase.script ?? CHEAP)
    const report = await runFixture(testCase.file, { judge })

    expect(report.errors).toEqual([])
    expect(calls.length).toBe(1)
    expect(report.findings.length).toBe(1)

    const finding = report.findings[0]!
    expect(finding.ruleId).toBe("react/pointless-usememo")
    expect(finding.messageId).toBe("pointlessUseMemo")
    expect(finding.severity).toBe(1)
    expect(finding.nodeType).toBe("CallExpression")
    expect(finding.filePath).toBe(fixturePath(testCase.file))
    expect({ line: finding.loc.line, column: finding.loc.column }).toEqual({
      line: testCase.line,
      column: testCase.column,
    })
    for (const needle of testCase.contains) expect(finding.message).toContain(needle)
    for (const needle of testCase.absent ?? []) expect(finding.message).not.toContain(needle)
  })

  it("sends all four context slices in one request", async () => {
    const { judge, calls } = createMockJudge(CHEAP)
    await runFixture("should-warn/constant-object.tsx", { judge })

    const request = calls[0]!
    expect(Object.keys(request.state).sort()).toEqual([
      "callee_sources",
      "component_source",
      "memo_call",
      "value_usages",
    ])
    expect(Object.keys(request.questions).sort()).toEqual([
      "react/pointless-usememo::cost",
      "react/pointless-usememo::identity_matters",
    ])
    // CALIBRATION.md B vs D: the inlined callee body is what decides the verdict.
    expect(JSON.stringify(request.state["callee_sources"])).toContain("function format")
    expect(request.model).toBe("jev-1.13.0")
  })

  it("describes a jsx child with the real tag name, not `<?>`", async () => {
    const { judge, calls } = createMockJudge(CHEAP)
    await runFixture("should-warn/arithmetic.tsx", { judge })

    expect(calls[0]!.state["value_usages"]).toEqual([
      {
        line: 5,
        kind: "jsx-child",
        description: "`area` rendered as a child of <span>",
        resolved: true,
      },
    ])
  })

  it("describes a jsx prop and a member read distinctly", async () => {
    const { judge, calls } = createMockJudge(CHEAP)
    await runFixture("should-warn/string-format.tsx", { judge })

    const usages = calls[0]!.state["value_usages"] as { kind: string; description: string }[]
    expect(usages.map((u) => u.kind)).toEqual(["jsx-child", "jsx-prop"])
    expect(usages[0]!.description).toBe("`label` rendered as a child of <span>")
    expect(usages[1]!.description).toBe("`label` passed as prop `title` to <span>")
  })

  it("records a prop-bound callee as unresolved, and caveats the message", async () => {
    // This fixture lives in should-stay-silent/ because the live model judges
    // `transform(items)` as unbounded work. The caveat path it exercises is
    // still needed, so it is asserted here on a mock that keeps it cheap.
    const { judge, calls } = createMockJudge(CHEAP)
    const report = await runFixture("should-stay-silent/prop-callee.tsx", { judge })

    expect(calls[0]!.state["callee_sources"]).toEqual({ resolved: {}, unresolved: ["transform"] })
    expect(report.findings.length).toBe(1)
    expect(report.findings[0]!.message).toContain(
      "1 callee (transform) unresolved across files — verify before removing",
    )
  })
})

interface SkipCase {
  readonly file: string
  readonly reason: string
}

const SKIP_CASES: readonly SkipCase[] = [
  {
    file: "should-skip/memo-child-prop.tsx",
    reason: "passed as prop to React.memo component <Child>",
  },
  {
    file: "should-skip/memo-child-cross-file.tsx",
    reason: "passed as prop to React.memo component <MemoChild>",
  },
  { file: "should-skip/dep-array.tsx", reason: "listed in dependency array of useEffect" },
  {
    // Defect #1: the field of a memoized object inherits its identity, so
    // `[data.items]` is every bit as dependency-sensitive as `[data]`.
    file: "should-skip/member-access-dep-array.tsx",
    reason: "listed in dependency array of useEffect",
  },
  { file: "should-skip/hook-argument.tsx", reason: "passed as an argument to hook useQuery" },
  {
    // A local `useState` is not React's: we must not assert React semantics
    // about it, so it counts as an unknown hook and skips.
    file: "should-skip/shadowed-hook.tsx",
    reason: "passed as an argument to hook useState",
  },
  {
    file: "should-skip/custom-hook-dep-array.tsx",
    reason: "listed in dependency array of useDebounced",
  },
  {
    file: "should-skip/context-provider-value.tsx",
    reason: "used as context value on <ThemeContext.Provider>",
  },
  {
    file: "should-skip/context-react19-value.tsx",
    reason: "used as context value on <LocaleContext>",
  },
  {
    file: "should-skip/returned-from-hook.tsx",
    reason: "memoized value escapes the component (returned or assigned outward)",
  },
  {
    // A hook whose contract is returning the value, via a conditional.
    file: "should-skip/conditional-return-hook.tsx",
    reason: "memoized value escapes the component (returned or assigned outward)",
  },
]

describe("react/pointless-usememo — should-skip (zero API calls)", () => {
  it.each(SKIP_CASES)("$file is dropped statically", async (testCase) => {
    const { judge, calls } = createMockJudge(CHEAP)
    const report = await runFixture(testCase.file, { judge })

    // The cost model: a skipped candidate must never reach the judge.
    expect(calls.length).toBe(0)
    expect(report.stats.judged).toBe(0)
    expect(report.stats.requests).toBe(0)
    expect(report.findings).toEqual([])
    expect(report.errors).toEqual([])
    expect(report.stats.candidates).toBe(1)
    expect(report.stats.skippedStatically).toBe(1)
    expect(report.skipped.map((s) => s.reason)).toEqual([testCase.reason])
  })

  it("should-skip/not-react-usememo.tsx never becomes a candidate", async () => {
    const { judge, calls } = createMockJudge(CHEAP)
    const report = await runFixture("should-skip/not-react-usememo.tsx", { judge })

    expect(report.stats.candidates).toBe(0)
    expect(report.stats.skippedStatically).toBe(0)
    expect(calls.length).toBe(0)
    expect(report.findings).toEqual([])
    expect(report.errors).toEqual([])
  })
})

interface SilentCase {
  readonly file: string
  readonly script: MockScript
}

const SILENT_CASES: readonly SilentCase[] = [
  {
    // Live: score 1.30, mass 0.63, mode 2 — suppressed on mass.
    file: "should-stay-silent/prop-callee.tsx",
    script: () => ({
      cost: { score: 1.3, probabilities: { "0": 0.35, "1": 0.02, "2": 0.6, "3": 0.03 } },
      identity_matters: 0.11,
    }),
  },
  {
    // Bimodal: 55% "unbounded prop array", 0% "bounded right here", yet the
    // expected score is 1.1 and rounds onto level 1. Deps equal the inputs,
    // so the coverage gate cannot fire — mass alone must suppress this.
    file: "should-stay-silent/bimodal-map.tsx",
    script: () => ({
      cost: { score: 1.1, probabilities: { "0": 0.45, "1": 0, "2": 0.55, "3": 0 } },
      identity_matters: 0.1,
    }),
  },
  // Cost above COST_MAX — CALIBRATION.md case E.
  { file: "should-stay-silent/sort-and-group.tsx", script: () => ({ cost: 2.4, identity_matters: 0.1 }) },
  // Confidence below MIN_CONFIDENCE.
  {
    file: "should-stay-silent/low-confidence.tsx",
    script: () => ({ cost: { score: 0.5, confidence: 0.3 }, identity_matters: 0.1 }),
  },
  // Identity above IDENTITY_MATTERS_MAX — CALIBRATION.md case F.
  {
    file: "should-stay-silent/identity-ambiguous.tsx",
    script: () => ({ cost: 0.1, identity_matters: 0.7 }),
  },
]

describe("react/pointless-usememo — the FilterableList false positive", () => {
  const FILE = "should-stay-silent/filterable-list.tsx"

  /** Both memos at the same cost distribution, so only coverage differs. */
  const atMass = (mass: number): MockScript => () => ({
    cost: { score: 2 * mass, probabilities: { "0": 1 - mass, "1": 0, "2": mass, "3": 0 } },
    identity_matters: 0.1,
  })

  it("reports neither memo on the judgment the live model actually gives", async () => {
    const realistic: MockScript = (request) => {
      const memo = request.state["memo_call"] as { source: string }
      // Live: filter 2.02 mass 1.00, Set-build 2.09 mass 1.00.
      const score = memo.source.includes(".filter(") ? 2.02 : 2.09
      return {
        cost: { score, probabilities: { "0": 0, "1": 0, "2": 0.95, "3": 0.05 } },
        identity_matters: 0.1,
      }
    }
    const { judge, calls } = createMockJudge(realistic)
    const report = await runFixture(FILE, { judge })

    expect(report.errors).toEqual([])
    // Two candidates in one unit => two slots => two requests.
    expect(calls.length).toBe(2)
    expect(report.stats.candidates).toBe(2)
    expect(report.stats.judged).toBe(2)
    expect(report.findings).toEqual([])
  })

  // Only two outcomes remain to pin: below the mass bar everything reports,
  // above it everything is silent. There is no longer a middle band — the
  // coverage gate that used to occupy it was removed for want of a measured
  // threshold (see the note above the thresholds in the rule).
  it("below the mass bar, nothing suppresses either memo", async () => {
    const { judge } = createMockJudge(atMass(0.2))
    const report = await runFixture(FILE, { judge })
    expect(report.findings.map((f) => f.facts["binding"]).sort()).toEqual([
      "categories",
      "filteredItems",
    ])
  })

  it("above the mass bar, mass alone silences both", async () => {
    const { judge } = createMockJudge(atMass(0.55))
    const report = await runFixture(FILE, { judge })
    expect(report.findings).toEqual([])
  })

  it("carries the statically computed inputs as facts, excluding the setters", async () => {
    const { judge } = createMockJudge(atMass(0.2))
    const report = await runFixture(FILE, { judge })
    const byBinding = new Map(report.findings.map((f) => [f.facts["binding"], f.facts]))

    for (const facts of byBinding.values()) {
      expect(facts["renderTriggers"]).toEqual(["items", "searchTerm", "selectedCategory"])
    }
    // filteredItems depends on every input: no render provably skips it.
    expect(byBinding.get("filteredItems")?.["rendersWithUnchangedDeps"]).toBe(false)
    // categories depends on `items` alone, so typing in the search box
    // re-renders with its dep unchanged. Reported, not gated on: the signal
    // is carried in facts so it can be ablated later.
    expect(byBinding.get("categories")?.["rendersWithUnchangedDeps"]).toBe(true)
  })

  it("keeps the render triggers off the wire", async () => {
    const { judge, calls } = createMockJudge(atMass(0.2))
    await runFixture(FILE, { judge })
    for (const call of calls) {
      const memo = call.state["memo_call"] as Record<string, unknown>
      expect(Object.keys(memo).sort()).toEqual(["binding", "deps", "line", "source"])
    }
  })
})

describe("react/pointless-usememo — should-stay-silent (judged, not reported)", () => {
  it.each(SILENT_CASES)("$file reaches the model and reports nothing", async (testCase) => {
    const { judge, calls } = createMockJudge(testCase.script)
    const report = await runFixture(testCase.file, { judge })

    expect(calls.length).toBe(1)
    expect(report.stats.judged).toBe(1)
    expect(report.findings).toEqual([])
    expect(report.errors).toEqual([])
  })
})
