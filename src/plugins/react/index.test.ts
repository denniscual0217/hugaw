import { describe, expect, it } from "vitest"
import { createMockJudge } from "../../../test/helpers/mock-judge.js"
import type { MockScript } from "../../../test/helpers/mock-judge.js"
import { fixturePath, runFixture } from "../../../test/helpers/run-fixture.js"

/** Calibration case A: cheap constant work, no identity consumer. */
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
      "This useMemo does nothing. The computation is constant work",
      "`label` is only read at line 9",
      "Inline the expression and remove the dep array",
    ],
    absent: ["verify before removing", "The identity signal is weak"],
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
    contains: ["`slugify` is defined in another file and was not read. Check what it does before removing."],
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
    // Moved from should-skip/ when `skip` was deleted. A memoised template
    // literal has no reference identity to protect, so returning it from a
    // hook is not a reason to stay quiet — measured live at identity 0.14.
    file: "should-warn/returned-from-hook.tsx",
    line: 4,
    column: 17,
    contains: ["`label` is only read at line 5"],
  },
  {
    // Same, returned through a conditional. Measured live at identity 0.33.
    file: "should-warn/conditional-return-hook.tsx",
    line: 4,
    column: 17,
    contains: ["`label` is only read at line 5"],
  },
  {
    // Correction 10's class, as a real fixture: `parseInt` resolves to a
    // `.d.ts` in another file, and before the ambient rule every finding like
    // this one carried "1 callee (parseInt) is defined in another file". A
    // caveat naming a global everyone can already see is noise that teaches
    // an agent to skip the caveat line.
    file: "should-warn/ambient-callee.tsx",
    line: 9,
    column: 18,
    contains: ["`amount` is only read at line 11"],
    absent: ["is defined in another file", "verify before removing"],
  },
  {
    file: "should-warn/spread-usage.tsx",
    line: 4,
    column: 17,
    contains: ["1 of 1 usage is hidden behind a spread. Verify before removing."],
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
    contains: ["The identity signal is weak. Verify no consumer compares references."],
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
    // Calibration B vs D: the inlined callee body is what decides the verdict.
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
    // This fixture lives in should-pass/ because the live model judges
    // `transform(items)` as unbounded work. The caveat path it exercises is
    // still needed, so it is asserted here on a mock that keeps it cheap.
    const { judge, calls } = createMockJudge(CHEAP)
    const report = await runFixture("should-pass/prop-callee.tsx", { judge })

    expect(calls[0]!.state["callee_sources"]).toEqual({ resolved: {}, unresolved: ["transform"] })
    expect(report.findings.length).toBe(1)
    expect(report.findings[0]!.message).toContain(
      "`transform` is defined in another file and was not read. Check what it does before removing.",
    )
  })
})

describe("react/pointless-usememo — select still gates what is a candidate", () => {
  it("not-a-candidate/not-react-usememo.tsx never becomes a candidate", async () => {
    const { judge, calls } = createMockJudge(CHEAP)
    const report = await runFixture("not-a-candidate/not-react-usememo.tsx", { judge })

    // The one remaining zero-request assertion. `skip` is gone by design, but
    // `select` still decides what a candidate *is*: a `useMemo` that is not
    // React's own is not this rule's business and costs nothing.
    expect(report.stats.candidates).toBe(0)
    expect(calls.length).toBe(0)
    expect(report.stats.requests).toBe(0)
    expect(report.findings).toEqual([])
    expect(report.errors).toEqual([])
  })
})

interface SilentCase {
  readonly file: string
  readonly script: MockScript
}

/** Identity high enough to suppress; each value is what the live model returned. */
const identity = (noul: number): MockScript => () => ({ cost: 0.05, identity_matters: noul })

const SILENT_CASES: readonly SilentCase[] = [
  // Every one of these was a `skip` reason until the rule stopped
  // pre-judging. They now reach the model and are suppressed by
  // `identity_matters`, with the live figure recorded beside each.
  { file: "should-pass/memo-child-prop.tsx", script: identity(0.97) },
  { file: "should-pass/memo-child-cross-file.tsx", script: identity(0.97) },
  { file: "should-pass/dep-array.tsx", script: identity(0.93) },
  { file: "should-pass/custom-hook-dep-array.tsx", script: identity(0.92) },
  { file: "should-pass/member-access-dep-array.tsx", script: identity(0.88) },
  { file: "should-pass/context-provider-value.tsx", script: identity(0.85) },
  { file: "should-pass/context-react19-value.tsx", script: identity(0.84) },
  { file: "should-pass/hook-argument.tsx", script: identity(0.85) },
  { file: "should-pass/shadowed-hook.tsx", script: identity(0.45) },
  { file: "should-pass/assigned-to-ref.tsx", script: identity(0.95) },
  {
    // Live: score 1.30, mass 0.63, mode 2 — suppressed on mass.
    file: "should-pass/prop-callee.tsx",
    script: () => ({
      cost: { score: 1.3, probabilities: { "0": 0.35, "1": 0.02, "2": 0.6, "3": 0.03 } },
      identity_matters: 0.11,
    }),
  },
  {
    // Bimodal: 55% "unbounded prop array", 0% "bounded right here", yet the
    // expected score is 1.1 and rounds onto level 1. Deps equal the inputs,
    // so the coverage gate cannot fire — mass alone must suppress this.
    file: "should-pass/bimodal-map.tsx",
    script: () => ({
      cost: { score: 1.1, probabilities: { "0": 0.45, "1": 0, "2": 0.55, "3": 0 } },
      identity_matters: 0.1,
    }),
  },
  // Cost above COST_MAX — calibration case E.
  { file: "should-pass/sort-and-group.tsx", script: () => ({ cost: 2.4, identity_matters: 0.1 }) },
  // Confidence below MIN_CONFIDENCE.
  {
    file: "should-pass/low-confidence.tsx",
    script: () => ({ cost: { score: 0.5, confidence: 0.3 }, identity_matters: 0.1 }),
  },
  // Identity above IDENTITY_MATTERS_MAX — calibration case F.
  {
    file: "should-pass/identity-ambiguous.tsx",
    script: () => ({ cost: 0.1, identity_matters: 0.7 }),
  },
]

describe("react/pointless-usememo — the FilterableList false positive", () => {
  const FILE = "should-pass/filterable-list.tsx"

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

describe("react/pointless-usememo — should-pass (judged, not reported)", () => {
  it.each(SILENT_CASES)("$file reaches the model and reports nothing", async (testCase) => {
    const { judge, calls } = createMockJudge(testCase.script)
    const report = await runFixture(testCase.file, { judge })

    expect(calls.length).toBe(1)
    expect(report.stats.judged).toBe(1)
    expect(report.findings).toEqual([])
    expect(report.errors).toEqual([])
  })
})

/* ── react/useeffect-alternatives ────────────────────────────────────────── */

const EFFECT_RULE = "useeffect-alternatives"

/** The mock's default choice is `labels[0]` = `keep_effect`, which `decide`
 *  suppresses — so every case here scripts the answer and asserts the label. */
const replacing = (label: string): MockScript => () => ({ replacement: label })

describe("react/useeffect-alternatives — should-warn", () => {
  it("derived-state.tsx reports the canonical finding", async () => {
    const { judge, calls } = createMockJudge(replacing("render_computation"))
    const report = await runFixture("should-warn/derived-state.tsx", {
      judge,
      rule: EFFECT_RULE,
    })

    expect(report.errors).toEqual([])
    expect(calls.length).toBe(1)
    expect(report.findings.length).toBe(1)

    const finding = report.findings[0]!
    expect(finding.ruleId).toBe("react/useeffect-alternatives")
    expect(finding.messageId).toBe("replaceEffect")
    expect(finding.severity).toBe(1)
    expect(finding.nodeType).toBe("CallExpression")
    expect({ line: finding.loc.line, column: finding.loc.column }).toEqual({ line: 6, column: 3 })
    expect(finding.message).toBe(
      "This effect only sets `filtered` from `products`. " +
        "Compute it during render (use `useMemo` if the work is expensive) " +
        "and delete the state and the effect.",
    )
    expect(finding.facts["keepFamilyMass"]).toBe(0)
  })

  it("sends exactly the four context slices, and one question", async () => {
    const { judge, calls } = createMockJudge(replacing("render_computation"))
    await runFixture("should-warn/derived-state.tsx", { judge, rule: EFFECT_RULE })

    const request = calls[0]!
    expect(Object.keys(request.state).sort()).toEqual([
      "component_source",
      "component_state",
      "effect_body",
      "effect_call",
    ])
    expect(Object.keys(request.questions)).toEqual([
      "react/useeffect-alternatives::replacement",
    ])
  })

  it("editable-state-follows-prop.tsx picks the one fix that keeps it editable", async () => {
    // Measured live: `use_linked_state` 0.99. Before the criteria split this
    // file scored `derive_by_id` 0.56 / `render_computation` 0.27 — two fixes
    // that both delete the user's ability to type. The assertion is on the
    // label, not just the message, so a wording change that quietly moves the
    // mass back cannot pass.
    const { judge } = createMockJudge(replacing("use_linked_state"))
    const report = await runFixture("should-warn/editable-state-follows-prop.tsx", {
      judge,
      rule: EFFECT_RULE,
    })

    expect(report.errors).toEqual([])
    expect(report.findings.length).toBe(1)
    const finding = report.findings[0]!
    expect(finding.facts["replacement"]).toBe("use_linked_state")
    expect(finding.message).toContain("sets `name` from `user`")
    expect(finding.message).toContain("Keep it editable")
    expect(finding.message).toContain("`useLinkedState(user.id, …)`")
    // The two fixes that would break it must not appear.
    expect(finding.message).not.toContain("compute it during render")
    expect(finding.message).not.toContain("keep only the id in state")
  })

  it("unresolvable-write.tsx describes the call without claiming it is state", async () => {
    // `useState` is not imported here, so `isReactApi` refuses it and
    // `component_state.state` comes back empty. The finding used to read
    // "it does nothing this rule can name; … delete the state and the
    // effect" — a sentence that contradicts itself and prescribes a deletion
    // it has no basis for.
    const { judge } = createMockJudge(replacing("render_computation"))
    const report = await runFixture("should-warn/unresolvable-write.tsx", {
      judge,
      rule: EFFECT_RULE,
    })

    expect(report.errors).toEqual([])
    expect(report.findings.length).toBe(1)
    const finding = report.findings[0]!
    expect(finding.message).toContain("calls `setTotal(…)` with `items`")
    expect(finding.message).toContain(
      "`setTotal` looks like a state setter, but it came from a `useState` that does not " +
        "resolve to React's. Check this file's imports before removing.",
    )
    expect(finding.message).not.toContain("does nothing this rule can name")
    expect(finding.facts["statesWritten"]).toEqual([])
    expect(finding.facts["unresolvedWrites"]).toEqual(["setTotal"])
  })

  it("ref-callback-on-open.tsx routes a conditionally rendered node to a ref callback", async () => {
    // Measured live: `ref_callback` 0.98. The node exists only while
    // `isOpen` is true, which is precisely when React runs a ref callback.
    const { judge } = createMockJudge(replacing("ref_callback"))
    const report = await runFixture("should-warn/ref-callback-on-open.tsx", {
      judge,
      rule: EFFECT_RULE,
    })

    expect(report.errors).toEqual([])
    expect(report.findings.length).toBe(1)
    const finding = report.findings[0]!
    expect(finding.facts["replacement"]).toBe("ref_callback")
    expect(finding.message).toContain("Do the work in a ref callback")
    expect(finding.message).toContain("which React runs as the node is attached")
  })

  it("state-chain.tsx reports both links of the chain", async () => {
    // Two candidates in one component, so two slots and two requests.
    // Measured live the two links split: the second is
    // `collapse_to_handler` 0.58, the first is a near-tie that lands
    // `render_computation` 0.53 with `collapse_to_handler` 0.41 behind it.
    // docs/internals.md records that; what this asserts is that both effects
    // are found and both carry the label the judge returned.
    const { judge, calls } = createMockJudge(replacing("collapse_to_handler"))
    const report = await runFixture("should-warn/state-chain.tsx", {
      judge,
      rule: EFFECT_RULE,
    })

    expect(report.errors).toEqual([])
    expect(calls.length).toBe(2)
    expect(report.findings.length).toBe(2)
    for (const finding of report.findings) {
      expect(finding.facts["replacement"]).toBe("collapse_to_handler")
      expect(finding.message?.toLowerCase()).toContain("compute the whole next state in the handler")
    }
    expect(report.findings.map((f) => f.loc.line)).toEqual([19, 23])
  })

  it("setter-through-helper.tsx names the state the helper writes", async () => {
    // The reported case. The verdict was always right — 96% of the mass on
    // the two "this effect sets state" outcomes — but the sentence named
    // only the call, so it read as though we had missed the write.
    const { judge } = createMockJudge(replacing("collapse_to_handler"))
    const report = await runFixture("should-warn/setter-through-helper.tsx", {
      judge,
      rule: EFFECT_RULE,
    })

    expect(report.errors).toEqual([])
    expect(report.findings.length).toBe(1)
    const finding = report.findings[0]!
    expect(finding.message).toContain("calls `evaluateCount(count)`, which sets `finished`")
    // The fix has to know about it too, or it under-claims on the very case
    // the indirection exists for.
    expect(finding.facts["statesWritten"]).toEqual(["finished"])
    expect(finding.facts["indirect"]).toEqual([
      {
        callee: "evaluateCount",
        states: ["finished"],
        propCallbacks: [],
        outwardCalls: [],
        externals: [],
      },
    ])
  })

  it("fetch-cross-file.tsx caveats the callee it could not read", async () => {
    const { judge } = createMockJudge(replacing("data_library"))
    const report = await runFixture("should-warn/fetch-cross-file.tsx", {
      judge,
      rule: EFFECT_RULE,
    })

    expect(report.errors).toEqual([])
    expect(report.findings.length).toBe(1)
    const message = report.findings[0]!.message
    expect(message).toContain("calls `fetchProduct(productId)` and sets `product`")
    expect(message).toContain(
      "Replace the effect and the `product` state with the project's data-fetching hook",
    )
    expect(message).toContain(
      "`fetchProduct` is defined in another file and was not read. Check what it does before removing.",
    )
  })

  it("mount-sync-empty-deps.tsx reports the other messageId, gated the other way", async () => {
    const { judge } = createMockJudge(replacing("mount_effect"))
    const report = await runFixture("should-warn/mount-sync-empty-deps.tsx", {
      judge,
      rule: EFFECT_RULE,
    })

    expect(report.errors).toEqual([])
    expect(report.findings.length).toBe(1)
    const finding = report.findings[0]!
    expect(finding.messageId).toBe("wrapMountEffect")
    expect(finding.message).toContain("synchronises once on mount with `hostRef.current`")
    // `readsOutsideDeps` reaches the message only as a `key` suggestion and
    // never as "add it to the dependency array" — and here the length budget
    // spends it, because this fixture also carries an unresolved-callee
    // caveat, which is never dropped. The clause itself is covered in the
    // rule's own tests, where nothing crowds it out.
    expect(finding.message).not.toContain("dependency array")
    expect(finding.message).toContain("`createEditor` is defined in another file")
    expect(finding.facts["depsKind"]).toBe("empty")
    expect(finding.facts["hasCleanup"]).toBe(true)
  })
})

describe("react/useeffect-alternatives — should-pass and not-a-candidate", () => {
  it("websocket-subscription.tsx reaches the model and reports nothing", async () => {
    // Live, this is the highest-stakes case in the rule: keep_effect 0.98,
    // keep-family mass 0.98 (calibration case 1).
    const { judge, calls } = createMockJudge(
      () => ({ replacement: { choice: "keep_effect", probabilities: { keep_effect: 0.98, external_store: 0.02 } } }),
    )
    const report = await runFixture("should-pass/websocket-subscription.tsx", {
      judge,
      rule: EFFECT_RULE,
    })

    expect(calls.length).toBe(1)
    expect(report.stats.judged).toBe(1)
    expect(report.findings).toEqual([])
    expect(report.errors).toEqual([])
  })

  it("always-mounted-focus.tsx reaches the model and is refused", async () => {
    // The `ref_callback` negative. Live it is `keep_effect` 0.85 — the node
    // is never unmounted, so a ref callback would fire once and never again.
    // Scripted here at the measured distribution rather than one-hot, so the
    // gate is what suppresses it rather than the mock.
    const { judge, calls } = createMockJudge(() => ({
      replacement: {
        choice: "keep_effect",
        probabilities: { keep_effect: 0.85, ref_callback: 0.15 },
      },
    }))
    const report = await runFixture("should-pass/always-mounted-focus.tsx", {
      judge,
      rule: EFFECT_RULE,
    })

    expect(calls.length).toBe(1)
    expect(report.stats.judged).toBe(1)
    expect(report.findings).toEqual([])
    expect(report.errors).toEqual([])
  })

  it("not-react-useeffect.tsx never becomes a candidate", async () => {
    const { judge, calls } = createMockJudge(replacing("render_computation"))
    const report = await runFixture("not-a-candidate/not-react-useeffect.tsx", {
      judge,
      rule: EFFECT_RULE,
    })

    expect(report.stats.candidates).toBe(0)
    expect(calls.length).toBe(0)
    expect(report.stats.requests).toBe(0)
    expect(report.findings).toEqual([])
    expect(report.errors).toEqual([])
  })
})

describe("two rules over one unit — the batching proof", () => {
  it("batches a memo and an effect into a single request", async () => {
    // SPEC §2: batching is the runner's job. `dep-array.tsx` has one useMemo
    // and one useEffect in the same component, so the seven slices are built
    // once and both rules' questions ride on one request.
    const script: MockScript = () => ({
      cost: 0.1,
      identity_matters: 0.93,
      replacement: "keep_effect",
    })
    const { judge, calls } = createMockJudge(script)
    const report = await runFixture("should-pass/dep-array.tsx", { judge, ruleFilter: null })

    expect(report.errors).toEqual([])
    expect(calls.length).toBe(1)
    expect(report.stats.requests).toBe(1)
    // Two candidates in one request: `stats.judged` counts participants.
    expect(report.stats.judged).toBe(2)

    expect(Object.keys(calls[0]!.state).sort()).toEqual([
      "callee_sources",
      "component_source",
      "component_state",
      "effect_body",
      "effect_call",
      "memo_call",
      "value_usages",
    ])
    expect(Object.keys(calls[0]!.questions).sort()).toEqual([
      "react/pointless-usememo::cost",
      "react/pointless-usememo::identity_matters",
      "react/useeffect-alternatives::replacement",
    ])
    expect(report.findings).toEqual([])
  })
})
