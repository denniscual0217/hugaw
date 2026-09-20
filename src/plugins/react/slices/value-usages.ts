import type { JsonValue, SliceExtractor } from "../../../core/index.js"
import type { FunctionLike, TsTypes } from "../../../adapters/typescript/index.js"
import { referencesWithin } from "../../../adapters/typescript/index.js"
import { classifyUsage } from "../analysis/usages.js"
import type { MemoData } from "../rules/memo-data.js"

/** Every reference to the memoized binding inside the component, with a line and a short description. */
export const valueUsages: SliceExtractor<TsTypes> = {
  scope: "candidate",
  extract({ candidate, unit }): JsonValue {
    const data = candidate.data as MemoData
    if (!data.binding) return []
    return referencesWithin(data.binding, unit as FunctionLike).map((reference) => {
      const usage = classifyUsage(reference)
      return {
        line: usage.line,
        kind: usage.kind,
        description: usage.description,
        resolved: usage.resolved,
      }
    })
  },
}
