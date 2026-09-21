import { Node, SyntaxKind } from "ts-morph"
import type { CallExpression, Identifier } from "ts-morph"
import { importSourceOf, resolveDeclaration } from "../../../adapters/typescript/imports.js"
import type { FunctionLike } from "../../../adapters/typescript/types.js"
import { unitOf } from "../../../adapters/typescript/units.js"
import { calleeSourcesIn } from "../slices/callee-sources.js"
import type { CalleeSources } from "../slices/callee-sources.js"
import { nestedContextOf } from "./effects.js"
import { hookNameOf, isHookCall } from "./hooks.js"
import { isReactApi } from "./react-imports.js"

const MAX_ARGUMENT_CHARS = 200

/**
 * What a call inside an effect body actually reaches.
 *
 * Every option in the Choice is defined against this: `render_computation`
 * needs "only state-setters, nothing else"; `notify_parent` needs a
 * `prop-callback`; `data_library` needs a fetch that is not already a
 * `hook-result`. The classification is therefore the payload's centre of
 * gravity, not a convenience.
 */
export type CallKind =
  | "state-setter"
  | "prop-callback"
  | "same-file"
  | "imported"
  | "hook-result"
  | "global"
  | "member"
  | "unresolved"

export interface BodyCall {
  readonly line: number
  readonly callee: string
  readonly kind: CallKind
  /** For `hook-result`: the hook the callee came out of. */
  readonly via?: string
  /** For `imported`: the module specifier. */
  readonly from?: string
  readonly arguments: string
  /** Names from the component's own scope that feed this call. */
  readonly inputs: readonly string[]
  /** Where inside the effect it sits, or null for the effect body itself. */
  readonly nested: string | null
}

export interface HookResult {
  readonly binding: string
  readonly hook: string
  /** Module the hook was imported from, or null when it is declared locally. */
  readonly from: string | null
}

/**
 * React's own hooks whose results are not "a hook's data".
 *
 * `useState`/`useReducer` are already reported as `state`, and the three
 * derived hooks return values computed from inputs the model can see in
 * `component_source`. What is left is the interesting set: query hooks,
 * context, and the project's own custom hooks.
 */
const OWN_HOOKS = ["useState", "useReducer", "useRef", "useMemo", "useCallback"]

/**
 * Every binding in the unit that came out of a hook call, with the hook that
 * produced it.
 *
 * The hook name is load-bearing and not decoration: `const { data } =
 * useGetProductQuery()` and `const [data] = useToggle()` bind the same name,
 * and telling the two apart is the whole difference between "the child is
 * bubbling fetched data up" and "the child is telling its parent about a
 * toggle". A bare list of names cannot make that distinction.
 */
export function hookResultsOf(unit: FunctionLike): HookResult[] {
  const body = unit.getBody()
  if (!body) return []

  const results: HookResult[] = []
  for (const declaration of body.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (unitOf(declaration) !== unit) continue
    const initializer = declaration.getInitializer()
    if (!initializer || !Node.isCallExpression(initializer)) continue
    if (!isHookCall(initializer)) continue
    const callee = initializer.getExpression()
    if (OWN_HOOKS.some((hook) => isReactApi(callee, hook))) continue

    const hook = hookNameOf(initializer)
    const from = importSourceOf(callee)?.module ?? null
    for (const binding of boundNames(declaration.getNameNode())) {
      results.push({ binding, hook, ...(from === null ? { from: null } : { from }) })
    }
  }
  return results
}

function boundNames(nameNode: Node): string[] {
  if (Node.isIdentifier(nameNode)) return [nameNode.getText()]
  if (Node.isArrayBindingPattern(nameNode) || Node.isObjectBindingPattern(nameNode)) {
    return nameNode.getElements().flatMap((element) => {
      if (!Node.isBindingElement(element)) return []
      return boundNames(element.getNameNode())
    })
  }
  return []
}

/** Globals whose members are calls out of React by definition. */
const GLOBAL_ROOTS = new Set([
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "sessionStorage",
  "globalThis",
  "console",
])

export function classifyCall(
  call: CallExpression,
  unit: FunctionLike,
  setters: readonly Identifier[],
  callback: FunctionLike,
): BodyCall {
  const callee = call.getExpression()
  const base = {
    line: call.getStartLineNumber(),
    callee: flatten(callee.getText(), 80),
    arguments: flatten(call.getArguments().map((a) => a.getText()).join(", "), MAX_ARGUMENT_CHARS),
    inputs: inputsOf(call, unit, callback),
    nested: nestedContextOf(call, callback),
  }

  if (Node.isIdentifier(callee)) {
    if (setters.some((setter) => sameSymbol(setter, callee))) {
      return { ...base, kind: "state-setter" }
    }
    const declaration = resolveDeclaration(callee)
    if (!declaration) return { ...base, kind: "unresolved" }
    if (declaration.getSourceFile().isDeclarationFile()) return { ...base, kind: "global" }
    if (isUnitParameter(declaration, unit)) return { ...base, kind: "prop-callback" }

    const hook = hookOfBinding(declaration)
    if (hook !== null) return { ...base, kind: "hook-result", via: hook }

    if (declaration.getSourceFile().getFilePath() === call.getSourceFile().getFilePath()) {
      return { ...base, kind: "same-file" }
    }
    const from = importSourceOf(callee)?.module
    return from === undefined
      ? { ...base, kind: "imported" }
      : { ...base, kind: "imported", from }
  }

  if (Node.isPropertyAccessExpression(callee) || Node.isElementAccessExpression(callee)) {
    const root = leftmostIdentifier(callee)
    if (root !== null) {
      if (GLOBAL_ROOTS.has(root.getText())) return { ...base, kind: "global" }
      const declaration = resolveDeclaration(root)
      if (declaration?.getSourceFile().isDeclarationFile()) return { ...base, kind: "global" }
      if (declaration) {
        const hook = hookOfBinding(declaration)
        if (hook !== null) return { ...base, kind: "hook-result", via: hook }
      }
    }
  }

  return { ...base, kind: "member" }
}

/**
 * Every call the effect makes, plus the callee bodies we could inline and the
 * names we could not.
 *
 * `resolved`/`unresolved` come from the memo rule's own walk, deliberately: a
 * cross-file callee is the same blind spot for both rules, and CALIBRATION.md
 * case C is the reason it must be named rather than guessed at from the name.
 */
export function bodyCalls(
  callback: FunctionLike,
  unit: FunctionLike,
  setters: readonly Identifier[],
): { calls: BodyCall[]; resolved: CalleeSources["resolved"]; unresolved: string[] } {
  const calls = callback
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .map((call) => classifyCall(call, unit, setters, callback))
  const { resolved, unresolved } = calleeSourcesIn(
    callback,
    callback.getSourceFile().getFilePath(),
  )

  // A name this body already explains is not a blind spot. The shared walk
  // has one test — "same file and has a function body" — so a state setter, a
  // callback prop and a hook's return value all come back as unreadable,
  // which for the memo rule they are: it has nothing else to say about them.
  // Here `calls` names each one and says where it came from, and a caveat
  // telling an agent to go and find out what `setFiltered` does across files
  // is both false and the kind of noise that teaches people to skip caveats.
  const explained = new Set(
    calls.filter((call) => EXPLAINED_KINDS.has(call.kind)).map((call) => call.callee),
  )
  return { calls, resolved, unresolved: unresolved.filter((name) => !explained.has(name)) }
}

/** Kinds the payload identifies by origin, so `unresolved` need not. */
const EXPLAINED_KINDS = new Set(["state-setter", "prop-callback", "hook-result"])

/* ── helpers ─────────────────────────────────────────────────────────────── */

function sameSymbol(a: Identifier, b: Identifier): boolean {
  if (a.getText() !== b.getText()) return false
  const left = a.getSymbol()
  const right = b.getSymbol()
  if (!left || !right) return false
  return left.compilerSymbol === right.compilerSymbol
}

/** A parameter of the unit — its props, or a custom hook's arguments. */
function isUnitParameter(declaration: Node, unit: FunctionLike): boolean {
  const parameter = declaration.isKind(SyntaxKind.Parameter)
    ? declaration
    : declaration.getFirstAncestorByKind(SyntaxKind.Parameter)
  if (!parameter) return false
  return parameter.getParent() === unit
}

/** The hook a binding came out of, or null when it came from anywhere else. */
function hookOfBinding(declaration: Node): string | null {
  const variable = Node.isVariableDeclaration(declaration)
    ? declaration
    : declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
  if (!variable) return null
  const initializer = variable.getInitializer()
  if (!initializer || !Node.isCallExpression(initializer)) return null
  if (!isHookCall(initializer)) return null
  if (OWN_HOOKS.some((hook) => isReactApi(initializer.getExpression(), hook))) return null
  return hookNameOf(initializer)
}

function leftmostIdentifier(expression: Node): Identifier | null {
  let current: Node = expression
  for (;;) {
    if (Node.isIdentifier(current)) return current
    if (
      Node.isPropertyAccessExpression(current) ||
      Node.isElementAccessExpression(current) ||
      Node.isNonNullExpression(current) ||
      Node.isParenthesizedExpression(current) ||
      Node.isCallExpression(current)
    ) {
      current = current.getExpression()
      continue
    }
    return null
  }
}

/** Names from the component's own scope that this call's arguments read. */
function inputsOf(call: CallExpression, unit: FunctionLike, callback: FunctionLike): string[] {
  const names = new Set<string>()
  for (const argument of call.getArguments()) {
    const identifiers = Node.isIdentifier(argument)
      ? [argument]
      : argument.getDescendantsOfKind(SyntaxKind.Identifier)
    for (const identifier of identifiers) {
      const parent = identifier.getParent()
      if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) continue
      if (Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier) continue
      const declaration = resolveDeclaration(identifier)
      if (!declaration) continue
      if (!isWithin(declaration, unit)) continue
      if (isWithin(declaration, callback)) continue
      names.add(identifier.getText())
    }
  }
  return [...names].sort()
}

function isWithin(node: Node, scope: Node): boolean {
  if (node === scope) return false
  return node.getFirstAncestor((ancestor) => ancestor === scope) !== undefined
}

function flatten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ")
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}
