import { Node } from "ts-morph"
import type { CallExpression } from "ts-morph"
import type { JsonValue, SliceExtractor } from "../../../core/index.js"
import type { TsTypes } from "../../../adapters/typescript/index.js"
import type { MemoData } from "../rules/memo-data.js"

/** The dependency array as written, or null when the second argument is absent. */
export function depsOf(call: CallExpression): string[] | null {
  const second = call.getArguments()[1]
  if (!second || !Node.isArrayLiteralExpression(second)) return null
  return second.getElements().map((e) => e.getText())
}

export const memoCall: SliceExtractor<TsTypes> = {
  scope: "candidate",
  extract({ candidate }): JsonValue {
    const call = candidate.node as CallExpression
    const data = candidate.data as MemoData
    return {
      line: candidate.loc.line,
      source: call.getText(),
      binding: data.binding?.getText() ?? null,
      deps: depsOf(call),
    }
  },
}
