import { Node } from "ts-morph"
import type { FunctionLike } from "./types.js"

export function isFunctionLike(node: Node): node is FunctionLike {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node) ||
    Node.isMethodDeclaration(node)
  )
}

/** Nearest enclosing function-like; null at module scope. */
export function unitOf(node: Node): FunctionLike | null {
  if (isFunctionLike(node)) return node
  return node.getFirstAncestor(isFunctionLike) ?? null
}

export function unitKey(unit: FunctionLike): string {
  return `${unit.getSourceFile().getFilePath()}#${unit.getStart()}`
}

export function unitName(unit: FunctionLike): string {
  if (Node.isFunctionDeclaration(unit) || Node.isMethodDeclaration(unit)) {
    return unit.getName() ?? "<anonymous>"
  }
  const parent = unit.getParent()
  if (parent && Node.isVariableDeclaration(parent)) return parent.getName()
  if (parent && Node.isPropertyAssignment(parent)) return parent.getName()
  // `const X = memo(() => ...)`: name the unit after the wrapper's binding.
  const declaration = unit.getFirstAncestor(Node.isVariableDeclaration)
  if (declaration) return declaration.getName()
  return "<anonymous>"
}
