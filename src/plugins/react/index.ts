import { definePlugin } from "../../core/index.js"
import type { TsTypes } from "../../adapters/typescript/index.js"
import { pointlessUseMemo } from "./rules/pointless-usememo.js"
import { useEffectAlternatives } from "./rules/useeffect-alternatives.js"
import { calleeSources } from "./slices/callee-sources.js"
import { componentSource } from "./slices/component-source.js"
import { componentState } from "./slices/component-state.js"
import { effectBody } from "./slices/effect-body.js"
import { effectCall } from "./slices/effect-call.js"
import { memoCall } from "./slices/memo-call.js"
import { valueUsages } from "./slices/value-usages.js"

/**
 * React is hugaw's first *plugin*, not its subject. Everything React-specific
 * lives under this directory; `src/core` knows only about rules and slices.
 */
export const react = definePlugin<TsTypes>({
  id: "react",
  language: "typescript",
  rules: [pointlessUseMemo, useEffectAlternatives],
  slices: {
    component_source: componentSource,
    memo_call: memoCall,
    value_usages: valueUsages,
    callee_sources: calleeSources,
    component_state: componentState,
    effect_call: effectCall,
    effect_body: effectBody,
  },
})

export { pointlessUseMemo } from "./rules/pointless-usememo.js"
export type { MemoFacts } from "./rules/pointless-usememo.js"
export type { MemoData } from "./rules/memo-data.js"
export { useEffectAlternatives } from "./rules/useeffect-alternatives.js"
export type { EffectFacts } from "./rules/useeffect-alternatives.js"
export type { EffectData } from "./rules/effect-data.js"
export type { Replacement } from "./rules/effect-questions.js"
export default react
