import type { CallExpression } from "ts-morph"
import type { JsonValue, SliceExtractor } from "../../../core/index.js"
import type { FunctionLike, TsTypes } from "../../../adapters/typescript/index.js"
import {
  dependencyRoots,
  depsKindOf,
  effectCallbackOf,
  hasCleanup,
  readsOutsideDeps,
} from "../analysis/effects.js"
import type { DepsKind } from "../analysis/effects.js"
import { truncate } from "./component-source.js"

const MAX_SOURCE_CHARS = 4_000

export type CallbackShape = "inline" | { readonly name: string; readonly resolved: boolean }

export interface EffectCallSlice {
  readonly line: number
  readonly endLine: number
  readonly source: string
  readonly deps: readonly string[] | null
  readonly depsKind: DepsKind
  readonly hasCleanup: boolean
  readonly callback: CallbackShape
  readonly readsOutsideDeps: readonly string[]
}

export function effectCallOf(call: CallExpression, unit: FunctionLike): EffectCallSlice {
  const { callback, callbackName, resolved } = effectCallbackOf(call)
  const { kind, deps } = depsKindOf(call)

  return {
    line: call.getStartLineNumber(),
    endLine: call.getEndLineNumber(),
    source: truncate(call.getText(), MAX_SOURCE_CHARS),
    deps,
    depsKind: kind,
    hasCleanup: callback === null ? false : hasCleanup(callback),
    callback: callbackName === null ? "inline" : { name: callbackName, resolved },
    // A fact, never a verdict — and never phrased as a missing dependency.
    // `exhaustive-deps` owns that; this rule uses the same shape as evidence
    // for "mount-only, and should be keyed on what it reads" and for "one
    // trigger plus one value only read for its latest value".
    readsOutsideDeps:
      callback === null ? [] : readsOutsideDeps(callback, deps === null ? null : dependencyRoots(call), unit),
  }
}

export const effectCall: SliceExtractor<TsTypes> = {
  scope: "candidate",
  extract({ candidate, unit }): JsonValue {
    return effectCallOf(candidate.node as CallExpression, unit) as unknown as JsonValue
  },
}
