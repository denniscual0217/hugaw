import type { CallExpression, Identifier } from "ts-morph"
import type { JsonValue, SliceExtractor } from "../../../core/index.js"
import type { FunctionLike, TsTypes } from "../../../adapters/typescript/index.js"
import { bodyCalls } from "../analysis/body-calls.js"
import type { BodyCall } from "../analysis/body-calls.js"
import { effectCallbackOf, externalReferences } from "../analysis/effects.js"
import { stateSetters } from "../analysis/state-setters.js"

export interface EffectBodySlice {
  readonly calls: readonly BodyCall[]
  readonly resolved: Readonly<Record<string, string>>
  readonly unresolved: readonly string[]
  readonly externals: readonly string[]
}

const EMPTY: EffectBodySlice = { calls: [], resolved: {}, unresolved: [], externals: [] }

export function effectBodyOf(call: CallExpression, unit: FunctionLike): EffectBodySlice {
  const { callback } = effectCallbackOf(call)
  if (callback === null) return EMPTY

  const setters = stateSetters(unit)
    .map((declared) => declared.setter)
    .filter((setter): setter is Identifier => setter !== null)

  const { calls, resolved, unresolved } = bodyCalls(callback, unit, setters)
  return { calls, resolved, unresolved, externals: externalReferences(callback) }
}

export const effectBody: SliceExtractor<TsTypes> = {
  scope: "candidate",
  extract({ candidate, unit }): JsonValue {
    return effectBodyOf(candidate.node as CallExpression, unit) as unknown as JsonValue
  },
}
