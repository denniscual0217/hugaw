import { SyntaxKind } from "ts-morph"
import type { CallExpression } from "ts-morph"
import { defineRule } from "../../../core/index.js"
import { interpolate } from "../../../core/index.js"
import type { JsonValue, OptionsReview, RuleOptions, Selection, Slices } from "../../../core/index.js"
import type { FunctionLike, TsTypes } from "../../../adapters/typescript/index.js"
import { effectCallbackOf } from "../analysis/effects.js"
import { indirectCallsOf } from "../analysis/indirect.js"
import type { IndirectCall } from "../analysis/indirect.js"
import { isReactApi } from "../analysis/react-imports.js"
import type { EffectData } from "./effect-data.js"
import {
  KEEP_FAMILY,
  REPLACEMENTS,
  effectQuestions,
  effectQuestionsWith,
  fixOverridesOf,
} from "./effect-questions.js"
import type { Replacement } from "./effect-questions.js"

/* ── thresholds (measured live — see docs/internals.md) ─────────────────── */

/**
 * How much of the Choice's mass may sit on the three outcomes that leave the
 * effect in place before the rule stays quiet.
 *
 * Measured, not guessed: across the ablation's cases, effects that must go
 * sum to at most 0.35 on the keep family and effects that must stay to at
 * least 0.73, with nothing in between. That gap is why this single number
 * replaces the Noul the plan gated on — that question's two wordings put
 * keeps and deletes in overlapping ranges both times. The Calibration
 * section of `docs/internals.md` carries the current table and is the source
 * of truth for these figures; a number repeated here goes stale the next
 * time the option list changes.
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
 * Measured: the largest runner-up in the ablation is a chain whose first link
 * is also a plain derivation, where two fixes are genuinely both defensible.
 * The plan's guess of 0.25 would have fired on one case in twenty-three.
 * `docs/internals.md` has the figures; they are not repeated here because
 * they move whenever an option is added.
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
  /** Every state this effect writes, directly or through a helper we read. */
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
  /** Calls in the effect body itself. A helper's own calls live in `indirect`. */
  outwardCalls: string[]
  /**
   * What each same-file helper the effect calls was found to do, one level
   * deep. The message reads this to say *which* helper did what, rather than
   * flattening everything into one undifferentiated list.
   */
  indirect: IndirectCall[]
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
    `compute it during render${aside ? " (use `useMemo` if the work is expensive)" : ""} ` +
    `and delete ${describeWritten(facts, "the state and the effect", "the effect")}`,
  use_linked_state: (facts) => {
    const what = written(facts)
    return (
      `keep it editable by replacing ${what === null ? "the effect" : `the ${what} and the effect`} ` +
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
  ref_callback: () =>
    "do the work in a ref callback (`ref={(node) => { … }}`), which React runs as the node is " +
    "attached, and delete the effect",
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

/**
 * Placeholders a config-supplied `fix` may use, on top of every fact name.
 *
 * They exist because the built-in phrases are functions of `facts`, not
 * strings: `describeWritten` is what degrades "delete the state and the
 * effect" to "delete the effect" when no write was confirmed. A flat string
 * would throw that away, so the string gets the same knowledge through names
 * that can fail to resolve.
 */
function placeholdersOf(facts: EffectFacts): Record<string, string> {
  const named: Record<string, string> = { owner: facts.owner }
  const state = facts.statesWritten[0]
  if (state !== undefined) named["state"] = `the \`${state}\` state`
  const firstDep = facts.deps[0]
  if (firstDep !== undefined) named["dep"] = `\`${firstDep}\``
  const callback = facts.propCallbacksCalled[0]
  if (callback !== undefined) named["callback"] = `\`${callback}\``
  const external = facts.externals[0]
  if (external !== undefined) named["external"] = `\`${external}\``
  return named
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * A config `fix`, with its placeholders resolved.
 *
 * A clause whose placeholder cannot resolve is **dropped**, not printed with
 * a hole or an empty string — the same degrade the built-in phrases perform,
 * and the same rule that the message may not assert more than was observed.
 * Clauses are comma-separated. If every clause drops, the caller falls back
 * to the built-in phrase, because a finding without a fix is not a finding.
 */
export function applyFixTemplate(template: string, facts: EffectFacts): string | null {
  const named = placeholdersOf(facts)
  const kept = template
    .split(",")
    .map((clause) => clause.trim())
    .filter((clause) => {
      for (const match of clause.matchAll(PLACEHOLDER)) {
        const key = match[1] as string
        if (!Object.hasOwn(named, key) && !Object.hasOwn(facts, key)) return false
      }
      return true
    })
  if (kept.length === 0) return null
  return interpolate(kept.join(", "), { ...facts, ...named })
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
  return joinCapped(items.map((item) => `\`${item}\``))
}

/** Joins at most three already-rendered clauses, counting the rest. */
function joinCapped(parts: readonly string[]): string {
  const shown = parts.slice(0, 3)
  const rest = parts.length - shown.length
  const joined = sentenceList(shown)
  return rest > 0 ? `${joined} and ${rest} more` : joined
}

/** What the effect reached only by calling a helper, for subtraction. */
function indirectSets(facts: EffectFacts): {
  states: Set<string>
  externals: Set<string>
  propCallbacks: Set<string>
} {
  const states = new Set<string>()
  const externals = new Set<string>()
  const propCallbacks = new Set<string>()
  for (const entry of facts.indirect) {
    for (const name of entry.states) states.add(name)
    for (const name of entry.externals) externals.add(name)
    for (const name of entry.propCallbacks) propCallbacks.add(name)
  }
  return { states, externals, propCallbacks }
}

/**
 * Each call in the effect body, with what the helper behind it does.
 *
 * `calls \`evaluateCount(count)\`, which sets \`finished\`` — the whole point
 * of the exercise. A helper we could not read gets no clause at all, which is
 * the same rule as everywhere else: the sentence may not assert more than was
 * observed.
 */
function describeCalls(facts: EffectFacts): string[] {
  const behind = new Map(facts.indirect.map((entry) => [entry.callee, entry]))
  return facts.outwardCalls.map((call) => {
    const name = call.slice(0, call.indexOf("("))
    const entry = behind.get(name)
    if (entry === undefined) return `\`${call}\``
    // One clause, not a list. This sits inside a sentence that is already an
    // "a, b and c" list, and a nested list of its own leaves the reader
    // unable to tell which "and" belongs to which. The order is what a reader
    // needs first: what it writes, who it tells, what it touches, what it
    // calls.
    const inner =
      entry.states.length > 0
        ? `sets ${list(entry.states.slice(0, 2))}`
        : entry.propCallbacks.length > 0
          ? `calls ${list(entry.propCallbacks.slice(0, 2))}`
          : entry.externals.length > 0
            ? `touches ${list(entry.externals.slice(0, 2))}`
            : entry.outwardCalls.length > 0
              ? `calls ${list(entry.outwardCalls.slice(0, 2))}`
              : null
    return inner === null ? `\`${call}\`` : `\`${call}\`, which ${inner}`
  })
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
  // Externals a helper touches are named inside that helper's clause instead,
  // so the sentence says *where* the contact happens rather than listing it
  // twice with no indication of which call reached it.
  const indirectly = indirectSets(facts)
  const directExternals = facts.externals.filter((name) => !indirectly.externals.has(name))
  if (directExternals.length > 0) parts.push(`touches ${list(directExternals)}`)
  if (facts.outwardCalls.length > 0) parts.push(`calls ${joinCapped(describeCalls(facts))}`)
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
  // "only" is earned, not decorative. It is true exactly when setting state is
  // the whole of what the effect does, which is also exactly when deleting it
  // is safe. If the effect touches anything outside React as well, "only"
  // would be the message asserting more than it observed.
  const nothingElse = parts.length === 0
  const directStates = facts.statesWritten.filter((name) => !indirectly.states.has(name))
  if (directStates.length > 0) {
    const sets =
      facts.setterInputs.length > 0
        ? `sets ${list(directStates)} from ${list(facts.setterInputs)}`
        : `sets ${list(directStates)}`
    parts.push(nothingElse ? `only ${sets}` : sets)
  }
  if (parts.length === 0) return "This rule cannot describe what this effect does."
  // A part carrying its own "which …" clause already contains an "and", so
  // the outer list takes a serial comma. Without it, "calls `subscribe(…)`,
  // which touches A and B and sets C" leaves the reader unable to tell
  // whether the effect or the helper sets C.
  const nested = parts.some((part) => part.includes(", which "))
  return `This effect ${sentenceList(parts, nested)}.`
}

/** `a` · `a and b` · `a, b and c` — for clauses, where `list()` joins values. */
function sentenceList(parts: readonly string[], serialComma = false): string {
  if (parts.length <= 1) return parts[0] ?? ""
  const separator = serialComma ? ", and " : " and "
  return `${parts.slice(0, -1).join(", ")}${separator}${parts[parts.length - 1]}`
}

/** Upper-cases the first letter, so a fix fragment can open a sentence. */
/** A project's fix for this label if it resolves, else the built-in one. */
function fixFor(
  facts: EffectFacts,
  label: string,
  aside: boolean,
  fixes: Record<string, string>,
): string | undefined {
  const override = fixes[label]
  if (override !== undefined) {
    const resolved = applyFixTemplate(override, facts)
    if (resolved !== null) return resolved
  }
  return FIX_PHRASE[label]?.(facts, aside)
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
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
export const WORD_BUDGET = 45

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
  /** "it may be worth keeping, so verify before removing". */
  readonly keepCaveat: boolean
  /** "or <the runner-up's fix>". */
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

export function buildMessage(facts: EffectFacts, fixes: Record<string, string> = {}): string {
  let message = ""
  for (const budget of DROP_ORDER) {
    message = assemble(facts, budget, fixes)
    if (wordCount(message) <= WORD_BUDGET) return message
  }
  // Everything expendable is gone and it is still long: what is left is
  // load-bearing, and a shorter message would be a less useful one.
  return message
}

function assemble(facts: EffectFacts, budget: Budgeted, fixes: Record<string, string> = {}): string {
  const fix =
    fixFor(facts, facts.replacement, budget.aside, fixes) ??
    "replace it with the primitive that fits"
  const sentences: string[] = [observationOf(facts), `${capitalise(fix)}.`]

  const alternative =
    budget.alternative &&
    facts.runnerUp !== null &&
    facts.runnerUpMass >= EITHER_OR_MIN &&
    !KEEP_FAMILY.has(facts.runnerUp) &&
    FIX_PHRASE[facts.runnerUp] !== undefined
      ? // The alternative never carries the aside: it is already the clause
        // most likely to be dropped, and a parenthetical inside it would be
        // the first thing to go anyway.
        fixFor(facts, facts.runnerUp, false, fixes)
      : null
  if (alternative) sentences.push(`Or ${alternative}.`)

  sentences.push(...caveatsOf(facts, budget.keepCaveat))
  return sentences.join(" ")
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
  const sentences: string[] = [
    `This effect has empty dependencies and synchronises once on mount${what}.`,
    rationale
      ? "Wrap it in the project's `useMountEffect` so the intent is explicit and the lint " +
        "suppression lives in one place."
      : "Wrap it in the project's `useMountEffect`.",
  ]

  const read = facts.readsOutsideDeps[0]
  if (key && read !== undefined) {
    sentences.push(
      `It also reads \`${read}\`. Pass \`key={${read}}\` at the call site if that should restart it.`,
    )
  }
  // No keep-family caveat here: this finding *is* "keep it, wrapped", so
  // "may be worth keeping" would argue against nothing.
  sentences.push(...caveatsOf(facts, false))
  return sentences.join(" ")
}

/**
 * Only real blind spots. Never boilerplate — see the memo rule's message.
 *
 * **No probability reaches the message.** A number in prose is either
 * actionable, in which case it should have moved `decide` instead, or it is
 * not, in which case it is our distribution leaking into someone else's
 * sentence. "or (43%)" was the case that made the point: nobody does
 * anything different at 43% than at 30%, and a reader who does not know what
 * a probability mass is cannot tell whether 43% is a lot.
 *
 * So the message says what to do and what we could not verify. The numbers
 * are real and stay in `facts`, where `--format json-with-metadata` publishes
 * them for anything that actually computes on them.
 */
function caveatsOf(facts: EffectFacts, keepRunnerUp: boolean): string[] {
  const caveats: string[] = []
  if (facts.unresolvedCallees.length > 0) {
    const names = facts.unresolvedCallees.map((name) => `\`${name}\``)
    const one = names.length === 1
    caveats.push(
      `${sentenceList(names)} ${one ? "is" : "are"} defined in another file and ` +
        `${one ? "was" : "were"} not read. Check what ${one ? "it does" : "they do"} before removing.`,
    )
  }
  if (facts.callbackName !== null && !facts.callbackResolved) {
    caveats.push(
      `The effect body is \`${facts.callbackName}\`, which is defined elsewhere. ` +
        "Verify before removing.",
    )
  }
  // The write is named in the observation but not confirmed as React state,
  // so the fix that follows is reasoning about something we could not see.
  if (facts.statesWritten.length === 0 && facts.unresolvedWrites.length > 0) {
    const hook = facts.unresolvedWriteHook
    caveats.push(
      `\`${facts.unresolvedWrites[0] as string}\` looks like a state setter, but ` +
        (hook === null
          ? "it does not resolve to React state. Verify before removing."
          : `it came from a \`${hook}\` that does not resolve to React's. ` +
            "Check this file's imports before removing."),
    )
  }
  // Nothing was nameable at all. Saying so is the point: the fix above is the
  // model's, and the evidence for it is not in this message.
  if (
    facts.statesWritten.length === 0 &&
    facts.unresolvedWrites.length === 0 &&
    facts.outwardCalls.length === 0 &&
    facts.externals.length === 0
  ) {
    caveats.push("The effect's writes could not be resolved. Verify before removing.")
  }
  if (
    keepRunnerUp &&
    facts.runnerUp !== null &&
    KEEP_FAMILY.has(facts.runnerUp) &&
    facts.runnerUpMass >= EITHER_OR_MIN
  ) {
    caveats.push("This effect may be worth keeping as it is. Verify before removing.")
  }
  return caveats
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

  /**
   * A project may replace any option's criterion, and its fix phrase with it.
   * Only labels that already exist: a new one would need a fix phrase config
   * cannot supply, and would land in a Choice whose gate was measured against
   * the built-in set.
   */
  reviewOptions(options: RuleOptions): OptionsReview {
    const overrides = options.extends?.replacements
    if (overrides === undefined) return { errors: [] }

    const errors: string[] = []
    const known = Object.keys(REPLACEMENTS)
    const criteria: string[] = []
    const fixes: string[] = []
    for (const [label, override] of Object.entries(overrides)) {
      if (!known.includes(label)) {
        errors.push(
          `extends.replacements: "${label}" is not a replacement of this rule. ` +
            `Valid labels: ${known.join(", ")}.`,
        )
        continue
      }
      const criterion = typeof override === "string" ? override : override.criterion
      const fix = typeof override === "string" ? undefined : override.fix
      if (criterion !== undefined) criteria.push(label)
      if (fix !== undefined) {
        fixes.push(label)
        // The same punctuation the built-in messages follow: the output is a
        // terminal, where a dash doing three jobs reads as three minus signs.
        if (fix.includes("\u2014")) {
          errors.push(`extends.replacements.${label}.fix: use ( … ) or a comma, not an em-dash.`)
        }
      }
    }
    if (errors.length > 0) return { errors }
    if (criteria.length === 0 && fixes.length === 0) return { errors: [] }

    const parts: string[] = []
    if (criteria.length > 0) {
      parts.push(`${criteria.length} criteri${criteria.length === 1 ? "on" : "a"} (${criteria.join(", ")})`)
    }
    if (fixes.length > 0) parts.push(`${fixes.length} fix${fixes.length === 1 ? "" : "es"} (${fixes.join(", ")})`)
    return {
      errors: [],
      // Worth saying out loud: a fourteenth option moved one case's clearance
      // by 0.15, so changed criteria can move the gate without anyone noticing.
      notice:
        `react/useeffect-alternatives: overriding ${parts.join(" and ")} from config; ` +
        "thresholds were measured against the built-in set",
    }
  },

  ask({ options }) {
    return effectQuestionsWith(options.extends?.replacements)
  },

  decide(answers, { candidate, slices, options }) {
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
    // One level through each same-file helper the effect calls. The payload
    // already inlines those bodies, so this adds no request and needs no
    // re-ablation; it only stops the sentence from hiding what the model was
    // given.
    const indirect = indirectCallsOf(candidate.node as CallExpression, candidate.unit as FunctionLike)
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
      statesWritten: unique([
        ...[...setterCalls.map((row) => row.callee), ...handedOver].map(
          (setter) => names.get(setter) ?? setter,
        ),
        // A fix phrase that says "delete the state" has to know about state
        // written through a helper too, or it under-claims on exactly the
        // case this indirection exists for.
        ...indirect.flatMap((entry) => entry.states),
      ]),
      setterInputs: unique(setterCalls.flatMap((row) => row.inputs)),
      unresolvedWrites: unique(unconfirmed.map((row) => row.callee)),
      unresolvedWriteInputs: unique(unconfirmed.flatMap((row) => row.inputs)),
      unresolvedWriteHook: unconfirmed.find((row) => row.via !== null)?.via ?? null,
      propCallbacksCalled: unique([
        ...rows.filter((row) => row.kind === "prop-callback").map((row) => row.callee),
        ...indirect.flatMap((entry) => entry.propCallbacks),
      ]),
      outwardCalls: unique(
        rows
          .filter((row) => NAMEABLE_KINDS.has(row.kind) && !WRITE_NAME.test(row.callee))
          .map((row) => `${row.callee}(${row.arguments})`),
      ),
      externals: unique([
        ...strings(object(slices["effect_body"])["externals"]),
        ...indirect.flatMap((entry) => entry.externals),
      ]),
      indirect,
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

    return {
      messageId: "replaceEffect",
      message: buildMessage(facts, fixOverridesOf(options.extends?.replacements)),
      facts,
    }
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
