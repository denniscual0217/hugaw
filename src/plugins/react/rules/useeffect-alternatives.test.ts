import { describe, expect, it } from "vitest"
import type { Answers, Candidate, JsonValue, Slices, Verdict } from "../../../core/index.js"
import type { TsTypes } from "../../../adapters/typescript/index.js"
import { REPLACEMENTS } from "./effect-questions.js"
import type { EffectData } from "./effect-data.js"
import {
  EITHER_OR_MIN,
  KEEP_FAMILY_MASS_MAX,
  summariseChoice,
  useEffectAlternatives,
} from "./useeffect-alternatives.js"
import type { EffectFacts, EffectQuestions } from "./useeffect-alternatives.js"

/**
 * One in-memory candidate, every outcome.
 *
 * No files: `decide` reads slices and `candidate.data`, both of which are
 * plain JSON here. The real slices are tested where they are built, and the
 * end-to-end path is one fixture per bucket — this table is about the
 * decision, which is the part with thresholds in it.
 */
const BASE_SLICES: Record<string, JsonValue> = {
  component_source: "function ProductList({ products }) { … }",
  component_state: {
    owner: { name: "ProductList", kind: "component" },
    props: ["products"],
    state: [
      {
        value: "filtered",
        setter: "setFiltered",
        hook: "useState",
        initial: "[]",
        writes: [
          { line: 6, within: "effect", insideEffect: true, argument: "products.filter(…)" },
        ],
      },
    ],
    hookResults: [],
  },
  effect_call: {
    line: 6,
    endLine: 8,
    source: "useEffect(() => { setFiltered(products.filter(p => p.inStock)) }, [products])",
    deps: ["products"],
    depsKind: "list",
    hasCleanup: false,
    callback: "inline",
    readsOutsideDeps: [],
  },
  effect_body: {
    calls: [
      {
        line: 7,
        callee: "setFiltered",
        kind: "state-setter",
        arguments: "products.filter((p) => p.inStock)",
        inputs: ["products"],
        nested: null,
      },
    ],
    resolved: {},
    unresolved: [],
    externals: [],
  },
}

const DATA: EffectData = { callbackName: null, callbackResolved: true }

function candidateWith(data: EffectData = DATA): Candidate<TsTypes, EffectData> {
  return {
    id: "react/useeffect-alternatives@/t.tsx:6:3",
    ruleId: "react/useeffect-alternatives",
    filePath: "/t.tsx",
    node: null as never,
    unit: null as never,
    unitKey: "/t.tsx#0",
    loc: { line: 6, column: 3, endLine: 8, endColumn: 4 },
    nodeType: "CallExpression",
    data,
  }
}

interface Options {
  readonly slices?: Record<string, JsonValue>
  readonly data?: EffectData
  readonly confidence?: number
}

/** Runs `decide` on one hand-written distribution. */
function decide(
  probabilities: Record<string, number>,
  options: Options = {},
): Verdict<EffectFacts> | null {
  const ranked = Object.entries(probabilities).sort((a, b) => b[1] - a[1])
  const answers = {
    replacement: {
      type: "choice",
      choice: ranked[0]?.[0] ?? "keep_effect",
      confidence: options.confidence ?? 0.9,
      probabilities,
    },
  } as unknown as Answers<EffectQuestions>

  return useEffectAlternatives.decide(answers, {
    candidate: candidateWith(options.data),
    slices: { ...BASE_SLICES, ...options.slices } as Slices,
  })
}

/* ── the gate ────────────────────────────────────────────────────────────── */

describe("the keep-family mass gate", () => {
  it("reports when the keep family holds almost nothing", () => {
    const verdict = decide({ render_computation: 1 })
    expect(verdict?.messageId).toBe("replaceEffect")
    expect(verdict?.facts.keepFamilyMass).toBe(0)
  })

  it("stays quiet when the keep family holds more than half the mass", () => {
    expect(decide({ keep_effect: 0.6, render_computation: 0.4 })).toBe(null)
  })

  it("sums the family rather than reading the mode — the 47% distribution", () => {
    // The case the plan's mode-only gate gets wrong: a delete-family mode,
    // yet 47% of the belief is on leaving the effect alone. Under the mode
    // this reports and prints "30%".
    const split = {
      keep_effect: 0.3,
      effect_event: 0.12,
      mount_effect: 0.05,
      render_computation: 0.31,
      derive_by_id: 0.22,
    }
    const verdict = decide(split)
    expect(verdict?.facts.replacement).toBe("render_computation")
    expect(verdict?.facts.keepFamilyMass).toBeCloseTo(0.47)
    // Still reported — 0.47 is under the bar — but the message says what the
    // model actually thought rather than implying near-certainty.
    expect(verdict?.message).toContain("model gave 30% to keeping it")
  })

  it("stays quiet on a keep-family mode even below the bar", () => {
    // Belt and braces: a keep-family mode holding under half the mass is a
    // distribution nothing has measured, and this rule deletes code.
    expect(decide({ keep_effect: 0.4, render_computation: 0.3, key_prop: 0.3 })).toBe(null)
  })

  it("puts the threshold where the measurement put it", () => {
    expect(KEEP_FAMILY_MASS_MAX).toBe(0.5)
    expect(EITHER_OR_MIN).toBe(0.1)
  })
})

describe("wrapMountEffect — the positively gated finding", () => {
  const MOUNT_SLICES = {
    effect_call: {
      line: 6,
      endLine: 12,
      source: "useEffect(() => { … }, [])",
      deps: [],
      depsKind: "empty",
      hasCleanup: true,
      callback: "inline",
      readsOutsideDeps: ["label"],
    },
    effect_body: {
      calls: [],
      resolved: {},
      unresolved: [],
      externals: ["new ResizeObserver"],
    },
  }

  it("fires on a mount_effect mode with the mass to back it", () => {
    const verdict = decide({ mount_effect: 0.71, keep_effect: 0.27, effect_event: 0.02 }, {
      slices: MOUNT_SLICES,
    })
    expect(verdict?.messageId).toBe("wrapMountEffect")
    expect(verdict?.message).toContain("mount-only sync with `new ResizeObserver`")
    expect(verdict?.message).toContain("wrap it in the project's `useMountEffect`")
  })

  it("names the read outside the deps as a `key`, never as a missing dependency", () => {
    const verdict = decide({ mount_effect: 0.9, keep_effect: 0.1 }, { slices: MOUNT_SLICES })
    expect(verdict?.message).toContain("it also reads `label`, so pass `key={label}`")
    expect(verdict?.message).not.toContain("dependency array")
  })

  it("does not fire on SKILL.md's own useSyncExternalStore example", () => {
    // Empty deps, a cleanup, listeners — `mount_effect`'s evidence verbatim.
    // Measured, the model puts 0.01 there and 0.98 on `external_store`, and
    // requiring the *mode* is what stops the rule telling a reader to do the
    // opposite of the skill.
    const verdict = decide({ external_store: 0.98, keep_effect: 0.01, mount_effect: 0.01 }, {
      slices: {
        ...MOUNT_SLICES,
        effect_body: {
          calls: [],
          resolved: {},
          unresolved: [],
          externals: ["navigator.onLine", "window.addEventListener"],
        },
      },
    })
    expect(verdict?.messageId).toBe("replaceEffect")
    expect(verdict?.message).toContain("useSyncExternalStore")
  })

  it("does not fire on a mount_effect mode the keep family does not back", () => {
    expect(decide({ mount_effect: 0.3, render_computation: 0.29, key_prop: 0.41 })).not.toBe(null)
  })
})

/* ── the outcome table ───────────────────────────────────────────────────── */

const RICH_SLICES: Record<string, JsonValue> = {
  component_state: {
    owner: { name: "Toggle", kind: "component" },
    props: ["onChange"],
    state: [
      {
        value: "isOn",
        setter: "setIsOn",
        hook: "useState",
        initial: "false",
        writes: [{ line: 9, within: "handler", insideEffect: false, argument: "!isOn" }],
      },
    ],
    hookResults: [],
  },
  effect_call: {
    line: 5,
    endLine: 7,
    source: "useEffect(() => { onChange(isOn) }, [isOn, onChange])",
    deps: ["isOn", "onChange"],
    depsKind: "list",
    hasCleanup: false,
    callback: "inline",
    readsOutsideDeps: [],
  },
  effect_body: {
    calls: [
      {
        line: 6,
        callee: "onChange",
        kind: "prop-callback",
        arguments: "isOn",
        inputs: ["isOn"],
        nested: null,
      },
      {
        line: 6,
        callee: "setIsOn",
        kind: "state-setter",
        arguments: "false",
        inputs: [],
        nested: null,
      },
      {
        line: 6,
        callee: "postLike",
        kind: "same-file",
        arguments: "",
        inputs: [],
        nested: null,
      },
    ],
    resolved: {},
    unresolved: [],
    externals: ["window.localStorage"],
  },
}

/** Every reportable label prints its own fix, and only its own. */
const FIXES: [string, string][] = [
  ["render_computation", "compute it during render"],
  ["derive_by_id", "keep only the id in state"],
  ["key_prop", "render `Toggle` with `key={isOn}`"],
  ["event_handler", "do that work in the handler that sets `isOn`"],
  ["collapse_to_handler", "compute the whole next state in the handler"],
  ["notify_parent", "call `onChange(next)` in the handler that sets `isOn`"],
  ["lift_fetch", "pass the data down as a prop instead of up through `onChange`"],
  ["data_library", "replace the effect and the `isOn` state with the project's data-fetching hook"],
  ["external_store", "`useSyncExternalStore(subscribe, getSnapshot)` over `window.localStorage`"],
  ["module_init", "move it to module scope"],
]

describe("one fix phrase per outcome", () => {
  it.each(FIXES)("%s prints its own fix", (label, phrase) => {
    const verdict = decide({ [label]: 1 }, { slices: RICH_SLICES })
    expect(verdict?.facts.replacement).toBe(label)
    expect(verdict?.message).toContain(phrase)
  })

  it("covers every option that is not in the keep family", () => {
    // If an option is added to the Choice without a phrase here, it ships a
    // finding whose fix reads "replace it with the primitive that fits".
    const reportable = Object.keys(REPLACEMENTS).filter(
      (label) => !["keep_effect", "mount_effect", "effect_event"].includes(label),
    )
    expect(FIXES.map(([label]) => label).sort()).toEqual(reportable.sort())
  })

  it("never reports a keep-family label through the delete message", () => {
    for (const label of ["keep_effect", "effect_event"]) {
      expect(decide({ [label]: 1 })).toBe(null)
    }
  })
})

/* ── message construction ────────────────────────────────────────────────── */

describe("the observation clause is built from static facts alone", () => {
  it("names the state and where it came from", () => {
    expect(decide({ render_computation: 1 })?.message).toContain(
      "useEffect should not exist — sets `filtered` from `products`;",
    )
  })

  it("names externals, outward calls and state in that order", () => {
    expect(decide({ notify_parent: 1 }, { slices: RICH_SLICES })?.message).toContain(
      "touches `window.localStorage` and calls `postLike()` and sets `isOn`",
    )
  })

  it("trims a long list rather than printing all of it", () => {
    const verdict = decide(
      { key_prop: 1 },
      {
        slices: {
          component_state: {
            owner: { name: "Profile", kind: "component" },
            props: ["userId"],
            state: ["a", "b", "c", "d"].map((value) => ({
              value,
              setter: `set${value.toUpperCase()}`,
              hook: "useState",
              initial: "''",
              writes: [],
            })),
            hookResults: [],
          },
          effect_body: {
            calls: ["a", "b", "c", "d"].map((value) => ({
              line: 5,
              callee: `set${value.toUpperCase()}`,
              kind: "state-setter",
              arguments: "''",
              inputs: [],
              nested: null,
            })),
            resolved: {},
            unresolved: [],
            externals: [],
          },
        },
      },
    )
    expect(verdict?.message).toContain("sets `a`, `b` and `c` and 1 more")
  })
})

describe("the alternative clause", () => {
  it("prints the runner-up's fix when it is worth printing", () => {
    const verdict = decide({ derive_by_id: 0.88, key_prop: 0.12 })
    expect(verdict?.message).toContain("; or (12%) delete it and render `ProductList`")
  })

  it("says nothing about a runner-up below the bar", () => {
    const verdict = decide({ derive_by_id: 0.92, key_prop: 0.08 })
    expect(verdict?.message).not.toContain("; or (")
  })

  it("turns a keep-family runner-up into a caveat, not a second fix", () => {
    const verdict = decide({ data_library: 0.85, keep_effect: 0.15 })
    expect(verdict?.message).toContain("model gave 15% to keeping it")
    expect(verdict?.message).not.toContain("; or (")
  })
})

describe("caveats name the blind spot they actually found", () => {
  it("counts unresolved callees", () => {
    const verdict = decide(
      { data_library: 1 },
      {
        slices: {
          effect_body: {
            calls: [],
            resolved: {},
            unresolved: ["fetchProduct"],
            externals: [],
          },
        },
      },
    )
    expect(verdict?.message).toContain(
      "1 callee (fetchProduct) unresolved across files — verify what they do before removing",
    )
  })

  it("says when the body itself is somewhere else", () => {
    const verdict = decide(
      { module_init: 1 },
      { data: { callbackName: "syncTitle", callbackResolved: false } },
    )
    expect(verdict?.message).toContain(
      "the effect body is `syncTitle`, defined elsewhere — verify before removing",
    )
  })

  it("adds nothing when there is nothing to add", () => {
    const message = decide({ render_computation: 1 })?.message ?? ""
    expect(message).not.toContain("verify")
    expect(message).not.toContain("model gave")
  })
})

/* ── summariseChoice ─────────────────────────────────────────────────────── */

describe("summariseChoice", () => {
  it("breaks a tie toward the null hypothesis", () => {
    expect(summariseChoice({ render_computation: 0.5, keep_effect: 0.5 }, "x").mode).toBe(
      "keep_effect",
    )
  })

  it("falls back to the headline answer when there is no distribution", () => {
    const summary = summariseChoice({}, "key_prop")
    expect(summary).toEqual({
      mode: "key_prop",
      mass: 0,
      runnerUp: null,
      runnerUpMass: 0,
      keepFamilyMass: 0,
    })
  })

  it("sums only the three keep-family labels", () => {
    const summary = summariseChoice(
      { keep_effect: 0.2, mount_effect: 0.1, effect_event: 0.05, key_prop: 0.65 },
      "key_prop",
    )
    expect(summary.keepFamilyMass).toBeCloseTo(0.35)
    expect(summary.mode).toBe("key_prop")
  })
})

/* ── select ──────────────────────────────────────────────────────────────── */

describe("the rule's shape", () => {
  it("declares the four slices it reads and has no `skip`", () => {
    expect(useEffectAlternatives.context).toEqual([
      "component_source",
      "component_state",
      "effect_call",
      "effect_body",
    ])
    expect(useEffectAlternatives.skip).toBeUndefined()
  })
})

describe("the mount finding does not argue with itself", () => {
  it("leaves the keep-family runner-up out of a finding that keeps the effect", () => {
    // Live on the fixture: mount_effect 0.64, keep_effect 0.33. "The model
    // gave 33% to keeping it" is a caveat against deleting something this
    // message is not proposing to delete.
    const verdict = decide(
      { mount_effect: 0.64, keep_effect: 0.33, effect_event: 0.03 },
      {
        slices: {
          effect_call: {
            line: 7,
            endLine: 11,
            source: "useEffect(() => { … }, [])",
            deps: [],
            depsKind: "empty",
            hasCleanup: true,
            callback: "inline",
            readsOutsideDeps: ["initialValue"],
          },
          effect_body: { calls: [], resolved: {}, unresolved: [], externals: ["hostRef.current"] },
        },
      },
    )
    expect(verdict?.messageId).toBe("wrapMountEffect")
    expect(verdict?.message).not.toContain("to keeping it")
  })
})
