import { describe, expect, it } from "vitest"
import type { Answers, Candidate, JsonValue, Slices, Verdict } from "../../../core/index.js"
import type { TsTypes } from "../../../adapters/typescript/index.js"
import { REPLACEMENTS } from "./effect-questions.js"
import type { EffectData } from "./effect-data.js"
import {
  EITHER_OR_MIN,
  KEEP_FAMILY_MASS_MAX,
  WORD_BUDGET,
  summariseChoice,
  useEffectAlternatives,
  wordCount,
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
  ["use_linked_state", "keep it editable — replace the `isOn` state and the effect with `useLinkedState(isOn, …)`"],
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

  it("names externals, calls and state in that order", () => {
    // The callback prop is in this list because calling it is the whole of
    // what a `notify_parent` effect does; leaving it out was how such a
    // finding came to describe itself as doing nothing nameable.
    expect(decide({ notify_parent: 1 }, { slices: RICH_SLICES })?.message).toContain(
      "touches `window.localStorage` and calls `onChange(isOn)` and `postLike()` and sets `isOn`",
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
  it("prints the runner-up's fix when it is worth printing and there is room", () => {
    // Note which clause gave way: the `useMemo` aside is dropped first, so
    // the second *fix* survives at the cost of a general remark. That is the
    // ordering — a clause that changes what the reader does outranks one
    // that does not.
    const verdict = decide({ render_computation: 0.88, key_prop: 0.12 })
    expect(verdict?.message).toContain("; or (12%) delete it and render `ProductList`")
    expect(verdict?.message).not.toContain("inside `useMemo`")
  })

  it("gives up the alternative when the primary fix is already long", () => {
    // `derive_by_id`'s phrase is long enough that carrying a second fix puts
    // the line at 38 words. The runner-up is the last thing dropped, but it
    // is still dropped: one clear instruction beats two crowded ones.
    const verdict = decide({ derive_by_id: 0.88, key_prop: 0.12 })
    expect(verdict?.message).not.toContain("; or (")
    expect(wordCount(verdict?.message ?? "")).toBeLessThanOrEqual(WORD_BUDGET)
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

/* ── the message must never assert more than it observed ─────────────────── */

describe("a write the payload could not confirm is state", () => {
  /**
   * `useState` is not imported from react, so `isReactApi` refuses it — the
   * right call, since that `useState` is undefined. `component_state.state`
   * is then empty and the setter is classified by whatever it did resolve
   * to. The information is still there; only the claim "React state" is not.
   */
  const UNCONFIRMED: Record<string, JsonValue> = {
    component_state: {
      owner: { name: "Cart", kind: "component" },
      props: ["items"],
      state: [],
      hookResults: [{ binding: "setTotal", hook: "useState", from: null }],
    },
    effect_body: {
      calls: [
        {
          line: 6,
          callee: "setTotal",
          kind: "hook-result",
          via: "useState",
          arguments: "items.reduce((sum, item) => sum + item.price, 0)",
          inputs: ["items"],
          nested: null,
        },
        {
          line: 6,
          callee: "items.reduce",
          kind: "member",
          arguments: "(sum, item) => sum + item.price, 0",
          inputs: ["items"],
          nested: null,
        },
      ],
      resolved: {},
      unresolved: [],
      externals: [],
    },
  }

  it("names the call it saw instead of claiming to have seen nothing", () => {
    const verdict = decide({ render_computation: 1 }, { slices: UNCONFIRMED })
    expect(verdict?.message).toContain("calls `setTotal(…)` with `items`")
    expect(verdict?.message).not.toContain("cannot describe")
  })

  it("says why the write is unconfirmed, and points at the import", () => {
    const verdict = decide({ render_computation: 1 }, { slices: UNCONFIRMED })
    expect(verdict?.message).toContain(
      "`setTotal` looks like a state setter but came from a `useState` that does not " +
        "resolve to React's — check this file's imports before removing",
    )
  })

  it("carries the unconfirmed write in facts, separately from real state", () => {
    const facts = decide({ render_computation: 1 }, { slices: UNCONFIRMED })?.facts
    expect(facts?.statesWritten).toEqual([])
    expect(facts?.unresolvedWrites).toEqual(["setTotal"])
    expect(facts?.unresolvedWriteHook).toBe("useState")
  })
})

describe("an effect with nothing nameable in it", () => {
  const OPAQUE: Record<string, JsonValue> = {
    component_state: {
      owner: { name: "Thing", kind: "component" },
      props: [],
      state: [],
      hookResults: [],
    },
    effect_body: {
      calls: [
        { line: 5, callee: "a.b", kind: "member", arguments: "", inputs: [], nested: null },
      ],
      resolved: {},
      unresolved: [],
      externals: [],
    },
  }

  it("says plainly that it cannot describe the effect", () => {
    expect(decide({ render_computation: 1 }, { slices: OPAQUE })?.message).toContain(
      "useEffect should not exist — this rule cannot describe what it does",
    )
  })

  it("does not then prescribe deleting state it never saw", () => {
    // The original defect: "it does nothing this rule can name; … delete the
    // state and the effect" — a sentence that contradicts itself, and an
    // instruction with nothing behind it.
    const message = decide({ render_computation: 1 }, { slices: OPAQUE })?.message ?? ""
    expect(message).toContain("and delete the effect")
    expect(message).not.toContain("delete the state")
    expect(message).toContain("the effect's writes could not be resolved — verify before removing")
  })

  it("never invents a state name for a fix that wants one", () => {
    // `notify_parent` used to fill this slot with the literal string
    // "local", producing advice about a state the component does not have.
    const message = decide({ notify_parent: 1 }, { slices: OPAQUE })?.message ?? ""
    expect(message).toContain("in the handler that sets it")
    expect(message).not.toContain("`local`")
  })

  it("leaves no fix phrase claiming state, for any outcome", () => {
    for (const [label] of FIXES) {
      const message = decide({ [label]: 1 }, { slices: OPAQUE })?.message ?? ""
      expect(message, label).not.toMatch(/the `[A-Za-z]+` state/)
      expect(message, label).not.toContain("delete the state")
      expect(message, label).not.toContain("delete the flag state")
    }
  })
})

/* ── the length budget ───────────────────────────────────────────────────── */

describe("the word budget", () => {
  it("drops the `useMemo` aside first", () => {
    // Long observation, so the aside is what has to give.
    const long = decide(
      { render_computation: 1 },
      {
        slices: {
          effect_body: {
            calls: [
              {
                line: 7,
                callee: "setFiltered",
                kind: "state-setter",
                arguments: "products.filter((p) => p.inStock)",
                inputs: ["products", "category", "searchTerm", "sortOrder"],
                nested: null,
              },
            ],
            resolved: {},
            unresolved: [],
            externals: ["window.localStorage", "document.title"],
          },
        },
      },
    )
    expect(long?.message).not.toContain("inside `useMemo`")
    expect(long?.message).toContain("compute it during render and delete")
  })

  it("keeps the aside in its original position when it fits", () => {
    // An infix, not a suffix: dropping it must leave the sentence exactly as
    // it would read had it never been written.
    expect(decide({ render_computation: 1 })?.message).toContain(
      "compute it during render — inside `useMemo` if the work is expensive — " +
        "and delete the state and the effect",
    )
  })

  it("drops the keep-family caveat when the line is over budget", () => {
    // The caveat and the alternative are mutually exclusive — both are built
    // from the single runner-up — so the ordering between them is only ever
    // exercised one at a time. Here the runner-up is in the keep family, so
    // it is a caveat, and it goes once the aside is not enough.
    const verdict = decide(
      { render_computation: 0.85, keep_effect: 0.15 },
      {
        slices: {
          effect_body: {
            calls: [
              {
                line: 7,
                callee: "setFiltered",
                kind: "state-setter",
                arguments: "products.filter((p) => p.inStock)",
                inputs: ["products", "category", "searchTerm", "sortOrder"],
                nested: null,
              },
            ],
            resolved: {},
            unresolved: [],
            externals: ["window.localStorage", "document.title", "navigator.onLine"],
          },
        },
      },
    )
    expect(verdict?.message).not.toContain("inside `useMemo`")
    expect(verdict?.message).not.toContain("to keeping it")
    expect(wordCount(verdict?.message ?? "")).toBeLessThanOrEqual(WORD_BUDGET)
  })

  it("keeps the keep-family caveat when it fits", () => {
    expect(decide({ render_computation: 0.85, keep_effect: 0.15 })?.message).toContain(
      "model gave 15% to keeping it",
    )
  })

  it("never drops an unresolved-callee caveat, even over budget", () => {
    const verdict = decide(
      { render_computation: 1 },
      {
        slices: {
          effect_body: {
            calls: [],
            resolved: {},
            unresolved: ["fetchProduct", "normalise", "track"],
            externals: [],
          },
        },
      },
    )
    // That caveat names code the reader cannot see; dropping it would turn
    // "verify this first" into silence.
    expect(verdict?.message).toContain("unresolved across files")
    expect(wordCount(verdict?.message ?? "")).toBeGreaterThan(WORD_BUDGET)
  })

  it("stops at whole clauses — never a truncated sentence", () => {
    const verdict = decide({ render_computation: 1 })
    expect(verdict?.message).not.toContain("…;")
    expect(verdict?.message?.endsWith("…")).toBe(false)
  })

  it("counts words the way the budget does", () => {
    expect(wordCount("  one   two three ")).toBe(3)
    expect(wordCount("")).toBe(0)
    expect(WORD_BUDGET).toBe(35)
  })
})

describe("the mount message sheds its own clauses", () => {
  const base = {
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
  }

  it("keeps the `key` suggestion when there is room", () => {
    const verdict = decide(
      { mount_effect: 0.9, keep_effect: 0.1 },
      {
        slices: {
          ...base,
          effect_body: { calls: [], resolved: {}, unresolved: [], externals: ["new Editor"] },
        },
      },
    )
    expect(verdict?.message).toContain("pass `key={initialValue}`")
    // The rationale for wrapping goes first: a reader being told to use
    // `useMountEffect` can infer why.
    expect(verdict?.message).not.toContain("lint suppression")
  })

  it("gives up the `key` suggestion rather than an unresolved-callee caveat", () => {
    const verdict = decide(
      { mount_effect: 0.9, keep_effect: 0.1 },
      {
        slices: {
          ...base,
          effect_body: {
            calls: [],
            resolved: {},
            unresolved: ["createEditor"],
            externals: ["hostRef.current"],
          },
        },
      },
    )
    expect(verdict?.message).toContain("unresolved across files")
    expect(verdict?.message).not.toContain("pass `key=")
    expect(wordCount(verdict?.message ?? "")).toBeLessThanOrEqual(WORD_BUDGET)
  })
})
