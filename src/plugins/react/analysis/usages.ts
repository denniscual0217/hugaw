import { Node, SyntaxKind } from "ts-morph"
import type { Identifier } from "ts-morph"
import type { FunctionLike } from "../../../adapters/typescript/types.js"
import { unitName } from "../../../adapters/typescript/units.js"
import { accessChainRoot } from "./access.js"
import { contextValueTagOf } from "./context.js"
import { escapeOf } from "./escapes.js"
import { dependencyArrayHookOf, hookArgumentOf, hookArgumentSemantics } from "./hooks.js"
import { isMemoComponentTag } from "./memo-components.js"

const LOGICAL_OPERATORS = new Set(["&&", "||", "??"])

/** The community convention that marks a function as a hook. */
function isHookName(name: string): boolean {
  return /^use[A-Z]/.test(name)
}

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
export function classifyUsage(identifier: Identifier, unit: FunctionLike): Usage {
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
  if (argHook !== null) {
    const semantics = hookArgumentSemantics(identifier)
    return usage(
      "hook-argument",
      semantics === null
        ? `${readAs} passed to the hook ${argHook}()`
        : `${readAs} passed to ${argHook}(), ${semantics}`,
    )
  }

  if (Node.isJsxExpression(parent)) {
    const grandparent = parent.getParent()
    if (grandparent && Node.isJsxAttribute(grandparent)) {
      const prop = grandparent.getNameNode().getText()
      const tag = jsxTagOf(grandparent)

      // A context value reaches every consumer of that context, anywhere.
      const contextTag = contextValueTagOf(grandparent)
      if (contextTag !== null) {
        return usage(
          "jsx-prop",
          `${readAs} passed as the \`value\` prop of <${contextTag}>, so every consumer of that context receives it`,
        )
      }

      // A React.memo child compares its props by reference — the single most
      // important fact the identity question can be given.
      const element = grandparent.getFirstAncestor(
        (n) => Node.isJsxOpeningElement(n) || Node.isJsxSelfClosingElement(n),
      )
      if (
        element &&
        (Node.isJsxOpeningElement(element) || Node.isJsxSelfClosingElement(element)) &&
        isMemoComponentTag(element.getTagNameNode())
      ) {
        return usage(
          "jsx-prop",
          `${readAs} passed as the \`${prop}\` prop to <${tag}>, which is wrapped in React.memo and compares its props by reference`,
        )
      }

      return usage("jsx-prop", `${readAs} passed as prop \`${prop}\` to <${tag}>`)
    }
    return usage("jsx-child", `${readAs} rendered as a child of <${jsxTagOf(parent)}>`)
  }

  if (Node.isCallExpression(parent) && parent.getArguments().includes(root)) {
    return usage("call-argument", `${readAs} passed to \`${parent.getExpression().getText()}()\``)
  }

  // Returned or written outward — the value outlives this render, and the
  // consumers are in files we cannot see.
  const escape = escapeOf(identifier, unit)
  if (escape !== null) {
    if (escape.kind === "returned") {
      const owner = unitName(unit)
      const via = escape.wrapped ? "inside the object it returns" : "directly"
      return usage(
        "returned",
        isHookName(owner)
          ? `${readAs} returned ${via} from the custom hook \`${owner}\`, so callers outside this file receive it`
          : `${readAs} returned ${via} from \`${owner}\`, so its callers receive it`,
      )
    }
    return usage(
      "assigned",
      escape.intoMember
        ? `${readAs} assigned to \`${escape.target}\`, a member that outlives this render`
        : `${readAs} assigned to \`${escape.target}\`, declared outside this function`,
    )
  }

  // Truthiness tests consume the value without caring about its identity —
  // the `isOpen && <Modal/>` render guard being the commonest React idiom.
  if (Node.isConditionalExpression(parent) && parent.getCondition() === root) {
    return usage("other", `${readAs} tested for truthiness as a condition`)
  }
  if (Node.isIfStatement(parent) && parent.getExpression() === root) {
    return usage("other", `${readAs} tested for truthiness in an \`if\``)
  }
  if (Node.isPrefixUnaryExpression(parent)) {
    return parent.getOperatorToken() === SyntaxKind.ExclamationToken
      ? usage("other", `${readAs} negated with \`!\``)
      : usage("other", `${readAs} used in arithmetic`)
  }
  if (Node.isBinaryExpression(parent)) {
    const operator = parent.getOperatorToken().getText()
    if (LOGICAL_OPERATORS.has(operator) && parent.getLeft() === root) {
      return usage("other", `${readAs} tested for truthiness in a \`${operator}\` expression`)
    }
  }

  // Captured by an inline callback — common around hooks, and "used as
  // ArrowFunction" told the model nothing.
  if (Node.isArrowFunction(parent) && parent.getBody() === root) {
    const call = parent.getParent()
    const owner =
      call && Node.isCallExpression(call) ? ` passed to \`${call.getExpression().getText()}()\`` : ""
    return usage("other", `${readAs} returned from an inline callback${owner}`)
  }

  // A plain field read that reaches no position we recognise.
  if (root !== identifier) return usage("member-access", `read as ${readAs}`)

  if (Node.isTemplateSpan(parent) || Node.isBinaryExpression(parent)) {
    return usage("other", `${readAs} combined into an expression`)
  }

  return usage("other", `${readAs} used as ${parent.getKindName()}`, false)
}
