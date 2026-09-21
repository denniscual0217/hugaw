import { describe, expect, it } from "vitest"
import { assertJson } from "../../../core/index.js"
import { KEEP_FAMILY, REPLACEMENTS, effectQuestions, replacement } from "./effect-questions.js"

const LABELS = Object.keys(REPLACEMENTS)

describe("the replacement Choice", () => {
  it("compiles structured criteria through `choice()` and puts them on the wire", () => {
    // Criteria have to survive `assertJson` or they never reach the model —
    // and that failure would happen at runtime, on a live request, not here.
    expect(replacement.type).toBe("choice")
    expect(() => assertJson(replacement.criteria, "criteria")).not.toThrow()
    expect(Object.keys(replacement.criteria)).toEqual(LABELS)
  })

  it("anchors the list on the null hypothesis", () => {
    expect(LABELS[0]).toBe("keep_effect")
  })

  it("offers one option per outcome, with the two merges the corrections require", () => {
    // `use_memo` folded into `render_computation` (one decision, not two), and
    // `use_linked_state` replaced by what SKILL.md §6 actually prescribes.
    expect(LABELS).not.toContain("use_memo")
    expect(LABELS).toContain("render_computation")
    // `derive_by_id` and `use_linked_state` are both here and are not
    // alternatives to each other: they split on what the effect *writes* —
    // a constant it clears, or a value seeded from the source.
    expect(LABELS).toContain("derive_by_id")
    expect(LABELS).toContain("use_linked_state")
    expect(LABELS).toHaveLength(14)
  })

  it("sends one string per label, not a structured object", () => {
    // Measured: the `{description, evidence, contrast}` keys changed no
    // answer and no probability, and cost ~300 tokens a request. The three
    // parts are still how a criterion is *written* — see the README — but
    // the model reads the whole thing as one block either way.
    for (const [label, criterion] of Object.entries(REPLACEMENTS)) {
      expect(typeof criterion, label).toBe("string")
      expect(criterion.length, label).toBeGreaterThan(200)
    }
  })

  it("makes every option's contrast name at least one neighbour it is not", () => {
    // A thirteen-way choice is thirteen plausible readings of the same effect.
    // An option whose criterion never says which neighbour it is not has no
    // way to lose to that neighbour on evidence.
    for (const [label, criterion] of Object.entries(REPLACEMENTS)) {
      const named = LABELS.filter((other) => other !== label && criterion.includes(other))
      expect(named.length, `${label} names no neighbour`).toBeGreaterThan(0)
    }
  })

  it("splits editable-state-follows-a-prop on what the effect writes", () => {
    // Both options describe state the user also edits, so the handler write
    // alone cannot separate them — measured, case 5 (`setSelection(null)`)
    // and case 3 (`setName(user.name)`) have identical `writes` shapes. The
    // setter's argument is the fact that does separate them, and each side
    // has to say so or the more general wording absorbs the other's mass.
    expect(REPLACEMENTS.use_linked_state).toContain("from the dependency")
    expect(REPLACEMENTS.derive_by_id).toContain("no `inputs` taken from the dependency")
    expect(REPLACEMENTS.use_linked_state).toContain("derive_by_id")
    expect(REPLACEMENTS.derive_by_id).toContain("use_linked_state")
  })

  it("warns that computing during render breaks an editable value", () => {
    // The trap this project exists to avoid: `render_computation` held 27% on
    // an editable field, and its fix would delete the user's ability to type.
    expect(REPLACEMENTS.render_computation).toContain('within: "handler"')
    expect(REPLACEMENTS.use_linked_state).toContain("breaking change")
  })

  it("pairs the two that SKILL.md's own example satisfies at once", () => {
    // `postLike(); setLiked(false)` matches both criteria; the contrast has to
    // say which wins and why, in both directions.
    expect(REPLACEMENTS.event_handler).toContain("collapse_to_handler")
    expect(REPLACEMENTS.collapse_to_handler).toContain("event_handler")
    expect(REPLACEMENTS.event_handler).toContain("outward action decides")
  })

  it("contrasts module_init with keep_effect in both directions", () => {
    expect(REPLACEMENTS.module_init).toContain("keep_effect")
    expect(REPLACEMENTS.keep_effect).toContain("module_init")
  })

  it("keys `key_prop` on every state the unit declares, not on a setter count", () => {
    expect(REPLACEMENTS.key_prop).toContain("every state the component declares")
  })

  it("lists exactly the outcomes that leave the effect in place", () => {
    expect([...KEEP_FAMILY].sort()).toEqual(["effect_event", "keep_effect", "mount_effect"])
    for (const label of KEEP_FAMILY) expect(LABELS).toContain(label)
  })
})

describe("the question set", () => {
  it("asks one question, because the second could not gate", () => {
    // Measured over 17 cases: keep-family mass separates the two families
    // (deletes <= 0.18, keeps >= 0.95) where both Noul wordings overlapped.
    // See CALIBRATION.md.
    expect(Object.keys(effectQuestions)).toEqual(["replacement"])
  })
})
