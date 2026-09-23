import { describe, expect, it } from "vitest"
import { REPLACEMENTS, effectQuestionsWith, fixOverridesOf, replacementsWith } from "./effect-questions.js"
import { applyFixTemplate, useEffectAlternatives } from "./useeffect-alternatives.js"
import type { EffectFacts } from "./useeffect-alternatives.js"

const FACTS = {
  owner: "ProductPage",
  ownerKind: "component",
  depsKind: "list",
  deps: ["productId"],
  hasCleanup: false,
  replacement: "data_library",
  replacementMass: 1,
  keepFamilyMass: 0,
  runnerUp: null,
  runnerUpMass: 0,
  choiceConfidence: 0.9,
  probabilities: {},
  statesWritten: ["product"],
  setterInputs: [],
  unresolvedWrites: [],
  unresolvedWriteInputs: [],
  unresolvedWriteHook: null,
  propCallbacksCalled: [],
  outwardCalls: ["fetchProduct(productId)"],
  indirect: [],
  externals: [],
  unresolvedCallees: [],
  readsOutsideDeps: [],
  callbackName: null,
  callbackResolved: true,
} satisfies EffectFacts

describe("replacementsWith", () => {
  it("replaces a criterion and leaves every other label alone", () => {
    const merged = replacementsWith({ data_library: "Ours fetches differently." })
    expect(merged.data_library).toBe("Ours fetches differently.")
    expect(merged.keep_effect).toBe(REPLACEMENTS.keep_effect)
    expect(Object.keys(merged)).toEqual(Object.keys(REPLACEMENTS))
  })

  it("ignores a label the rule does not have", () => {
    // `reviewOptions` rejects it at load; the merge simply never invents one,
    // because a new label would need a fix phrase config cannot supply.
    expect(replacementsWith({ made_up: "x" })).toEqual({ ...REPLACEMENTS })
  })

  it("builds the identical object when nothing is overridden", () => {
    expect(replacementsWith(undefined)).toEqual({ ...REPLACEMENTS })
    expect(effectQuestionsWith(undefined).replacement.criteria).toBe(REPLACEMENTS)
  })

  it("takes the criterion from the object form and the fix separately", () => {
    const overrides = { data_library: { criterion: "Ours.", fix: "use the generated hook" } }
    expect(replacementsWith(overrides).data_library).toBe("Ours.")
    expect(fixOverridesOf(overrides)).toEqual({ data_library: "use the generated hook" })
  })
})

describe("a config fix template", () => {
  it("resolves the placeholders from facts", () => {
    expect(applyFixTemplate("replace the effect and delete {state}", FACTS)).toBe(
      "replace the effect and delete the `product` state",
    )
  })

  it("drops the clause whose placeholder cannot resolve", () => {
    // Not a hole, not an empty string. This is the same degrade the built-in
    // phrases perform through `describeWritten`, which is the whole reason a
    // flat string was not enough on its own.
    const noState = { ...FACTS, statesWritten: [] }
    expect(
      applyFixTemplate("use the generated hook for this request, and delete {state}", noState),
    ).toBe("use the generated hook for this request")
  })

  it("returns null when every clause drops, so the caller keeps the built-in", () => {
    expect(applyFixTemplate("delete {state}", { ...FACTS, statesWritten: [] })).toBe(null)
  })

  it("resolves a plain fact name too, as `message` already does", () => {
    expect(applyFixTemplate("rework {owner}", FACTS)).toBe("rework ProductPage")
  })
})

describe("reviewOptions", () => {
  const review = (replacements: Record<string, unknown>) =>
    useEffectAlternatives.reviewOptions!({ extends: { replacements } } as never)

  it("passes a valid override and names what changed", () => {
    const { errors, notice } = review({
      external_store: "x",
      data_library: { criterion: "y", fix: "z" },
    })
    expect(errors).toEqual([])
    expect(notice).toBe(
      "react/useeffect-alternatives: overriding 2 criteria (external_store, data_library) " +
        "and 1 fix (data_library) from config; thresholds were measured against the built-in set",
    )
  })

  it("rejects a label the rule does not have, and lists the valid ones", () => {
    const { errors } = review({ data_libary: "typo" })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('"data_libary" is not a replacement of this rule')
    expect(errors[0]).toContain("data_library")
  })

  it("rejects an em-dash in a fix, which the built-in messages do not use", () => {
    const { errors } = review({ data_library: { fix: "use the hook — it handles races" } })
    expect(errors[0]).toContain("not an em-dash")
  })

  it("says nothing at all when there is no extends block", () => {
    expect(useEffectAlternatives.reviewOptions!({})).toEqual({ errors: [] })
  })
})
