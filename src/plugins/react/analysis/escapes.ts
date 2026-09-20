import { Node } from "ts-morph"
import type { Identifier } from "ts-morph"
import { unitOf } from "../../../adapters/typescript/units.js"
import type { FunctionLike } from "../../../adapters/typescript/types.js"
import { accessChainRoot } from "./access.js"

const SHORT_CIRCUIT = new Set(["??", "||", "&&"])

/**
 * Wrappers that carry a value outward without consuming it.
 *
 * Position matters: in `cond ? a : b` only the branches carry the value out,
 * and in `a ?? b` only the operands do. Hoisting from the condition would
 * silence `return flag ? <A/> : <B/>`, which is a consumer, not an exit.
 */
function carriesOutward(parent: Node, current: Node): boolean {
  if (
    Node.isParenthesizedExpression(parent) ||
    Node.isAsExpression(parent) ||
    Node.isSatisfiesExpression(parent) ||
    Node.isNonNullExpression(parent) ||
    Node.isObjectLiteralExpression(parent) ||
    Node.isArrayLiteralExpression(parent) ||
    Node.isPropertyAssignment(parent) ||
    Node.isShorthandPropertyAssignment(parent)
  ) {
    return true
  }
  if (Node.isConditionalExpression(parent)) {
    return parent.getWhenTrue() === current || parent.getWhenFalse() === current
  }
  if (Node.isBinaryExpression(parent) && SHORT_CIRCUIT.has(parent.getOperatorToken().getText())) {
    return parent.getLeft() === current || parent.getRight() === current
  }
  return false
}

/**
 * True when the memoized value leaves the unit: returned from it (directly,
 * through a conditional, or wrapped in the object a custom hook returns), or
 * written into another object.
 *
 * Crucially this does *not* fire for `return <div>{value}</div>`: JSX
 * expressions are consumers, not exits, and treating them as escapes would
 * silence the rule everywhere.
 *
 * Known limitation: an alias hop (`const out = value; return out`) is not
 * followed, so such a hook is judged rather than skipped. Tracking assignment
 * graphs is out of MVP scope; the model still sees the `returned` usage.
 */
export function escapesUnit(reference: Identifier, unit: FunctionLike): boolean {
  // A field of the memo carries the memo's identity with it.
  let current: Node = accessChainRoot(reference)
  let parent = current.getParent()

  while (parent && carriesOutward(parent, current)) {
    current = parent
    parent = current.getParent()
  }
  if (!parent) return false

  if (Node.isReturnStatement(parent) && parent.getExpression() === current) {
    return unitOf(parent) === unit
  }

  // Arrow shorthand body: `() => value`.
  if (Node.isArrowFunction(parent) && parent.getBody() === current) {
    return parent === unit
  }

  if (Node.isBinaryExpression(parent) && parent.getOperatorToken().getText() === "=") {
    if (parent.getRight() !== current) return false
    const target = parent.getLeft()
    // Writing into another object's field — `ref.current`, a cache, a mutable
    // record — outlives this render whether or not that object is local.
    if (Node.isPropertyAccessExpression(target) || Node.isElementAccessExpression(target)) return true
    return assignsToOuterBinding(target, unit)
  }

  return false
}

/** `outerVar = value`, where `outerVar` is declared outside this unit. */
function assignsToOuterBinding(target: Node, unit: FunctionLike): boolean {
  if (!Node.isIdentifier(target)) return false
  const declaration = target.getSymbol()?.getDeclarations()[0]
  if (!declaration) return false
  return unitOf(declaration) !== unit
}
