import { SyntaxKind } from "ts-morph"
import { defineRule } from "../../../core/index.js"
import type { JsonValue, Selection, Slices } from "../../../core/index.js"
import type { TsTypes } from "../../../adapters/typescript/index.js"
import { effectCallbackOf } from "../analysis/effects.js"
import { isReactApi } from "../analysis/react-imports.js"
import type { EffectData } from "./effect-data.js"
import { KEEP_FAMILY, REPLACEMENTS, effectQuestions } from "./effect-questions.js"
import type { Replacement } from "./effect-questions.js"

/* ── thresholds (measured; CALIBRATION.md) ───────────────────────────────── */

/**
 * How much of the Choice's mass may sit on the three outcomes that leave the
 * effect in place before the rule stays quiet.
 *
 * Measured over 17 cases, not guessed: effects that must go summed to at most
 * 0.17 on the keep family, effects that must stay to at least 0.92, and
 * nothing landed in between. That gap is why this single number replaces the
 * Noul the plan gated on — that question's two wordings put keeps at
 * 0.16–0.48 and 0.41–0.93 against deletes at 0.10–0.47 and 0.03–0.87, which
 * overlap both times. 0.5 sits 0.33 above the highest delete and 0.42 below
 * the lowest keep. CALIBRATION.md has the table.
 *
 * Mass, not the mode, and the distinction is the whole point: a distribution
 * like `{keep .30, effect_event .12, mount .05, render .31, memo .22}` has a
 * delete-family mode and 47% of its belief on keeping the effect. Reading the
 * mode reports that one and tells the user "30%".
 */
export const KEEP_FAMILY_MASS_MAX = 0.5

/**
 * When the runner-up is worth printing.
 *
 * Measured: across 17 cases the largest runner-up inside the delete family is
 * 0.13 (`key_prop` against `derive_by_id`, two fixes that are genuinely both
 * defensible), and the largest of any kind is 0.32. The plan's guess of 0.25
 * would have fired twice in seventeen, both on a keep-family runner-up, which
 * prints as a caveat rather than as an alternative — i.e. never where a second
 * fix is what the reader needs.
 */
export const EITHER_OR_MIN = 0.1

/* ── the one paid step ───────────────────────────────────────────────────── */

export type EffectQuestions = typeof effectQuestions

export type EffectFacts = {
  owner: string
  ownerKind: string
  depsKind: string
  deps: string[]
  hasCleanup: boolean
  replacement: string
  replacementMass: number
  /** Summed P(keep_effect) + P(mount_effect) + P(effect_event) — the gate. */
  keepFamilyMass: number
  runnerUp: string | null
  runnerUpMass: number
  choiceConfidence: number
  /** The whole distribution, carried so later ablations are free. */
  probabilities: Record<string, number>
  statesWritten: string[]
  setterInputs: string[]
  /**
   * Calls shaped like a state write that we could *not* confirm are one —
   * `setTotal(…)` where the `useState` it came from is not React's, so the
   * declaration never resolved. Named, never claimed: the observation may
   * say the call happens, and no fix phrase may call it state.
   */
  unresolvedWrites: string[]
  unresolvedWriteInputs: string[]
  /** The hook such a write came out of, when it came from one at all. */
  unresolvedWriteHook: string | null
  propCallbacksCalled: string[]
  outwardCalls: string[]
  externals: string[]
  unresolvedCallees: string[]
  readsOutsideDeps: string[]
  callbackName: string | null
  callbackResolved: boolean
}

export interface ChoiceSummary {
  readonly mode: string
  readonly mass: number
  readonly runnerUp: string | null
  readonly runnerUpMass: number
  readonly keepFamilyMass: number
}

/**
 * The label the model actually put most mass on, plus the runner-up and the
 * keep-family total.
 *
 * Ties break toward whichever option comes first in `REPLACEMENTS`, which is
 * `keep_effect` — the null hypothesis. A tie is not evidence, and the burden
 * of proof is on the linter.
 */
export function summariseChoice(
  probabilities: Readonly<Record<string, number>>,
  fallback: string,
): ChoiceSummary {
  const order = Object.keys(REPLACEMENTS)
  const ranked = Object.entries(probabilities)
    .filter(([, mass]) => Number.isFinite(mass))
    .sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))

  const keepFamilyMass = ranked
    .filter(([label]) => KEEP_FAMILY.has(label))
    .reduce((total, [, mass]) => total + mass, 0)

  const first = ranked[0]
  const second = ranked[1]
  if (!first) {
    // No distribution means no evidence about the alternatives; the headline
    // answer is all there is, and the keep-family gate below sees 0.
    return { mode: fallback, mass: 0, runnerUp: null, runnerUpMass: 0, keepFamilyMass }
  }
  return {
    mode: first[0],
    mass: first[1],
    runnerUp: second?.[0] ?? null,
    runnerUpMass: second?.[1] ?? 0,
    keepFamilyMass,
  }
}

/* ── message ─────────────────────────────────────────────────────────────── */

/**
 * Keyed to the Choice's labels — update both together.
 *
 * The three keep-family labels have no phrase because they are never
 * reported through this message; `mount_effect` has its own message with the
 * opposite gate direction.
 */
const FIX_PHRASE: Record<string, (facts: EffectFacts, aside: boolean) => string> = {
  // The only phrase that takes the budget's `aside` flag. It is an infix, not
  // a suffix, so dropping it leaves the sentence exactly as it would have
  // been written without it — the clause comes out whole and nothing else
  // about the message moves.
  render_computation: (facts, aside) =>
    `compute it during render${aside ? " — inside `useMemo` if the work is expensive —" : ""} ` +
    `and delete ${describeWritten(facts, "the state and the effect", "the effect")}`,
  use_linked_state: (facts) => {
    const what = written(facts)
    return (
      `keep it editable — replace ${what === null ? "the effect" : `the ${what} and the effect`} ` +
      `with \`useLinkedState(${dep(facts)}, …)\`, which leaves the value alone until ` +
      `\`${dep(facts)}\` changes and recalculates it in the same render`
    )
  },
  derive_by_id: () =>
    "keep only the id in state, derive the value during render, and delete the effect",
  key_prop: (facts) =>
    facts.ownerKind === "hook"
      ? `delete it and give the component that calls \`${facts.owner}\` a \`key={${dep(facts)}}\` so React remounts it`
      : `delete it and render \`${facts.owner}\` with \`key={${dep(facts)}}\` so React remounts it`,
  event_handler: (facts) =>
    `do that work in the handler that sets \`${dep(facts)}\` and delete ` +
    `${describeWritten(facts, "the flag state and the effect", "the effect")}`,
  collapse_to_handler: (facts) =>
    `compute the whole next state in the handler that sets \`${dep(facts)}\` and delete the effect`,
  notify_parent: (facts) => {
    const name = stateName(facts)
    const where = name === null ? "the handler that sets it" : `the handler that sets \`${name}\``
    return `call \`${facts.propCallbacksCalled[0] ?? "the callback"}(next)\` in ${where} and delete the effect`
  },
  lift_fetch: (facts) =>
    `move the query to the parent and pass the data down as a prop instead of up through \`${facts.propCallbacksCalled[0] ?? "the callback"}\``,
  data_library: (facts) => {
    const what = written(facts)
    return (
      `replace the effect${what === null ? "" : ` and the ${what}`} ` +
      "with the project's data-fetching hook for this request"
    )
  },
  external_store: (facts) => {
    const what = written(facts)
    const over = facts.externals[0] === undefined ? "the source" : `\`${facts.externals[0]}\``
    return (
      `replace ${what === null ? "the effect" : `the ${what} and the effect`} ` +
      `with \`useSyncExternalStore(subscribe, getSnapshot)\` over ${over}`
    )
  },
  module_init: () =>
    "move it to module scope, or guard it with a module-level flag, so it runs once per page load rather than once per mount",
}

/**
 * `whenKnown` only when React state was actually observed.
 *
 * A setter-shaped call we could not resolve is *not* evidence of state. It
 * was briefly treated as such here, on the grounds that a write was clearly
 * happening — but "something is written" and "this is React state you may
 * delete" are different claims, and only the second licenses the advice.
 */
function describeWritten(facts: EffectFacts, whenKnown: string, whenUnknown: string): string {
  return facts.statesWritten.length > 0 ? whenKnown : whenUnknown
}

function dep(facts: EffectFacts): string {
  return facts.deps[0] ?? "that value"
}

/**
 * What the effect writes, as the fix may refer to it — or null when we never
 * established that it writes anything.
 *
 * The old version returned the string `"local"` when nothing was known, which
 * is how a finding came to advise replacing "the `local` state" of a
 * component that has no such thing. A fabricated name in the one clause an
 * agent acts on is worse than no clause: there is nothing in the output to
 * suggest it was invented.
 */
function written(facts: EffectFacts): string | null {
  const state = facts.statesWritten[0]
  return state === undefined ? null : `\`${state}\` state`
}

/** The state name a fix phrase can address, or null. Never a placeholder. */
function stateName(facts: EffectFacts): string | null {
  return facts.statesWritten[0] ?? null
}

function list(items: readonly string[]): string {
  const shown = items.slice(0, 3).map((item) => `\`${item}\``)
  const rest = items.length - shown.length
  const joined =
    shown.length <= 1
      ? (shown[0] ?? "")
      : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`
  return rest > 0 ? `${joined} and ${rest} more` : joined
}

/**
 * What the effect does, built from static facts alone.
 *
 * Never from the model: the fix is a judgement and is allowed to be wrong,
 * but the sentence describing the code the agent is about to delete has to be
 * true of that code. The model's contribution to this line is the fix clause
 * and nothing else.
 */
export function observationOf(facts: EffectFacts): string {
  const parts: string[] = []
  if (facts.externals.length > 0) parts.push(`touches ${list(facts.externals)}`)
  if (facts.outwardCalls.length > 0) parts.push(`calls ${list(facts.outwardCalls)}`)
  // A write we could not confirm is state is still a write we watched happen.
  // Phrased as the call it is, so the sentence stays true even when
  // `component_state` came back empty.
  if (facts.unresolvedWrites.length > 0) {
    const call = `calls ${list(facts.unresolvedWrites.map((name) => `${name}(…)`))}`
    parts.push(
      facts.unresolvedWriteInputs.length > 0
        ? `${call} with ${list(facts.unresolvedWriteInputs)}`
        : call,
    )
  }
  if (facts.statesWritten.length > 0) {
    parts.push(
      facts.setterInputs.length > 0
        ? `sets ${list(facts.statesWritten)} from ${list(facts.setterInputs)}`
        : `sets ${list(facts.statesWritten)}`,
    )
  }
  if (parts.length === 0) return "this rule cannot describe what it does"
  return parts.join(" and ")
}

/**
 * A budget, because the message *is* the product (SPEC §0).
 *
 * Findings had drifted to 58 words, stacking a fix, an aside, an either/or
 * and two caveats onto one line; the memo rule sits at 23 and reads fine.
 * Over budget, whole clauses are dropped in a fixed order of expendability.
 * Never truncated mid-sentence — a half-finished instruction is worse than a
 * missing one — and never at the cost of a clause that changes what the
 * reader does next.
 */
export const WORD_BUDGET = 35

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

/**
 * The three clauses the budget may take, in the order it takes them.
 *
 * `keepCaveat` and `alternative` are mutually exclusive in practice: both are
 * built from the single runner-up, and it is either in the keep family or it
 * is not. The order between them still matters for reading the code, but only
 * one of the two is ever present to drop.
 */
interface Budgeted {
  /** The parenthetical about when `useMemo` earns its keep. */
  readonly aside: boolean
  /** "model gave N% to keeping it". */
  readonly keepCaveat: boolean
  /** "or (N%) <the runner-up's fix>". */
  readonly alternative: boolean
}

/**
 * Least useful first.
 *
 * The aside is a general truth about `useMemo` that a React developer
 * already holds; the keep caveat is a hedge on a finding we decided to
 * report; the alternative is a second fix for a case the first one already
 * covers. What is deliberately absent from this list: the fix itself, and an
 * unresolved-callee caveat — that one names code the reader cannot see, and
 * dropping it would turn "verify this first" into silence.
 */
const DROP_ORDER: readonly Budgeted[] = [
  { aside: true, keepCaveat: true, alternative: true },
  { aside: false, keepCaveat: true, alternative: true },
  { aside: false, keepCaveat: false, alternative: true },
  { aside: false, keepCaveat: false, alternative: false },
]

export function buildMessage(facts: EffectFacts): string {
  let message = ""
  for (const budget of DROP_ORDER) {
    message = assemble(facts, budget)
    if (wordCount(message) <= WORD_BUDGET) return message
  }
  // Everything expendable is gone and it is still long: what is left is
  // load-bearing, and a shorter message would be a less useful one.
  return message
}

function assemble(facts: EffectFacts, budget: Budgeted): string {
  const fix =
    FIX_PHRASE[facts.replacement]?.(facts, budget.aside) ?? "replace it with the primitive that fits"
  let message = `useEffect should not exist — ${observationOf(facts)}; ${fix}`

  const alternative =
    budget.alternative &&
    facts.runnerUp !== null &&
    facts.runnerUpMass >= EITHER_OR_MIN &&
    !KEEP_FAMILY.has(facts.runnerUp) &&
    FIX_PHRASE[facts.runnerUp] !== undefined
      // The alternative never carries the aside: it is already the clause
      // most likely to be dropped, and a parenthetical inside it would be
      // the first thing to go anyway.
      ? FIX_PHRASE[facts.runnerUp]?.(facts, false)
      : null
  if (alternative) message += `; or (${percent(facts.runnerUpMass)}) ${alternative}`

  for (const caveat of caveatsOf(facts, budget.keepCaveat)) message += `; ${caveat}`
  return message
}

export function buildMountMessage(facts: EffectFacts): string {
  // Same budget, same principle. The rationale for wrapping goes first — a
  // reader who is being told to use `useMountEffect` can infer why — then
  // the `key` aside, which is a suggestion rather than the fix. The wrap
  // itself and any unresolved-callee caveat always stay.
  for (const [rationale, key] of [
    [true, true],
    [false, true],
    [false, false],
  ] as const) {
    const message = assembleMount(facts, rationale, key)
    if (wordCount(message) <= WORD_BUDGET) return message
  }
  return assembleMount(facts, false, false)
}

function assembleMount(facts: EffectFacts, rationale: boolean, key: boolean): string {
  const what = facts.externals.length > 0 ? ` with ${list(facts.externals)}` : ""
  let message = `useEffect with [] is a mount-only sync${what} — wrap it in the project's \`useMountEffect\``
  if (rationale) message += " so the intent is explicit and the lint suppression lives in one place"

  const read = facts.readsOutsideDeps[0]
  if (key && read !== undefined) {
    message += `; it also reads \`${read}\`, so pass \`key={${read}}\` at the call site if that should restart it`
  }
  // No keep-family caveat here: this finding *is* "keep it, wrapped", so
  // "the model gave 33% to keeping it" would argue against nothing.
  for (const caveat of caveatsOf(facts, false)) message += `; ${caveat}`
  return message
}

/** Only real blind spots. Never boilerplate — see the memo rule's message. */
function caveatsOf(facts: EffectFacts, keepRunnerUp: boolean): string[] {
  const caveats: string[] = []
  if (facts.unresolvedCallees.length > 0) {
    const n = facts.unresolvedCallees.length
    caveats.push(
      `${n} ${n === 1 ? "callee" : "callees"} (${facts.unresolvedCallees.join(", ")}) ` +
        `unresolved across files — verify what they do before removing`,
    )
  }
  if (facts.callbackName !== null && !facts.callbackResolved) {
    caveats.push(
      `the effect body is \`${facts.callbackName}\`, defined elsewhere — verify before removing`,
    )
  }
  // The write is named in the observation but not confirmed as React state,
  // so the fix that follows is reasoning about something we could not see.
  if (facts.statesWritten.length === 0 && facts.unresolvedWrites.length > 0) {
    const hook = facts.unresolvedWriteHook
    caveats.push(
      `\`${facts.unresolvedWrites[0] as string}\` looks like a state setter but ` +
        (hook === null
          ? "does not resolve to React state — verify before removing"
          : `came from a \`${hook}\` that does not resolve to React's — check this file's imports before removing`),
    )
  }
  // Nothing was nameable at all. Saying so is the point: the fix below is the
  // model's, and the evidence for it is not in this message.
  if (
    facts.statesWritten.length === 0 &&
    facts.unresolvedWrites.length === 0 &&
    facts.outwardCalls.length === 0 &&
    facts.externals.length === 0
  ) {
    caveats.push("the effect's writes could not be resolved — verify before removing")
  }
  if (
    keepRunnerUp &&
    facts.runnerUp !== null &&
    KEEP_FAMILY.has(facts.runnerUp) &&
    facts.runnerUpMass >= EITHER_OR_MIN
  ) {
    caveats.push(`model gave ${percent(facts.runnerUpMass)} to keeping it`)
  }
  return caveats
}

function percent(mass: number): string {
  return `${Math.round(mass * 100)}%`
}

/* ── slice readers ───────────────────────────────────────────────────────── */

interface BodyCallRow {
  readonly callee: string
  readonly kind: string
  readonly arguments: string
  readonly inputs: string[]
  /** For `hook-result`: the hook the callee came out of. */
  readonly via: string | null
}

function object(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {}
}

function strings(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
}

function bodyCallRows(slices: Slices): BodyCallRow[] {
  const raw = object(slices["effect_body"])["calls"]
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    const row = object(entry)
    return typeof row["callee"] === "string" && typeof row["kind"] === "string"
      ? [
          {
            callee: row["callee"],
            kind: row["kind"],
            arguments: typeof row["arguments"] === "string" ? row["arguments"] : "",
            inputs: strings(row["inputs"]),
            via: typeof row["via"] === "string" ? row["via"] : null,
          },
        ]
      : []
  })
}

/** Setter name -> the state value it writes, from `component_state`. */
function stateNames(slices: Slices): Map<string, string> {
  const names = new Map<string, string>()
  const raw = object(slices["component_state"])["state"]
  if (!Array.isArray(raw)) return names
  for (const entry of raw) {
    const declared = object(entry)
    if (typeof declared["setter"] === "string" && typeof declared["value"] === "string") {
      names.set(declared["setter"], declared["value"])
    }
  }
  return names
}

/* ── the rule ────────────────────────────────────────────────────────────── */

export const useEffectAlternatives = defineRule<TsTypes, EffectData, EffectQuestions, EffectFacts>({
  name: "useeffect-alternatives",
  meta: {
    description:
      "Reports useEffect that a React primitive would do better — derived state, an event handler, a key, useSyncExternalStore, a data-fetching hook, or module scope.",
    defaultSeverity: "warn",
  },
  context: ["component_source", "component_state", "effect_call", "effect_body"],

  select(file) {
    const selections: Selection<TsTypes, EffectData>[] = []
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (!isReactApi(call.getExpression(), "useEffect")) continue
      const { callbackName, resolved } = effectCallbackOf(call)
      selections.push({ node: call, data: { callbackName, callbackResolved: resolved } })
    }
    return selections
  },

  ask() {
    return effectQuestions
  },

  decide(answers, { candidate, slices }) {
    const { choice, confidence, probabilities } = answers.replacement
    const summary = summariseChoice(probabilities, choice)

    const effectCall = object(slices["effect_call"])
    const componentState = object(slices["component_state"])
    const owner = object(componentState["owner"])
    const rows = bodyCallRows(slices)
    const names = stateNames(slices)

    const setterCalls = rows.filter((row) => row.kind === "state-setter")
    // A call shaped like a state write that we could not confirm is one. The
    // usual cause is a `useState` that does not resolve to React's — an
    // unimported one, or a local function sharing the name — which leaves
    // `component_state.state` empty and the write classified by whatever it
    // did resolve to. The information is still real; only the claim "this is
    // React state" is not.
    const unconfirmed = rows.filter(
      (row) => row.kind !== "state-setter" && WRITE_NAME.test(row.callee),
    )
    // `fetchProduct(id).then(setProduct)` writes `product` without ever
    // calling the setter here, so a setter *handed to* something counts too.
    // Without this the canonical data-fetching finding offers to replace
    // "the `local` state", which is the one clause an agent acts on.
    const handedOver = [...names.keys()].filter((setter) =>
      rows.some((row) => mentions(row.arguments, setter)),
    )
    const facts: EffectFacts = {
      owner: typeof owner["name"] === "string" ? owner["name"] : "<anonymous>",
      ownerKind: typeof owner["kind"] === "string" ? owner["kind"] : "other",
      depsKind: typeof effectCall["depsKind"] === "string" ? effectCall["depsKind"] : "unknown",
      deps: strings(effectCall["deps"]),
      hasCleanup: effectCall["hasCleanup"] === true,
      replacement: summary.mode,
      replacementMass: summary.mass,
      keepFamilyMass: summary.keepFamilyMass,
      runnerUp: summary.runnerUp,
      runnerUpMass: summary.runnerUpMass,
      choiceConfidence: confidence,
      probabilities: { ...probabilities },
      statesWritten: unique(
        [...setterCalls.map((row) => row.callee), ...handedOver].map(
          (setter) => names.get(setter) ?? setter,
        ),
      ),
      setterInputs: unique(setterCalls.flatMap((row) => row.inputs)),
      unresolvedWrites: unique(unconfirmed.map((row) => row.callee)),
      unresolvedWriteInputs: unique(unconfirmed.flatMap((row) => row.inputs)),
      unresolvedWriteHook: unconfirmed.find((row) => row.via !== null)?.via ?? null,
      propCallbacksCalled: unique(
        rows.filter((row) => row.kind === "prop-callback").map((row) => row.callee),
      ),
      outwardCalls: unique(
        rows
          .filter((row) => NAMEABLE_KINDS.has(row.kind) && !WRITE_NAME.test(row.callee))
          .map((row) => `${row.callee}(${row.arguments})`),
      ),
      externals: strings(object(slices["effect_body"])["externals"]),
      unresolvedCallees: strings(object(slices["effect_body"])["unresolved"]),
      readsOutsideDeps: strings(effectCall["readsOutsideDeps"]),
      callbackName: candidate.data.callbackName,
      callbackResolved: candidate.data.callbackResolved,
    }

    // The positive claim first: a mount-only sync is *kept*, and wrapped. It
    // needs the mode as well as the mass (SKILL.md's own `useSyncExternalStore`
    // example has empty deps and a cleanup and matches `mount_effect`'s
    // evidence verbatim; measured, it puts 0.01 on `mount_effect` and 0.98 on
    // `external_store`, so the mode is what keeps the two apart).
    if (summary.mode === "mount_effect" && summary.keepFamilyMass > KEEP_FAMILY_MASS_MAX) {
      return { messageId: "wrapMountEffect", message: buildMountMessage(facts), facts }
    }

    // The gate. Weak evidence that the effect earns its keep is enough to stay
    // quiet — the same asymmetry as the memo rule, on the one signal measured
    // to carry it.
    if (summary.keepFamilyMass > KEEP_FAMILY_MASS_MAX) return null
    // Belt and braces: a keep-family mode under half the mass is a
    // distribution nobody has measured, and this rule deletes code.
    if (KEEP_FAMILY.has(summary.mode)) return null

    return { messageId: "replaceEffect", message: buildMessage(facts), facts }
  },
})

/** `setX(…)` / `dispatch(…)` — the shape of a write, whatever it resolved to. */
const WRITE_NAME = /^(?:set[A-Z]|dispatch)/

/**
 * Call kinds the observation clause can name.
 *
 * `prop-callback` is included: calling the parent's callback is the whole of
 * what a `notify_parent` effect does, and leaving it out was why such a
 * finding described itself as doing "nothing this rule can name" — on a file
 * that compiles perfectly.
 *
 * `member` is deliberately absent. It is the kind that cannot tell
 * `connection.on("message", …)` from `products.filter(p => p.inStock)` — a
 * subscription and an array method, one of which is a side effect and one of
 * which is the arithmetic of a derived value. The observation clause is the
 * half of the message that must be *true of the code*, so it does not get to
 * guess: a real outward call through a member is almost always visible in
 * `externals` as well, and the chained half of `fetchProduct(id).then(…)` is
 * already named by its `imported` root.
 */
const NAMEABLE_KINDS = new Set(["imported", "same-file", "global", "unresolved", "prop-callback"])

/** Whole-word match, so `setProduct` is not found inside `setProducts`. */
function mentions(text: string, name: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_$])${name}([^A-Za-z0-9_$]|$)`).test(text)
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)]
}

export type { Replacement }
export default useEffectAlternatives
