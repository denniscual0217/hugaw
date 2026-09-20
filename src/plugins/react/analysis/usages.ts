import { Node } from "ts-morph"
import type { Identifier } from "ts-morph"
import { accessChainRoot } from "./access.js"
import { dependencyArrayHookOf, hookArgumentOf } from "./hooks.js"

export type UsageKind =
  | "jsx-child"
  | "jsx-prop"
  | "member-access"
  | "call-argument"
  | "hook-argument"
  | "spread"
  | "returned"
  | "assigned"
  | "other"

export interface Usage {
  readonly line: number
  readonly kind: UsageKind
  readonly description: string
  /**
   * False when we cannot see what the consumer does with the value — a spread
   * hides the prop names, an unrecognised position hides the intent. These
   * drive the "verify before removing" caveat rather than being guessed at.
   */
  readonly resolved: boolean
}

/**
 * The tag of the JSX element a node sits in.
 *
 * A child expression's nearest JSX ancestor is the `JsxElement`, not its
 * opening element (which is a sibling) — missing that made every jsx-child
 * description read `<?>` and blanked the tag out of the state behind the
 * identity question.
 */
function jsxTagOf(node: Node): string {
  const element = node.getFirstAncestor(
    (n) =>
      Node.isJsxOpeningElement(n) ||
      Node.isJsxSelfClosingElement(n) ||
      Node.isJsxElement(n) ||
      Node.isJsxFragment(n),
  )
  if (!element) return "?"
  if (Node.isJsxElement(element)) return element.getOpeningElement().getTagNameNode().getText()
  if (Node.isJsxFragment(element)) return "Fragment"
  if (Node.isJsxOpeningElement(element) || Node.isJsxSelfClosingElement(element)) {
    return element.getTagNameNode().getText()
  }
  return "?"
}

/**
 * A short, model-readable description of how one reference is consumed.
 *
 * Positional checks run against the *access chain root*, and they run before
 * the member-access fallback: `[data.items]` is a dependency array first and a
 * property read second, and describing it the other way round hides the one
 * fact that decides the verdict.
 */
export function classifyUsage(identifier: Identifier): Usage {
  const line = identifier.getStartLineNumber()
  const root = accessChainRoot(identifier)
  const readAs = `\`${root.getText()}\``
  const parent = root.getParent()
  const usage = (kind: UsageKind, description: string, resolved = true): Usage => ({
    line,
    kind,
    description,
    resolved,
  })

  if (!parent) return usage("other", `${readAs} in an unknown position`, false)

  if (Node.isJsxSpreadAttribute(parent)) {
    return usage("spread", `${readAs} spread onto <${jsxTagOf(parent)}>, so the props read are unknown`, false)
  }
  if (Node.isSpreadElement(parent) || Node.isSpreadAssignment(parent)) {
    return usage("spread", `${readAs} spread into a literal, so the fields read are unknown`, false)
  }

  const depHook = dependencyArrayHookOf(identifier)
  if (depHook !== null) {
    return usage("hook-argument", `${readAs} listed in the dependency array of ${depHook}()`)
  }

  const argHook = hookArgumentOf(identifier)
  if (argHook !== null) return usage("hook-argument", `${readAs} passed to the hook ${argHook}()`)

  if (Node.isJsxExpression(parent)) {
    const grandparent = parent.getParent()
    if (grandparent && Node.isJsxAttribute(grandparent)) {
      return usage(
        "jsx-prop",
        `${readAs} passed as prop \`${grandparent.getNameNode().getText()}\` to <${jsxTagOf(grandparent)}>`,
      )
    }
    return usage("jsx-child", `${readAs} rendered as a child of <${jsxTagOf(parent)}>`)
  }

  if (Node.isCallExpression(parent) && parent.getArguments().includes(root)) {
    return usage("call-argument", `${readAs} passed to \`${parent.getExpression().getText()}()\``)
  }

  if (Node.isReturnStatement(parent)) return usage("returned", `${readAs} returned from the enclosing function`)

  if (Node.isBinaryExpression(parent) && parent.getOperatorToken().getText() === "=") {
    if (parent.getRight() === root) {
      return usage("assigned", `${readAs} assigned to \`${parent.getLeft().getText()}\``)
    }
  }

  // A plain field read that reaches no position we recognise.
  if (root !== identifier) return usage("member-access", `read as ${readAs}`)

  if (Node.isTemplateSpan(parent) || Node.isBinaryExpression(parent)) {
    return usage("other", `${readAs} combined into an expression`)
  }

  return usage("other", `${readAs} used as ${parent.getKindName()}`, false)
}
