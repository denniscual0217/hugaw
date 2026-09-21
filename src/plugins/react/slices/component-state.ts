import { Node } from "ts-morph"
import type { JsonValue, SliceExtractor } from "../../../core/index.js"
import type { FunctionLike, TsTypes } from "../../../adapters/typescript/index.js"
import { unitName } from "../../../adapters/typescript/index.js"
import { hookResultsOf } from "../analysis/body-calls.js"
import type { HookResult } from "../analysis/body-calls.js"
import { stateSetters, writeSitesOf } from "../analysis/state-setters.js"
import type { StateWrite } from "../analysis/state-setters.js"

export type OwnerKind = "component" | "hook" | "other"

export interface DeclaredState {
  readonly value: string
  readonly setter: string | null
  readonly hook: "useState" | "useReducer"
  readonly initial: string | null
  readonly writes: readonly StateWrite[]
}

export interface ComponentState {
  readonly owner: { readonly name: string; readonly kind: OwnerKind }
  readonly props: readonly string[]
  readonly state: readonly DeclaredState[]
  readonly hookResults: readonly HookResult[]
}

/**
 * A third of the effects in a real codebase live in custom hooks, so "the
 * component" is the wrong word for the unit. `owner.kind` says which it is,
 * and the questions are phrased against it: a hook has arguments where a
 * component has props, and "call the parent's callback" means "call the
 * argument the caller passed" when the unit is a hook.
 */
export function ownerKindOf(name: string): OwnerKind {
  if (/^use[A-Z]/.test(name)) return "hook"
  if (/^[A-Z]/.test(name)) return "component"
  return "other"
}

/** The unit's parameters, flattened through one level of destructuring. */
export function propsOf(unit: FunctionLike): string[] {
  const names: string[] = []
  for (const parameter of unit.getParameters()) {
    const nameNode = parameter.getNameNode()
    if (Node.isIdentifier(nameNode)) {
      names.push(nameNode.getText())
      continue
    }
    if (Node.isObjectBindingPattern(nameNode)) {
      for (const element of nameNode.getElements()) {
        const name = element.getNameNode()
        if (Node.isIdentifier(name)) names.push(name.getText())
      }
    }
  }
  return names
}

export function componentStateOf(unit: FunctionLike): ComponentState {
  const state: DeclaredState[] = stateSetters(unit).map((declared) => ({
    value: declared.value,
    setter: declared.setter?.getText() ?? null,
    hook: declared.hook,
    initial: declared.initial,
    writes: declared.setter === null ? [] : writeSitesOf(declared.setter, unit),
  }))

  const name = unitName(unit)
  return {
    owner: { name, kind: ownerKindOf(name) },
    props: propsOf(unit),
    state,
    hookResults: hookResultsOf(unit),
  }
}

/**
 * Unit scope, because every effect in one component needs the same answer to
 * "what state is declared here, and where else is it written".
 *
 * The memo rule keeps its statically computed facts off the wire on the
 * grounds that no question consults them. Here a question does: every option
 * that says "the handler could have done this" is an assertion about a write
 * site the model can only see if we send it.
 */
export const componentState: SliceExtractor<TsTypes> = {
  scope: "unit",
  extract({ unit }): JsonValue {
    return componentStateOf(unit) as unknown as JsonValue
  },
}
