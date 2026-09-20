import { Node } from "ts-morph"
import type { CallExpression, Identifier } from "ts-morph"
import { accessChainRoot } from "./access.js"

/** `useThing(...)` / `React.useThing(...)` — the community naming convention. */
const HOOK_NAME = /^(?:React\.)?use[A-Z]/

export function isHookCall(call: CallExpression): boolean {
  return HOOK_NAME.test(call.getExpression().getText())
}

export function hookNameOf(call: CallExpression): string {
  return call.getExpression().getText()
}

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

/**
 * The hook this reference is passed to directly, as in `useQuery(key)`.
 *
 * A hook argument is a strong static identity signal — hooks compare their
 * inputs across renders by definition — so this is worth a free skip.
 */
export function hookArgumentOf(identifier: Identifier): string | null {
  const root = accessChainRoot(identifier)
  const call = root.getParent()
  if (!call || !Node.isCallExpression(call)) return null
  if (!call.getArguments().includes(root)) return null
  if (!isHookCall(call)) return null
  return hookNameOf(call)
}
