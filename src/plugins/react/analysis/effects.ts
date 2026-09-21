import { Node, SyntaxKind } from "ts-morph"
import type { CallExpression, Identifier } from "ts-morph"
import { resolveDeclaration } from "../../../adapters/typescript/imports.js"
import type { FunctionLike } from "../../../adapters/typescript/types.js"
import { isFunctionLike, unitOf } from "../../../adapters/typescript/units.js"
import { accessChainRoot } from "./access.js"
import { baseIdentifierOf } from "./render-triggers.js"
import { isReactApi } from "./react-imports.js"

/** React's three effect hooks. Only `useEffect` is a candidate (plan §0), but
 *  all three establish an "inside an effect" context for a write site. */
const EFFECT_HOOKS = ["useEffect", "useLayoutEffect", "useInsertionEffect"]

export type DepsKind = "none" | "empty" | "list" | "unknown"

export interface EffectCallback {
  /** The function whose body the effect runs, when we can see it. */
  readonly callback: FunctionLike | null
  /** The identifier it was passed as, when it was not written inline. */
  readonly callbackName: string | null
  /** False when the callback is a name we could not follow to a body. */
  readonly resolved: boolean
}

/**
 * The effect's callback, following one level of indirection.
 *
 * `useEffect(syncTitle, [title])` is common enough in the wild that treating
 * it as "no body" would hand the model an empty `effect_body` and let it judge
 * from the effect's *name*. If the name resolves to a function in reach we use
 * its body and say so; if it does not, `resolved: false` is what the message's
 * caveat is built from.
 */
export function effectCallbackOf(call: CallExpression): EffectCallback {
  const first = call.getArguments()[0]
  if (!first) return { callback: null, callbackName: null, resolved: false }
  if (Node.isArrowFunction(first) || Node.isFunctionExpression(first)) {
    return { callback: first, callbackName: null, resolved: true }
  }
  if (!Node.isIdentifier(first)) {
    return { callback: null, callbackName: first.getText(), resolved: false }
  }

  const name = first.getText()
  const declaration = resolveDeclaration(first)
  if (!declaration) return { callback: null, callbackName: name, resolved: false }
  if (Node.isFunctionDeclaration(declaration)) {
    return { callback: declaration, callbackName: name, resolved: true }
  }
  if (Node.isVariableDeclaration(declaration)) {
    const initializer = declaration.getInitializer()
    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
      return { callback: initializer, callbackName: name, resolved: true }
    }
  }
  return { callback: null, callbackName: name, resolved: false }
}

/**
 * The dependency array as written.
 *
 * Four kinds rather than a nullable list, because the *absence* of the array
 * and an array we cannot read are different facts: `useEffect(fn)` re-runs on
 * every render (no option in the Choice describes that shape), while
 * `useEffect(fn, deps)` with a computed second argument is an effect whose
 * reactivity we simply cannot see.
 */
export function depsKindOf(call: CallExpression): { kind: DepsKind; deps: string[] | null } {
  const second = call.getArguments()[1]
  if (!second) return { kind: "none", deps: null }
  if (!Node.isArrayLiteralExpression(second)) return { kind: "unknown", deps: null }
  const deps = second.getElements().map((element) => element.getText())
  return { kind: deps.length === 0 ? "empty" : "list", deps }
}

/**
 * Whether the effect returns a teardown.
 *
 * Handles the three shapes that occur: `return () => …`, `return unsubscribe`
 * (a name declared in the body), and the concise `() => () => …`. An `async`
 * callback is reported as *no* cleanup, which is the truth — an async function
 * returns a promise, and React ignores it — and the plan leaves the
 * consequences of that shape to the model.
 */
export function hasCleanup(callback: FunctionLike): boolean {
  if (callback.isAsync()) return false

  const body = callback.getBody()
  if (!body) return false
  if (!Node.isBlock(body)) {
    // Concise arrow body: a returned function is the cleanup itself.
    return Node.isArrowFunction(body) || Node.isFunctionExpression(body)
  }

  for (const statement of body.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
    // A `return` inside a nested callback belongs to that callback.
    if (unitOf(statement) !== callback) continue
    const expression = statement.getExpression()
    if (!expression) continue
    if (
      Node.isArrowFunction(expression) ||
      Node.isFunctionExpression(expression) ||
      Node.isIdentifier(expression)
    ) {
      return true
    }
  }
  return false
}

/**
 * Where inside the effect a node sits, phrased for the model — or null when it
 * sits directly in the effect body.
 *
 * The single most important discriminator for a setter call: `setDuration()`
 * in the effect body is derived state, the same call inside a `setInterval`
 * callback is a subscription. Outermost first, so the sentence reads the way
 * the nesting does.
 */
export function nestedContextOf(node: Node, callback: FunctionLike): string | null {
  const layers: string[] = []
  let current: Node | undefined = node.getParent()
  while (current && current !== callback) {
    if (isFunctionLike(current)) layers.unshift(describeFunctionLayer(current))
    current = current.getParent()
  }
  return layers.length === 0 ? null : layers.join(", ")
}

function describeFunctionLayer(fn: Node): string {
  const parent = fn.getParent()
  if (parent && Node.isCallExpression(parent) && parent.getArguments().some((a) => a === fn)) {
    return `inside the callback passed to \`${short(parent.getExpression().getText())}()\``
  }
  if (parent && Node.isPropertyAssignment(parent)) {
    return `inside the function assigned to \`${parent.getName()}\``
  }
  if (parent && Node.isBinaryExpression(parent) && parent.getOperatorToken().getText() === "=") {
    return `inside the function assigned to \`${short(parent.getLeft().getText())}\``
  }
  if (parent && Node.isVariableDeclaration(parent)) {
    return `inside the local function \`${parent.getName()}\``
  }
  return "inside a nested function"
}

function short(text: string): string {
  const flat = text.replace(/\s+/g, " ")
  return flat.length <= 60 ? flat : `${flat.slice(0, 60)}…`
}

/** Globals whose mere appearance means the effect is reaching outside React. */
const GLOBAL_ROOTS = new Set([
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "sessionStorage",
  "globalThis",
])

/** Browser constructors whose instances are external systems by definition. */
const EXTERNAL_CONSTRUCTORS = new Set([
  "ResizeObserver",
  "IntersectionObserver",
  "MutationObserver",
  "PerformanceObserver",
  "WebSocket",
  "EventSource",
  "AbortController",
  "Audio",
  "Image",
  "Worker",
  "BroadcastChannel",
])

/**
 * The handles on things React does not own that this effect touches.
 *
 * A *fact*, not a verdict: `keep_effect` and `external_store` both show
 * externals, and it is what they do with them that separates the two. Reported
 * as the access chain actually written, so the model sees
 * `window.addEventListener` rather than a bare `window`.
 */
export function externalReferences(callback: FunctionLike): string[] {
  const found = new Set<string>()

  for (const identifier of callback.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (isPropertyName(identifier)) continue
    const name = identifier.getText()
    if (GLOBAL_ROOTS.has(name)) {
      found.add(short(accessChainRoot(identifier).getText()))
      continue
    }
    // A ref is reported as the handle itself, not as the whole chain: what is
    // done with `hostRef.current` is already a call in `effect_body.calls`,
    // and listing `hostRef.current` beside `hostRef.current.dataset.label`
    // reads as two external systems where there is one.
    if (isRefCurrentRead(identifier)) found.add(`${name}.current`)
  }

  for (const created of callback.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    const expression = created.getExpression()
    if (!Node.isIdentifier(expression)) continue
    const name = expression.getText()
    const declaration = resolveDeclaration(expression)
    const ambient = declaration?.getSourceFile().isDeclarationFile() ?? false
    const imported =
      declaration !== undefined &&
      declaration.getSourceFile().getFilePath() !== callback.getSourceFile().getFilePath()
    if (EXTERNAL_CONSTRUCTORS.has(name) || ambient || imported) found.add(`new ${name}`)
  }

  return [...found].sort()
}

/** `ref.current` where `ref` is bound from React's own `useRef`. */
function isRefCurrentRead(identifier: Identifier): boolean {
  const parent = identifier.getParent()
  if (!parent || !Node.isPropertyAccessExpression(parent)) return false
  if (parent.getExpression() !== identifier) return false
  if (parent.getNameNode().getText() !== "current") return false

  const declaration = resolveDeclaration(identifier)
  if (!declaration || !Node.isVariableDeclaration(declaration)) return false
  const initializer = declaration.getInitializer()
  return (
    initializer !== undefined &&
    Node.isCallExpression(initializer) &&
    isReactApi(initializer.getExpression(), "useRef")
  )
}

function isPropertyName(identifier: Identifier): boolean {
  const parent = identifier.getParent()
  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) return true
  if (Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier) return true
  if (Node.isJsxAttribute(parent) && parent.getNameNode() === identifier) return true
  if (Node.isBindingElement(parent) && parent.getPropertyNameNode() === identifier) return true
  return false
}

/**
 * Values the unit declares that the effect reads but does not list as a
 * dependency.
 *
 * A fact, never a finding: this rule does not do `exhaustive-deps`. It exists
 * because the shape it describes is the evidence for two different outcomes —
 * a mount-only sync that should be keyed on what it reads, and an effect with
 * one real trigger and one value it only reads for its latest value.
 *
 * Setters and refs are excluded because React guarantees their identity, so
 * their absence from the array is not a read "outside" anything.
 */
export function readsOutsideDeps(
  callback: FunctionLike,
  depRoots: readonly string[] | null,
  unit: FunctionLike,
): string[] {
  // Null means there is no array to be outside of: an effect with no
  // dependency argument re-runs on every render, and one whose argument we
  // cannot read tells us nothing about what it reacts to.
  if (depRoots === null) return []
  const roots = new Set(depRoots)

  const names = new Set<string>()
  for (const identifier of callback.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (isPropertyName(identifier)) continue
    const name = identifier.getText()
    if (roots.has(name) || names.has(name)) continue

    const declaration = resolveDeclaration(identifier)
    if (!declaration) continue
    // Declared inside the effect, or outside the component entirely: neither
    // is a reactive read of this instance's values.
    if (!isDeclaredIn(declaration, unit)) continue
    if (isDeclaredIn(declaration, callback)) continue
    if (isStableBinding(declaration)) continue
    names.add(name)
  }
  return [...names].sort()
}

function isDeclaredIn(declaration: Node, scope: Node): boolean {
  if (declaration === scope) return false
  return declaration.getFirstAncestor((ancestor) => ancestor === scope) !== undefined
}

/** A `useState` setter or a `useRef` box: identity-stable by construction. */
function isStableBinding(declaration: Node): boolean {
  if (Node.isVariableDeclaration(declaration)) {
    const initializer = declaration.getInitializer()
    return (
      initializer !== undefined &&
      Node.isCallExpression(initializer) &&
      isReactApi(initializer.getExpression(), "useRef")
    )
  }
  if (!Node.isBindingElement(declaration)) return false
  const pattern = declaration.getParent()
  if (!Node.isArrayBindingPattern(pattern)) return false
  if (pattern.getElements()[1] !== declaration) return false
  const variable = pattern.getParent()
  if (!Node.isVariableDeclaration(variable)) return false
  const initializer = variable.getInitializer()
  if (!initializer || !Node.isCallExpression(initializer)) return false
  const callee = initializer.getExpression()
  return isReactApi(callee, "useState") || isReactApi(callee, "useReducer")
}

/** True when `fn` is the callback argument of one of React's effect hooks. */
export function isReactEffectCallback(fn: Node): boolean {
  const parent = fn.getParent()
  if (!parent || !Node.isCallExpression(parent)) return false
  if (parent.getArguments()[0] !== fn) return false
  return EFFECT_HOOKS.some((hook) => isReactApi(parent.getExpression(), hook))
}

/**
 * Every dependency entry rooted at the name it hangs off.
 *
 * `[data.items]` and `[data]` are the same reactive input, so the comparison
 * that decides whether a read is "outside the deps" has to happen on roots.
 */
export function dependencyRoots(call: CallExpression): string[] {
  const second = call.getArguments()[1]
  if (!second || !Node.isArrayLiteralExpression(second)) return []
  const roots: string[] = []
  for (const element of second.getElements()) {
    const base = baseIdentifierOf(element)
    if (base !== null && !roots.includes(base)) roots.push(base)
  }
  return roots
}
