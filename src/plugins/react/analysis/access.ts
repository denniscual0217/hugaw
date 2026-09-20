import { Node } from "ts-morph"

/**
 * The outermost expression that *is* this reference: the whole of
 * `data.items`, `data.rows[0]`, `data!.items` when handed the `data` inside.
 *
 * Every positional check (dependency array, memo prop, context value) must
 * run against this node rather than the bare identifier. Reading a field off
 * a memoized object produces a value whose identity is inherited from the
 * memo, so `useEffect(…, [data.items])` is every bit as identity-sensitive as
 * `[data]` — and removing the useMemo would refire the effect on every render.
 *
 * Only hoists while the reference is the *object* being accessed:
 * `rows[data.id]` stops at `data.id`, because the enclosing access belongs to
 * `rows`, not to us.
 */
export function accessChainRoot(reference: Node): Node {
  let current = reference
  for (;;) {
    const parent: Node | undefined = current.getParent()
    if (!parent) return current

    const carriesUs =
      (Node.isPropertyAccessExpression(parent) ||
        Node.isElementAccessExpression(parent) ||
        Node.isNonNullExpression(parent) ||
        Node.isParenthesizedExpression(parent) ||
        Node.isAsExpression(parent) ||
        Node.isSatisfiesExpression(parent)) &&
      parent.getExpression() === current

    if (!carriesUs) return current
    current = parent
  }
}
