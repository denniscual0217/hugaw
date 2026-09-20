import { Node } from "ts-morph"
import type { CallExpression, Identifier } from "ts-morph"
import { importSourceOf } from "../../../adapters/typescript/imports.js"
import { accessChainRoot } from "./access.js"

/**
 * `useThing(...)`, `React.useThing(...)`, `Rt.useThing(...)` — the community
 * naming convention. Any namespace qualifier counts, matching how
 * `isReactApi` resolves namespace imports.
 */
const HOOK_NAME = /^(?:[A-Za-z_$][A-Za-z0-9_$]*\.)?use[A-Z]/

export function isHookCall(call: CallExpression): boolean {
  return HOOK_NAME.test(call.getExpression().getText())
}

/** The callee as written, for display. */
export function hookNameOf(call: CallExpression): string {
  return call.getExpression().getText()
}

/**
 * The React export this call actually resolves to, or null when it is not
 * React's.
 *
 * Name-matching alone is not enough to assert React's semantics: a local
 * `function useState(v)` or an `import { useRef } from "./_my-hooks"` shares
 * the name and shares none of the behaviour. Resolving through
 * `importSourceOf` is the same syntactic check `select` uses.
 */
function reactHookNameOf(call: CallExpression): string | null {
  const source = importSourceOf(call.getExpression())
  if (source === null || source.module !== "react") return null
  return source.name
}

/** Read the argument once on mount and never look at it again. */
const READ_ONCE_HOOKS = new Set(["useState", "useRef", "useReducer"])

/**
 * Compare their dependency array and nothing else.
 *
 * `useImperativeHandle` is deliberately absent: React builds its effect deps
 * as `deps.concat([ref])`, so the ref argument's identity *is* compared and a
 * change re-runs attach/detach.
 */
const DEPS_DRIVEN_HOOKS = new Set([
  "useMemo",
  "useCallback",
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
])

const NON_COMPARING_HOOKS = new Set([...READ_ONCE_HOOKS, ...DEPS_DRIVEN_HOOKS])

/**
 * The hook whose dependency array this reference sits in, or null.
 *
 * Matches through a member-access chain (`[data.items]`) because the field of
 * a memoized object is fresh on every render once the memo is gone. Matches
 * *any* `useX`, not just React's own: a value in a custom hook's dep array is
 * just as identity-sensitive.
 */
export function dependencyArrayHookOf(identifier: Identifier): string | null {
  const array = accessChainRoot(identifier).getParent()
  if (!array || !Node.isArrayLiteralExpression(array)) return null
  const call = array.getParent()
  if (!call || !Node.isCallExpression(call)) return null
  if (!call.getArguments().includes(array)) return null
  if (!isHookCall(call)) return null
  return hookNameOf(call)
}

/** The hook call this reference is a direct argument of. */
function hookCallOf(identifier: Identifier): CallExpression | null {
  const root = accessChainRoot(identifier)
  const call = root.getParent()
  if (!call || !Node.isCallExpression(call)) return null
  if (!call.getArguments().includes(root)) return null
  if (!isHookCall(call)) return null
  return call
}

/**
 * The hook this reference is passed to directly, as in `useQuery(key)`.
 * Used to *describe* the usage: the model should always know a value reaches
 * a hook, even where we decline to skip on it.
 */
export function hookArgumentOf(identifier: Identifier): string | null {
  const call = hookCallOf(identifier)
  return call === null ? null : hookNameOf(call)
}

/**
 * What we know statically about how a hook treats this argument, phrased for
 * the model — and only ever for a verified React export.
 *
 * Saying only "passed to the hook useState()" reads as hook-adjacent and
 * pushes `identity_matters` up — measured at 0.55 against jev-1.13.0, enough
 * to suppress a genuinely pointless memo. React's semantics are a fact we
 * hold statically, so the slice carries it. Asserting it about a function
 * that merely shares the name would be far worse than staying silent.
 */
export function hookArgumentSemantics(identifier: Identifier): string | null {
  const call = hookCallOf(identifier)
  if (call === null) return null
  const reactName = reactHookNameOf(call)
  if (reactName === null) return null
  if (READ_ONCE_HOOKS.has(reactName)) {
    return "which reads it once on mount and never compares it across renders"
  }
  if (DEPS_DRIVEN_HOOKS.has(reactName)) {
    return "which compares only its dependency array, not this argument"
  }
  return null
}

/**
 * Same as `hookArgumentOf`, but only for hooks that plausibly compare the
 * argument across renders — the ones where a stable reference is load-bearing
 * and the free skip is therefore safe.
 *
 * A hook we cannot resolve to a React export counts as comparing: we cannot
 * see inside it, and the burden of proof is on the linter.
 */
export function comparingHookArgumentOf(identifier: Identifier): string | null {
  const call = hookCallOf(identifier)
  if (call === null) return null
  const reactName = reactHookNameOf(call)
  if (reactName !== null && NON_COMPARING_HOOKS.has(reactName)) return null
  return hookNameOf(call)
}
