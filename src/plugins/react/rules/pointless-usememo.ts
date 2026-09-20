import { Node, SyntaxKind } from "ts-morph"
import type { CallExpression, Identifier } from "ts-morph"
import { defineRule, noul, score } from "../../../core/index.js"
import type { JsonValue, Selection, Slices } from "../../../core/index.js"
import type { FunctionLike, TsTypes } from "../../../adapters/typescript/index.js"
import { referencesWithin } from "../../../adapters/typescript/index.js"
import { accessChainRoot } from "../analysis/access.js"
import { contextValueTagOf, enclosingValueAttribute } from "../analysis/context.js"
import { escapesUnit } from "../analysis/escapes.js"
import { comparingHookArgumentOf, dependencyArrayHookOf } from "../analysis/hooks.js"
import { isMemoComponentTag } from "../analysis/memo-components.js"
import { isReactApi } from "../analysis/react-imports.js"
import type { MemoData } from "./memo-data.js"

/* ── thresholds (SPEC §3; validated in CALIBRATION.md) ───────────────────── */

/** Weak evidence of legitimacy is enough to stay quiet. */
export const IDENTITY_MATTERS_MAX = 0.4
export const COST_MAX = 1.2
export const MIN_CONFIDENCE = 0.6
/** Below this the identity signal is noise; between the two it earns a caveat. */
export const IDENTITY_CAVEAT_MIN = 0.2

/* ── the one paid step ───────────────────────────────────────────────────── */

const questions = {
  cost: score("How expensive is the computation inside `memo_call`?", [
    "Constant work: a property read, arithmetic, string formatting, or an object literal with a few static fields",
    "Work over a collection that is typically small: one map, filter, or find",
    "Work over a collection that may be large, or a sort, groupBy, or nested iteration",
    "Heavy: parsing, regex over large text, recursive tree building, or a known-expensive library call",
  ]),
  identity_matters: noul(
    "Does any consumer in `value_usages` depend on this value keeping the same reference across renders?",
    {
      true: "It reaches a memoized component, a hook dependency array, a context value, or a reference comparison",
      false:
        "Every consumer only reads the value during render; a fresh reference each render is harmless",
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
}

/* ── message ─────────────────────────────────────────────────────────────── */

const COST_PHRASE: Record<number, string> = {
  0: "constant work",
  1: "a single pass over a small collection",
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
    caveats.push(
      `weak identity signal (${Math.round(facts.identityMatters * 100)}%) — verify no consumer compares references`,
    )
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

  /**
   * Static escape hatches, zero cost. Every check added here is a false
   * positive that can never happen (SPEC §3) — this is the function that
   * decides whether the tool is trusted.
   */
  skip(candidate) {
    const { binding } = candidate.data
    if (!binding) return "result is not bound to a simple identifier"

    const unit = candidate.unit as FunctionLike
    const references = referencesWithin(binding, unit)

    for (const reference of references) {
      if (escapesUnit(reference, unit)) {
        return "memoized value escapes the component (returned or assigned outward)"
      }
    }
    for (const reference of references) {
      const tag = memoComponentPropTagOf(reference)
      if (tag !== null) return `passed as prop to React.memo component <${tag}>`
    }
    for (const reference of references) {
      const hook = dependencyArrayHookOf(reference)
      if (hook !== null) return `listed in dependency array of ${hook}`
    }
    for (const reference of references) {
      const attribute = enclosingValueAttribute(reference)
      if (!attribute) continue
      const tag = contextValueTagOf(attribute)
      if (tag !== null) return `used as context value on <${tag}>`
    }
    for (const reference of references) {
      const hook = comparingHookArgumentOf(reference)
      if (hook !== null) return `passed as an argument to hook ${hook}`
    }
    return null
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
    if (costScore > COST_MAX) return null
    if (costConfidence < MIN_CONFIDENCE) return null

    const rows = usageRows(slices)
    const unclassified = rows.filter((r) => !r.resolved && r.kind !== "spread")
    const facts: MemoFacts = {
      binding: candidate.data.binding?.getText() ?? "<unbound>",
      costScore,
      costLevel: Math.round(costScore),
      costConfidence,
      identityMatters,
      usageLines: [...new Set(rows.map((r) => r.line))].sort((a, b) => a - b),
      usageCount: rows.length,
      spreadUsages: rows.filter((r) => r.kind === "spread").length,
      unclassifiedUsages: unclassified.length,
      unclassifiedLines: [...new Set(unclassified.map((r) => r.line))].sort((a, b) => a - b),
      unresolvedCallees: unresolvedCalleeNames(slices),
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

function memoComponentPropTagOf(reference: Identifier): string | null {
  // Through a member-access chain too: `<Memo item={data.item} />` hands the
  // memoized object's field straight into a reference comparison.
  const expression = accessChainRoot(reference).getParent()
  if (!expression || !Node.isJsxExpression(expression)) return null
  const attribute = expression.getParent()
  if (!attribute || !Node.isJsxAttribute(attribute)) return null
  const element = attribute.getFirstAncestor(
    (n) => Node.isJsxOpeningElement(n) || Node.isJsxSelfClosingElement(n),
  )
  if (!element || (!Node.isJsxOpeningElement(element) && !Node.isJsxSelfClosingElement(element))) {
    return null
  }
  const tagName = element.getTagNameNode()
  return isMemoComponentTag(tagName) ? tagName.getText() : null
}

export default pointlessUseMemo
