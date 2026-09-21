import { Node, SyntaxKind } from "ts-morph"
import type { CallExpression, Identifier } from "ts-morph"
import type { FunctionLike } from "../../../adapters/typescript/types.js"
import { referencesWithin } from "../../../adapters/typescript/references.js"
import { isFunctionLike, unitOf } from "../../../adapters/typescript/units.js"
import { isReactEffectCallback } from "./effects.js"
import { isReactApi } from "./react-imports.js"

const MAX_ARGUMENT_CHARS = 160

/**
 * Where a state write happens, classified by the *kind* of function it sits
 * in rather than by where in the file it is.
 *
 * This is the discriminator half the Choice's options are defined against: a
 * state written both in an effect and in a handler is a different animal from
 * one written only in the effect, and "written only in a handler" is the whole
 * evidence for treating a flag as a trigger the handler could have acted on.
 */
export type WriteContext = "render" | "effect" | "handler" | "callback" | "other"

export interface StateWrite {
  readonly line: number
  readonly within: WriteContext
  /** Any enclosing function is a React effect callback, however deeply nested. */
  readonly insideEffect: boolean
  readonly argument: string
}

export interface StateSetter {
  readonly value: string
  readonly setter: Identifier | null
  readonly hook: "useState" | "useReducer"
  readonly initial: string | null
}

/** `useState` / `useReducer` pairs the unit itself declares. */
export function stateSetters(unit: FunctionLike): StateSetter[] {
  const body = unit.getBody()
  if (!body) return []

  const found: StateSetter[] = []
  for (const declaration of body.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    // A declaration inside a nested callback belongs to that callback.
    if (unitOf(declaration) !== unit) continue
    const initializer = declaration.getInitializer()
    if (!initializer || !Node.isCallExpression(initializer)) continue
    const callee = initializer.getExpression()
    const hook = isReactApi(callee, "useState")
      ? "useState"
      : isReactApi(callee, "useReducer")
        ? "useReducer"
        : null
    if (hook === null) continue

    // `useState(initial)` vs `useReducer(reducer, initial)`.
    const initialArgument = initializer.getArguments()[hook === "useState" ? 0 : 1]
    const initial = initialArgument ? truncateText(initialArgument.getText()) : null

    const nameNode = declaration.getNameNode()
    if (Node.isArrayBindingPattern(nameNode)) {
      const [first, second] = nameNode.getElements()
      const value =
        first && Node.isBindingElement(first) ? first.getNameNode().getText() : "<unnamed>"
      const setterName =
        second && Node.isBindingElement(second) ? second.getNameNode() : undefined
      found.push({
        value,
        setter: setterName && Node.isIdentifier(setterName) ? setterName : null,
        hook,
        initial,
      })
      continue
    }
    if (Node.isIdentifier(nameNode)) {
      // `const state = useState(0)` — the pair is never destructured, so there
      // is no setter identifier to track writes through.
      found.push({ value: nameNode.getText(), setter: null, hook, initial })
    }
  }
  return found
}

/** Every call of `setter` inside the unit, with the context it happens in. */
export function writeSitesOf(setter: Identifier, unit: FunctionLike): StateWrite[] {
  const writes: StateWrite[] = []
  for (const reference of referencesWithin(setter, unit)) {
    const call = reference.getParent()
    if (!call || !Node.isCallExpression(call)) continue
    if (call.getExpression() !== reference) continue
    const { within, insideEffect } = writeContextOf(call, unit)
    writes.push({
      line: call.getStartLineNumber(),
      within,
      insideEffect,
      argument: truncateText(call.getArguments().map((a) => a.getText()).join(", ")),
    })
  }
  return writes
}

/**
 * The context a call happens in.
 *
 * `render` is deliberately *described*, never reported: mutation during render
 * is the React Compiler lint's business, and saying so here would be a second
 * rule wearing this one's name.
 */
export function writeContextOf(
  call: CallExpression,
  unit: FunctionLike,
): { within: WriteContext; insideEffect: boolean } {
  const enclosing = unitOf(call)
  const insideEffect = enclosesEffect(call, unit)

  if (enclosing === null) return { within: "other", insideEffect }
  if (enclosing === unit) return { within: "render", insideEffect }
  if (isReactEffectCallback(enclosing)) return { within: "effect", insideEffect }
  if (isHandlerFunction(enclosing)) return { within: "handler", insideEffect }
  return { within: "callback", insideEffect }
}

/** Any function between the call and the unit that is an effect callback. */
function enclosesEffect(call: Node, unit: FunctionLike): boolean {
  let current: Node | undefined = call.getParent()
  while (current && current !== unit) {
    if (isFunctionLike(current) && isReactEffectCallback(current)) return true
    current = current.getParent()
  }
  return false
}

const HANDLER_NAME = /^(?:handle|on)[A-Z]/

/**
 * A function that runs because the user did something.
 *
 * Three signals, because the shape varies: written inline on an `on*` JSX
 * attribute, bound to a `handleX`/`onX` name, or the same name through a
 * `useCallback`. Naming convention is evidence, not proof — but a
 * *mis*classification here only moves a write from `handler` to `callback`,
 * which the model reads as weaker evidence rather than as a wrong fact.
 */
function isHandlerFunction(fn: FunctionLike): boolean {
  const parent = fn.getParent()

  if (parent && Node.isJsxExpression(parent)) {
    const attribute = parent.getParent()
    if (attribute && Node.isJsxAttribute(attribute)) {
      return /^on[A-Z]/.test(attribute.getNameNode().getText())
    }
  }
  if (parent && Node.isVariableDeclaration(parent)) {
    return HANDLER_NAME.test(parent.getName())
  }
  if (Node.isFunctionDeclaration(fn)) {
    return HANDLER_NAME.test(fn.getName() ?? "")
  }
  if (parent && Node.isCallExpression(parent) && isReactApi(parent.getExpression(), "useCallback")) {
    const declaration = parent.getParent()
    if (declaration && Node.isVariableDeclaration(declaration)) {
      return HANDLER_NAME.test(declaration.getName())
    }
  }
  if (parent && Node.isPropertyAssignment(parent)) {
    return /^on[A-Z]/.test(parent.getName())
  }
  return false
}

function truncateText(text: string): string {
  const flat = text.replace(/\s+/g, " ")
  return flat.length <= MAX_ARGUMENT_CHARS ? flat : `${flat.slice(0, MAX_ARGUMENT_CHARS)}…`
}
