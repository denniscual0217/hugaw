import { Node, SyntaxKind } from "ts-morph"
import type { CallExpression, Identifier } from "ts-morph"
import { defineRule, noul, score } from "../../../core/index.js"
import type { Candidate, JsonValue, Selection, Slices } from "../../../core/index.js"
import type { FunctionLike, TsTypes } from "../../../adapters/typescript/index.js"
import { isReactApi } from "../analysis/react-imports.js"
import { dependencyCoverage as coverageOf } from "../analysis/render-triggers.js"
import type { MemoData } from "./memo-data.js"

/* ── thresholds (SPEC §3; validated in CALIBRATION.md) ───────────────────── */

/** Weak evidence of legitimacy is enough to stay quiet. */
export const IDENTITY_MATTERS_MAX = 0.4
export const COST_MAX = 1.2
export const MIN_CONFIDENCE = 0.6
/** Below this the identity signal is noise; between the two it earns a caveat. */
export const IDENTITY_CAVEAT_MIN = 0.2

/**
 * How much of the cost distribution must sit on the unbounded-collection
 * levels (2 and 3) before we stay quiet.
 *
 * Mass, not expected score, and deliberately so. An expected score of 1.0 can
 * mean "confidently one pass over a bounded literal" or "evenly split between
 * constant work and an unbounded pass", and only the second is work worth
 * skipping. Thresholding the score would also put the decision three
 * hundredths away from a measured bounded literal (~0.97) — a coin flip
 * waiting for a model update, failing silently by dropping a true positive.
 */
export const UNBOUNDED_WORK_MASS_MIN = 0.5

/**
 * There is deliberately no second, lower threshold for the case where
 * `rendersWithUnchangedDeps` holds.
 *
 * Such a gate was written and removed. It is absent for want of a *measured*
 * threshold, not because the signal is wrong: every other threshold here came
 * from a live ablation, and a hand-picked one that only ever suppresses is
 * still an unmeasured decision to drop findings. On the reasoning alone the
 * band does not earn it either — mass between 0.25 and 0.5 means the model
 * put 50–75% on levels 0–1, and small work skipped often is still only small
 * work saved, which is the same argument that gives this gate a cost floor at
 * all.
 *
 * What would justify adding it back: a live ablation over cases whose mass
 * falls in that band, showing that suppressing them is right more often than
 * reporting them. `rendersWithUnchangedDeps` is computed and carried in
 * `facts` precisely so that ablation is cheap to run.
 */

/** Probability that the factory works over a collection unbounded in view. */
export function unboundedWorkMass(probabilities: Readonly<Record<string, number>>): number {
  // No distribution means no evidence: let the cost gate be the backstop
  // rather than suppressing on an unproven premise.
  if (Object.keys(probabilities).length === 0) return 0
  return 1 - (probabilities["0"] ?? 0) - (probabilities["1"] ?? 0)
}

/**
 * The rubric level the model actually put most mass on.
 *
 * `Math.round(score)` is not safe here: each level is now a specific factual
 * claim, and a bimodal answer rounds onto a level the model gave *zero* mass.
 * `{0: .45, 1: 0, 2: .55}` scores 1.1 and rounds to "bounded right here" —
 * the opposite of what the model said. Ties break upward, so the phrase never
 * under-states the work.
 */
export function costMode(
  probabilities: Readonly<Record<string, number>>,
  fallbackScore: number,
): number {
  let mode: number | null = null
  let best = -1
  for (const key of Object.keys(probabilities).sort((a, b) => Number(a) - Number(b))) {
    const level = Number(key)
    const mass = probabilities[key]
    if (!Number.isFinite(level) || mass === undefined) continue
    if (mass >= best) {
      best = mass
      mode = level
    }
  }
  return mode ?? Math.round(fallbackScore)
}

/* ── the one paid step ───────────────────────────────────────────────────── */

/**
 * The cost rubric asks only what the model can see.
 *
 * The first version's level 1 read "a collection that is typically small",
 * which is a size judgement with no size evidence anywhere in the payload —
 * `items.filter(...)` on a prop array matched it and produced a false
 * positive on load-bearing code. The levels now split on whether the
 * collection's size is *bounded in the code we sent*, which is a property of
 * the slice rather than a guess about runtime.
 */
const questions = {
  cost: score("How much work does the computation inside `memo_call` do on each render?", [
    "Constant work: a property read, arithmetic, string formatting, or an object or array literal with a fixed set of fields",
    "Work over a collection whose size is bounded and visible here: an inline array literal, a tuple, or a fixed set of known keys",
    "One pass (map, filter, find, reduce, Set/Map build) over a collection whose size is not bounded here, such as a prop or state array that could hold thousands of entries",
    "More than one pass, or a sort, groupBy or nested iteration, over a collection whose size is not bounded here; or heavy parsing, regex over large text, or recursive tree building",
  ]),
  /**
   * With `skip` gone this question is load-bearing for every identity case the
   * rule used to decide statically, so its criteria enumerate them — including
   * the two that leave the file (a custom hook's return value, a write into a
   * ref or cache), which the old text did not mention because a skip caught
   * them first. The primitive clause is the other half of the same lesson:
   * `"Hi bob" === "Hi bob"` regardless of memoisation, so no consumer at any
   * distance can depend on a memoised string for identity.
   */
  identity_matters: noul(
    "Does any consumer in `value_usages` depend on this value keeping the same reference across renders?",
    {
      true:
        "Some consumer compares it by reference or keeps it beyond this render: a React.memo component, a hook dependency array, a context value, an explicit reference comparison, a ref or cache it is assigned to, or a custom hook returning it to callers this file cannot see",
      false:
        "Every consumer only reads the value during this render — rendering it, reading a field, passing it to a plain function — so a fresh reference each render is harmless. A string, number or boolean has no reference identity at all, so this is always the case for a primitive",
    },
  ),
}

export type MemoQuestions = typeof questions

export type MemoFacts = {
  binding: string
  costScore: number
  costLevel: number
  costConfidence: number
  identityMatters: number
  usageLines: number[]
  usageCount: number
  /** Usages hidden behind a spread — we cannot see which fields are read. */
  spreadUsages: number
  /** Usages in a position we do not recognise; counted and located separately,
   *  because telling an agent to hunt for a spread that isn't there is worse
   *  than saying plainly that we could not classify the line. */
  unclassifiedUsages: number
  unclassifiedLines: number[]
  unresolvedCallees: string[]
  /** The component's reactive inputs, computed statically. */
  renderTriggers: string[]
  /** True when some renders provably leave every dep unchanged. */
  rendersWithUnchangedDeps: boolean
}

/* ── message ─────────────────────────────────────────────────────────────── */

/**
 * Keyed to the rubric levels above — update both together.
 *
 * Levels 2 and 3 are reachable here only through a bimodal answer whose mass
 * stayed under the suppression bar. The phrasing must stay honest about that:
 * we may still think the memo is pointless on identity grounds, but we must
 * not tell an agent the work is small when the model said it is not.
 */
const COST_PHRASE: Record<number, string> = {
  0: "constant work",
  1: "one pass over a collection whose size is fixed right here",
  2: "one pass over a collection whose size is not bounded here",
  3: "repeated or nested passes over a collection whose size is not bounded here",
}

function readsClause(binding: string, lines: readonly number[]): string {
  if (lines.length === 0) return `\`${binding}\` is never read`
  if (lines.length === 1) return `\`${binding}\` is only read at line ${lines[0]}`
  return `\`${binding}\` is only read at lines ${lines.join(", ")}`
}

/**
 * One dense line including the fix, plus a caveat clause *only* where there is
 * a real blind spot. The message is the product: the consumer is an agent that
 * reads stdout and applies the fix itself.
 */
export function buildMessage(facts: MemoFacts): string {
  const phrase = COST_PHRASE[facts.costLevel] ?? "inexpensive work"
  let message =
    `useMemo has no effect — ${phrase}, and ${readsClause(facts.binding, facts.usageLines)}; ` +
    `inline the expression and remove the dep array`

  const caveats: string[] = []
  if (facts.unresolvedCallees.length > 0) {
    const n = facts.unresolvedCallees.length
    caveats.push(
      `${n} ${n === 1 ? "callee" : "callees"} (${facts.unresolvedCallees.join(", ")}) ` +
        `unresolved across files — verify before removing`,
    )
  }
  if (facts.spreadUsages > 0) {
    caveats.push(
      `${facts.spreadUsages} of ${facts.usageCount} usages unresolved behind a spread — verify before removing`,
    )
  }
  if (facts.unclassifiedUsages > 0) {
    const lines = facts.unclassifiedLines
    const where = lines.length === 0 ? "" : ` (line${lines.length === 1 ? "" : "s"} ${lines.join(", ")})`
    caveats.push(
      `${facts.unclassifiedUsages} of ${facts.usageCount} usages could not be classified${where} — verify before removing`,
    )
  }
  if (facts.identityMatters > IDENTITY_CAVEAT_MIN && facts.identityMatters <= IDENTITY_MATTERS_MAX) {
    // No percentage: this clause only exists inside the caveat band, so
    // "weak" is already the whole of what the number would have said.
    caveats.push("weak identity signal — verify no consumer compares references")
  }
  for (const caveat of caveats) message += `; ${caveat}`
  return message
}

/* ── slice readers ───────────────────────────────────────────────────────── */

interface UsageRow {
  line: number
  kind: string
  resolved: boolean
}

function usageRows(slices: Slices): UsageRow[] {
  const raw = slices["value_usages"]
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry: JsonValue) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return []
    const line = entry["line"]
    const kind = entry["kind"]
    const resolved = entry["resolved"]
    return typeof line === "number"
      ? [{ line, kind: typeof kind === "string" ? kind : "other", resolved: resolved !== false }]
      : []
  })
}

/** Static, local and free — no question asks about it, so it never goes on the wire. */
function dependencyCoverage(candidate: Candidate<TsTypes, MemoData>): {
  rendersWithUnchangedDeps: boolean
  renderTriggers: string[]
} {
  const coverage = coverageOf(candidate.node as CallExpression, candidate.unit as FunctionLike)
  return {
    rendersWithUnchangedDeps: coverage.rendersWithUnchangedDeps,
    renderTriggers: coverage.triggers,
  }
}

function unresolvedCalleeNames(slices: Slices): string[] {
  const raw = slices["callee_sources"]
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return []
  const unresolved = raw["unresolved"]
  if (!Array.isArray(unresolved)) return []
  return unresolved.filter((n): n is string => typeof n === "string")
}

/* ── the rule ────────────────────────────────────────────────────────────── */

export const pointlessUseMemo = defineRule<TsTypes, MemoData, MemoQuestions, MemoFacts>({
  name: "pointless-usememo",
  meta: {
    description: "Reports useMemo whose computation is cheap and whose value no consumer compares by reference.",
    defaultSeverity: "warn",
  },
  context: ["component_source", "memo_call", "value_usages", "callee_sources"],

  select(file) {
    const selections: Selection<TsTypes, MemoData>[] = []
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (!isReactApi(call.getExpression(), "useMemo")) continue
      selections.push({ node: call, data: { binding: bindingOf(call) } })
    }
    return selections
  },

  ask() {
    return questions
  },

  decide(answers, { candidate, slices }) {
    const identityMatters = answers.identity_matters.noul
    const { score: costScore, confidence: costConfidence } = answers.cost

    // Order matters (SPEC §3): weak evidence of legitimacy suppresses,
    // strong evidence of pointlessness reports.
    if (identityMatters > IDENTITY_MATTERS_MAX) return null

    // A memo also earns its keep by skipping work on renders where its deps
    // are unchanged. That is set arithmetic over facts we hold statically, so
    // it is computed rather than asked — but it needs the cost answer, which
    // is why it gates here rather than in `skip`.
    // Most of the mass on "unbounded collection work" is evidence of
    // legitimacy, and SPEC §3's asymmetry says weak evidence of legitimacy is
    // enough to stay quiet. That does not become less true because the dep
    // array happens to cover every input, so this gate is unconditional —
    // and it stops us leaning on the fragile confidence band to catch
    // bimodal answers.
    const unboundedMass = unboundedWorkMass(answers.cost.probabilities)
    if (unboundedMass > UNBOUNDED_WORK_MASS_MIN) return null

    // Whether some renders provably leave every dep unchanged. Computed, not
    // asked — and reported rather than gated on, for the reason recorded
    // above the thresholds.
    const coverage = dependencyCoverage(candidate)

    if (costScore > COST_MAX) return null
    if (costConfidence < MIN_CONFIDENCE) return null

    const rows = usageRows(slices)
    const unclassified = rows.filter((r) => !r.resolved && r.kind !== "spread")
    const facts: MemoFacts = {
      binding: candidate.data.binding?.getText() ?? "<unbound>",
      costScore,
      costLevel: costMode(answers.cost.probabilities, costScore),
      costConfidence,
      identityMatters,
      usageLines: [...new Set(rows.map((r) => r.line))].sort((a, b) => a - b),
      usageCount: rows.length,
      spreadUsages: rows.filter((r) => r.kind === "spread").length,
      unclassifiedUsages: unclassified.length,
      unclassifiedLines: [...new Set(unclassified.map((r) => r.line))].sort((a, b) => a - b),
      unresolvedCallees: unresolvedCalleeNames(slices),
      renderTriggers: coverage.renderTriggers,
      rendersWithUnchangedDeps: coverage.rendersWithUnchangedDeps,
    }

    return { messageId: "pointlessUseMemo", message: buildMessage(facts), facts }
  },
})

/* ── helpers ─────────────────────────────────────────────────────────────── */

function bindingOf(call: CallExpression): Identifier | null {
  const parent = call.getParent()
  if (!parent || !Node.isVariableDeclaration(parent)) return null
  if (parent.getInitializer() !== call) return null
  const nameNode = parent.getNameNode()
  return Node.isIdentifier(nameNode) ? nameNode : null
}

export default pointlessUseMemo
