import type { CallExpression, Identifier } from "ts-morph"

/** What `select` hands to `skip`, the slices and `decide`. */
export interface MemoData {
  /** The `const x = useMemo(…)` binding, or null when the result is not bound. */
  readonly binding: Identifier | null
}

export function callOf(node: unknown): CallExpression {
  return node as CallExpression
}
