import { Node } from "ts-morph"
import type { Expression } from "ts-morph"
import { resolveDeclaration } from "../../../adapters/typescript/imports.js"
import { isReactApi } from "./react-imports.js"

/** Unwraps `memo(forwardRef(X))`, `React.memo(X)`, `memo(X)`. */
function isMemoCall(expression: Expression | undefined): boolean {
  if (!expression) return false
  if (!Node.isCallExpression(expression)) return false
  return isReactApi(expression.getExpression(), "memo")
}

/**
 * Whether a JSX tag names a component created with `React.memo`.
 *
 * Handles same-file `const Child = memo(...)` and cross-file
 * `export default memo(Child)` reached through a default import. This is the
 * single most important false-positive guard in the rule: a memoized child is
 * precisely the case where a stable reference earns its keep.
 */
export function isMemoComponentTag(tagName: Node): boolean {
  if (!Node.isIdentifier(tagName)) return false

  const declaration = resolveDeclaration(tagName)
  if (!declaration) return false

  if (Node.isVariableDeclaration(declaration)) {
    return isMemoCall(declaration.getInitializer())
  }
  if (Node.isExportAssignment(declaration)) {
    return isMemoCall(declaration.getExpression())
  }
  return false
}
