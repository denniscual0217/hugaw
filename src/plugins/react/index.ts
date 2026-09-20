import { definePlugin } from "../../core/index.js"
import type { TsTypes } from "../../adapters/typescript/index.js"
import { pointlessUseMemo } from "./rules/pointless-usememo.js"
import { calleeSources } from "./slices/callee-sources.js"
import { componentSource } from "./slices/component-source.js"
import { memoCall } from "./slices/memo-call.js"
import { valueUsages } from "./slices/value-usages.js"

/**
 * React is hugaw's first *plugin*, not its subject. Everything React-specific
 * lives under this directory; `src/core` knows only about rules and slices.
 */
export const react = definePlugin<TsTypes>({
  id: "react",
  language: "typescript",
  rules: [pointlessUseMemo],
  slices: {
    component_source: componentSource,
    memo_call: memoCall,
    value_usages: valueUsages,
    callee_sources: calleeSources,
  },
})

export { pointlessUseMemo } from "./rules/pointless-usememo.js"
export type { MemoFacts } from "./rules/pointless-usememo.js"
export type { MemoData } from "./rules/memo-data.js"
export default react
