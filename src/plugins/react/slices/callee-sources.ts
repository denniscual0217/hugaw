import { Node, SyntaxKind } from "ts-morph"
import type { CallExpression, Node as TsNode } from "ts-morph"
import type { JsonValue, SliceExtractor } from "../../../core/index.js"
import type { TsTypes } from "../../../adapters/typescript/index.js"
import { resolveDeclaration } from "../../../adapters/typescript/index.js"
import { truncate } from "./component-source.js"

const MAX_CALLEE_CHARS = 2_000

export interface CalleeSources {
  readonly resolved: Record<string, string>
  readonly unresolved: string[]
}

/**
 * Bodies of the functions the memo factory calls.
 *
 * CALIBRATION.md cases B and D are identical call shapes with opposite
 * verdicts (2.00 vs 0.11), decided purely by the inlined body — this slice is
 * what earns the rule its accuracy. Cross-file callees go to `unresolved`
 * (no digest pass in the MVP) and drive the caveat clause.
 */
export function calleeSourcesOf(call: CallExpression): CalleeSources {
  const factory = call.getArguments()[0]
  if (!factory) return { resolved: {}, unresolved: [] }
  return calleeSourcesIn(factory, call.getSourceFile().getFilePath())
}

/**
 * The same walk over an arbitrary scope.
 *
 * `calleeSourcesOf` is the memo rule's entry point (the factory is argument
 * zero); rule #2 hands in an effect callback, which may be a separately
 * declared function rather than an argument. One implementation, because the
 * decision being made — inline the body or name it as a blind spot — is the
 * same decision in both rules, and a second copy would drift from the
 * calibration that justifies it.
 */
export function calleeSourcesIn(scope: TsNode, filePath: string): CalleeSources {
  const resolved: Record<string, string> = {}
  const unresolved: string[] = []

  for (const inner of scope.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = inner.getExpression()
    // Only bare identifiers: `obj.method()` belongs to a value, not a module.
    if (!Node.isIdentifier(callee)) continue
    const name = callee.getText()
    if (Object.hasOwn(resolved, name) || unresolved.includes(name)) continue

    const declaration = resolveDeclaration(callee)
    // An ambient declaration is not a blind spot. `fetch`, `setTimeout` and
    // `parseInt` resolve to a `.d.ts` in another file, which the cross-file
    // test below would read as "unresolved" and caveat on every effect in any
    // project with `lib.dom` — a caveat that names a global everyone can
    // already see, on the majority of findings, is noise that teaches an
    // agent to skip the caveat line. The platform's own signatures are also
    // the one case where the *name alone* is a reliable description, which is
    // exactly what CALIBRATION.md case C says cross-file names are not.
    if (declaration?.getSourceFile().isDeclarationFile()) continue
    if (!declaration || declaration.getSourceFile().getFilePath() !== filePath) {
      unresolved.push(name)
      continue
    }
    const body = functionBodyOf(declaration)
    if (!body) {
      // A parameter, a destructured prop, or a binding whose initializer is
      // not a literal function: we have a name and no body. Recording the
      // name *as* the body would tell the model `transform` does whatever
      // "transform" sounds like — the exact failure mode CALIBRATION.md
      // case C warns about, minus its only mitigation.
      unresolved.push(name)
      continue
    }
    resolved[name] = truncate(body.getText(), MAX_CALLEE_CHARS)
  }

  return { resolved, unresolved }
}

/** The node whose text actually shows what a callee does, or null if we have none. */
export function functionBodyOf(declaration: TsNode): TsNode | null {
  if (Node.isFunctionDeclaration(declaration)) return declaration
  if (Node.isVariableDeclaration(declaration)) {
    const initializer = declaration.getInitializer()
    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
      return declaration.getFirstAncestorByKind(SyntaxKind.VariableStatement) ?? declaration
    }
  }
  return null
}

export const calleeSources: SliceExtractor<TsTypes> = {
  scope: "candidate",
  extract({ candidate }): JsonValue {
    const { resolved, unresolved } = calleeSourcesOf(candidate.node as CallExpression)
    return { resolved, unresolved }
  },
}
