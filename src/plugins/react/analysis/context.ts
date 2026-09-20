import { Node } from "ts-morph"
import type { Identifier, JsxAttribute } from "ts-morph"
import { resolveDeclaration } from "../../../adapters/typescript/imports.js"
import { accessChainRoot } from "./access.js"
import { isReactApi } from "./react-imports.js"

function isContextBinding(tagName: Node): boolean {
  if (!Node.isIdentifier(tagName)) return false
  const declaration = resolveDeclaration(tagName)
  if (!declaration || !Node.isVariableDeclaration(declaration)) return false
  const initializer = declaration.getInitializer()
  if (!initializer || !Node.isCallExpression(initializer)) return false
  return isReactApi(initializer.getExpression(), "createContext")
}

/**
 * The tag text when `attribute` is a context `value` prop — either the classic
 * `<X.Provider value={…}>` or the React 19 `<Ctx value={…}>` where `Ctx` came
 * from `createContext(...)`. Returns null otherwise.
 */
export function contextValueTagOf(attribute: JsxAttribute): string | null {
  if (attribute.getNameNode().getText() !== "value") return null

  const element = attribute.getFirstAncestor(
    (n) => Node.isJsxOpeningElement(n) || Node.isJsxSelfClosingElement(n),
  )
  if (!element || (!Node.isJsxOpeningElement(element) && !Node.isJsxSelfClosingElement(element))) {
    return null
  }

  const tagName = element.getTagNameNode()
  const text = tagName.getText()
  if (Node.isPropertyAccessExpression(tagName) && tagName.getNameNode().getText() === "Provider") {
    return text
  }
  if (isContextBinding(tagName)) return text
  return null
}

/**
 * The JSX attribute this reference is the initializer of, if any.
 *
 * Resolved through a member-access chain, so `<Ctx.Provider value={data.v}>`
 * is caught as well as `value={data}`.
 */
export function enclosingValueAttribute(identifier: Identifier): JsxAttribute | null {
  const expression = accessChainRoot(identifier).getParent()
  if (!expression || !Node.isJsxExpression(expression)) return null
  const attribute = expression.getParent()
  if (!attribute || !Node.isJsxAttribute(attribute)) return null
  return attribute
}
