import { Node, SyntaxKind } from "ts-morph"
import type { JsonValue, SliceExtractor } from "../../../core/index.js"
import type { FunctionLike, TsTypes } from "../../../adapters/typescript/index.js"

const MAX_CHARS = 12_000

export function truncate(source: string, max: number): string {
  if (source.length <= max) return source
  return `${source.slice(0, max)}\n/* …truncated… */`
}

function declarationTextOf(unit: FunctionLike): string {
  if (Node.isFunctionDeclaration(unit) || Node.isMethodDeclaration(unit)) return unit.getText()
  // `const Price = () => {…}` reads better to the model with its binding.
  const statement = unit.getFirstAncestorByKind(SyntaxKind.VariableStatement)
  return statement ? statement.getText() : unit.getText()
}

/** Unit-scoped: every candidate in one component shares this, so build it once. */
export const componentSource: SliceExtractor<TsTypes> = {
  scope: "unit",
  extract({ unit }): JsonValue {
    return truncate(declarationTextOf(unit), MAX_CHARS)
  },
}
