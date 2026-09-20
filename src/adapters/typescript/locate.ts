import type { Node } from "ts-morph"
import type { Location } from "../../core/types.js"

/** `getLineAndColumnAtPos` is already 1-based, matching ESLint. Do not add 1. */
export function locate(node: Node): Location {
  const file = node.getSourceFile()
  const start = file.getLineAndColumnAtPos(node.getStart())
  const end = file.getLineAndColumnAtPos(node.getEnd())
  return {
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
  }
}
