import { Node } from "ts-morph"
import type { Identifier } from "ts-morph"
import { unitOf } from "../../../adapters/typescript/units.js"
import type { FunctionLike } from "../../../adapters/typescript/types.js"
import { accessChainRoot } from "./access.js"

/**
 * `||` and `??` yield either operand, so `return value || fallback` really
 * does hand the value out. `&&` yields its left operand only when that operand
 * is falsy — `return isOpen && <Modal/>` is the everyday render guard, where
 * the memo is a consumer being tested for truthiness, not an exit.
 */
const CARRIES_EITHER_OPERAND = new Set(["??", "||"])
const CARRIES_RIGHT_OPERAND = new Set(["&&"])

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
  if (Node.isBinaryExpression(parent)) {
    const operator = parent.getOperatorToken().getText()
    if (CARRIES_EITHER_OPERAND.has(operator)) {
      return parent.getLeft() === current || parent.getRight() === current
    }
    if (CARRIES_RIGHT_OPERAND.has(operator)) return parent.getRight() === current
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
export type Escape =
  /** Handed back to whoever called this function. */
  | { readonly kind: "returned"; readonly wrapped: boolean }
  /** Written into something that outlives this render. */
  | { readonly kind: "assigned"; readonly target: string; readonly intoMember: boolean }

/**
 * How the memoized value leaves the unit, or null if it does not.
 *
 * Reported rather than acted on: the rule no longer pre-judges these, so the
 * *reason* has to reach the model as a description instead of being silently
 * converted into a skip.
 *
 * Crucially this does not fire for `return <div>{value}</div>`: JSX
 * expressions are consumers, not exits.
 *
 * Known limitation: an alias hop (`const out = value; return out`) is not
 * followed. The model still sees the `returned` usage on the alias.
 */
export function escapeOf(reference: Identifier, unit: FunctionLike): Escape | null {
  // A field of the memo carries the memo's identity with it.
  let current: Node = accessChainRoot(reference)
  let parent = current.getParent()
  let wrapped = false

  while (parent && carriesOutward(parent, current)) {
    // `return { label }` hands the memo out inside a fresh object.
    if (Node.isObjectLiteralExpression(parent) || Node.isArrayLiteralExpression(parent)) {
      wrapped = true
    }
    current = parent
    parent = current.getParent()
  }
  if (!parent) return null

  if (Node.isReturnStatement(parent) && parent.getExpression() === current) {
    return unitOf(parent) === unit ? { kind: "returned", wrapped } : null
  }

  // Arrow shorthand body: `() => value`.
  if (Node.isArrowFunction(parent) && parent.getBody() === current) {
    return parent === unit ? { kind: "returned", wrapped } : null
  }

  if (Node.isBinaryExpression(parent) && parent.getOperatorToken().getText() === "=") {
    if (parent.getRight() !== current) return null
    const target = parent.getLeft()
    // Writing into another object's field — `ref.current`, a cache, a mutable
    // record — outlives this render whether or not that object is local.
    if (Node.isPropertyAccessExpression(target) || Node.isElementAccessExpression(target)) {
      return { kind: "assigned", target: target.getText(), intoMember: true }
    }
    return assignsToOuterBinding(target, unit)
      ? { kind: "assigned", target: target.getText(), intoMember: false }
      : null
  }

  return null
}

export function escapesUnit(reference: Identifier, unit: FunctionLike): boolean {
  return escapeOf(reference, unit) !== null
}

/** `outerVar = value`, where `outerVar` is declared outside this unit. */
function assignsToOuterBinding(target: Node, unit: FunctionLike): boolean {
  if (!Node.isIdentifier(target)) return false
  const declaration = target.getSymbol()?.getDeclarations()[0]
  if (!declaration) return false
  return unitOf(declaration) !== unit
}
