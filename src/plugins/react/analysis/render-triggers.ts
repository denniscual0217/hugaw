import { Node, SyntaxKind } from "ts-morph"
import type { CallExpression, Expression } from "ts-morph"
import type { FunctionLike } from "../../../adapters/typescript/types.js"
import { unitOf } from "../../../adapters/typescript/units.js"
import { isHookCall } from "./hooks.js"
import { isReactApi } from "./react-imports.js"

/**
 * Hooks whose result is not a reactive input: a ref is stable for the
 * component's life, and a memo or callback is derived from inputs rather than
 * being one.
 */
const DERIVED_HOOKS = ["useRef", "useMemo", "useCallback"]

/**
 * The component's reactive inputs — the things whose change makes it render
 * again: its props, its own `useState`/`useReducer` values, its `useContext`
 * results, and the return values of any other hook it calls.
 *
 * Only React's own hooks are recognised as such; a local function sharing the
 * name is resolved through `isReactApi` like everywhere else.
 */
export function renderTriggers(unit: FunctionLike): string[] {
  const names = new Set<string>()

  for (const parameter of unit.getParameters()) {
    const nameNode = parameter.getNameNode()
    if (Node.isIdentifier(nameNode)) {
      names.add(nameNode.getText())
    } else if (Node.isObjectBindingPattern(nameNode)) {
      for (const element of nameNode.getElements()) {
        const name = element.getNameNode()
        if (Node.isIdentifier(name)) names.add(name.getText())
      }
    }
  }

  const body = unit.getBody()
  if (body) {
    for (const declaration of body.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      // Declarations inside a nested callback belong to that callback.
      if (unitOf(declaration) !== unit) continue
      const initializer = declaration.getInitializer()
      if (!initializer || !Node.isCallExpression(initializer)) continue
      const callee = initializer.getExpression()
      const nameNode = declaration.getNameNode()

      if (isReactApi(callee, "useState") || isReactApi(callee, "useReducer")) {
        // `[value, setValue]` — the setter is stable and never triggers a
        // render, so only the first element counts as an input.
        if (Node.isArrayBindingPattern(nameNode)) {
          const first = nameNode.getElements()[0]
          if (first && Node.isBindingElement(first)) {
            const name = first.getNameNode()
            if (Node.isIdentifier(name)) names.add(name.getText())
          }
        } else if (Node.isIdentifier(nameNode)) {
          names.add(nameNode.getText())
        }
        continue
      }

      if (isReactApi(callee, "useContext")) {
        if (Node.isIdentifier(nameNode)) names.add(nameNode.getText())
        continue
      }

      if (DERIVED_HOOKS.some((hook) => isReactApi(callee, hook))) continue

      // Any other hook: its result may differ from render to render.
      //
      // Accepted over-count: `useNavigate`, `useId` and the like return
      // stable values, so counting them widens the input set and can suppress
      // a finding we could have made. That is the burden-of-proof direction,
      // and narrowing it to a known-hooks allowlist would lose the
      // `useQuery`-shaped cases this exists for.
      if (isHookCall(initializer)) {
        for (const name of boundNames(declaration.getNameNode())) names.add(name)
      }
    }
  }

  return [...names].sort()
}

function boundNames(nameNode: Node): string[] {
  if (Node.isIdentifier(nameNode)) return [nameNode.getText()]
  if (Node.isArrayBindingPattern(nameNode) || Node.isObjectBindingPattern(nameNode)) {
    return nameNode.getElements().flatMap((element) => {
      if (!Node.isBindingElement(element)) return []
      return boundNames(element.getNameNode())
    })
  }
  return []
}

/** The identifier a dependency expression is rooted at: `data.items` -> `data`. */
function baseIdentifierOf(expression: Expression): string | null {
  let current: Node = expression
  while (
    Node.isPropertyAccessExpression(current) ||
    Node.isElementAccessExpression(current) ||
    Node.isNonNullExpression(current) ||
    Node.isParenthesizedExpression(current)
  ) {
    current = current.getExpression()
  }
  return Node.isIdentifier(current) ? current.getText() : null
}

export interface DependencyCoverage {
  readonly triggers: string[]
  /**
   * True when the dependency array is a *proper* subset of the component's
   * reactive inputs: every dep is an input we can reason about, and at least
   * one input is not a dep. Some renders therefore provably leave every dep
   * unchanged, and the memo genuinely skips work on them.
   */
  readonly rendersWithUnchangedDeps: boolean
}

/**
 * Whether this memo demonstrably saves work on renders that actually happen.
 *
 * Computed, never asked: it is set arithmetic over facts we already hold, so
 * asking the model would be both slower and less reliable.
 *
 * Deliberately limited to the *proper* subset case. When the deps equal the
 * inputs exactly, whether the memo pays off depends on whether callers
 * re-render with stable props — the same cross-file problem as `React.memo`,
 * and out of MVP scope (SPEC §7).
 */
export function dependencyCoverage(call: CallExpression, unit: FunctionLike): DependencyCoverage {
  const triggers = renderTriggers(unit)
  const second = call.getArguments()[1]
  if (!second || !Node.isArrayLiteralExpression(second)) {
    return { triggers, rendersWithUnchangedDeps: false }
  }

  const roots = new Set<string>()
  for (const element of second.getElements()) {
    const base = baseIdentifierOf(element)
    // A dep we cannot root in a name is a dep we cannot reason about.
    if (base === null) return { triggers, rendersWithUnchangedDeps: false }
    roots.add(base)
  }

  const triggerSet = new Set(triggers)
  for (const root of roots) {
    if (!triggerSet.has(root)) return { triggers, rendersWithUnchangedDeps: false }
  }
  return { triggers, rendersWithUnchangedDeps: roots.size < triggerSet.size }
}
