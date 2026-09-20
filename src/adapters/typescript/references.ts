import { Node, SyntaxKind } from "ts-morph"
import type { Identifier } from "ts-morph"

/**
 * Every identifier inside `scope` that resolves to the same symbol as
 * `nameNode`, excluding the declaration itself.
 *
 * Symbol equality (not text equality) is what makes shadowing safe: an inner
 * `const label = …` produces a different symbol and is not counted as a usage
 * of the memoized binding.
 */
export function referencesWithin(nameNode: Identifier, scope: Node): Identifier[] {
  const symbol = nameNode.getSymbol()
  if (!symbol) return []
  const target = symbol.compilerSymbol
  const text = nameNode.getText()

  return scope
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .filter((identifier) => {
      if (identifier === nameNode) return false
      if (identifier.getText() !== text) return false
      // Property names in `{ label: x }` / `obj.label` are not references.
      const parent = identifier.getParent()
      if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) return false
      if (Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier) return false
      if (Node.isJsxAttribute(parent) && parent.getNameNode() === identifier) return false
      // In `{ label }` the identifier's own symbol is the *property*; the
      // value it closes over needs the shorthand's value symbol.
      const own = Node.isShorthandPropertyAssignment(parent)
        ? parent.getValueSymbol()
        : identifier.getSymbol()
      return own !== undefined && own.compilerSymbol === target
    })
}
