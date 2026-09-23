import { Node, SyntaxKind } from "ts-morph"
import type { CallExpression, Identifier } from "ts-morph"
import { resolveDeclaration } from "../../../adapters/typescript/imports.js"
import type { FunctionLike } from "../../../adapters/typescript/types.js"
import { bodyCalls, isRootCall } from "./body-calls.js"
import { effectCallbackOf, externalReferences } from "./effects.js"
import { stateSetters } from "./state-setters.js"

/**
 * What a same-file helper does, when the effect only calls the helper.
 *
 * The observation clause is built from calls in the effect body, so an effect
 * whose whole content is `evaluateCount(count)` produced the sentence "This
 * effect calls `evaluateCount(count)`" and stopped — even though
 * `evaluateCount` sets state, the payload carried its inlined body, and the
 * model had read it and judged correctly. A right verdict whose sentence
 * shows none of the evidence reads as a miss, which is the worst failure this
 * rule has: the message is the product.
 *
 * So the message follows the same one level the payload already inlines.
 * Everything the observation and the fix phrases draw on is collected through
 * it — state this unit declares, callback props, external handles, and calls
 * that leave the component.
 *
 * **One level, deliberately.** `effect_body.resolved` inlines the bodies of
 * same-file callees and nothing deeper, so that is exactly how far the
 * evidence goes. Following further would describe code that was never sent to
 * the model and never shown to the reader.
 */
// A `type` with mutable arrays, not an interface: this rides in `facts`, and
// core's `JsonValue` admits neither an interface nor a `readonly` array.
export type IndirectCall = {
  /** The helper as called in the effect body, e.g. `evaluateCount`. */
  callee: string
  /** State this unit declares that the helper writes, by value name. */
  states: string[]
  propCallbacks: string[]
  /** `name(args)` for calls that leave the component. */
  outwardCalls: string[]
  externals: string[]
}

/** Call kinds that reach out of the component, as the message names them. */
const OUTWARD = new Set(["imported", "global", "hook-result", "unresolved"])

/**
 * The function an identifier names, when it is one we can actually read.
 *
 * The same test `callee_sources` uses to decide what to inline, so the
 * message never describes a body the model was not given.
 */
export function resolvedFunctionOf(identifier: Identifier): FunctionLike | null {
  const declaration = resolveDeclaration(identifier)
  if (!declaration) return null
  if (declaration.getSourceFile().isDeclarationFile()) return null
  if (declaration.getSourceFile().getFilePath() !== identifier.getSourceFile().getFilePath()) {
    return null
  }
  if (Node.isFunctionDeclaration(declaration)) return declaration
  if (Node.isVariableDeclaration(declaration)) {
    const initializer = declaration.getInitializer()
    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
      return initializer
    }
  }
  return null
}

/** One entry per same-file helper the effect calls that does something nameable. */
export function indirectCallsOf(call: CallExpression, unit: FunctionLike): IndirectCall[] {
  const { callback } = effectCallbackOf(call)
  if (callback === null) return []

  const setters = stateSetters(unit)
  const setterIdentifiers = setters
    .map((declared) => declared.setter)
    .filter((setter): setter is Identifier => setter !== null)
  const stateOf = new Map(
    setters.flatMap((declared) =>
      declared.setter === null ? [] : [[declared.setter.getText(), declared.value] as const],
    ),
  )

  const found: IndirectCall[] = []
  const seen = new Set<string>()

  for (const inner of callback.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = inner.getExpression()
    if (!Node.isIdentifier(callee)) continue
    const name = callee.getText()
    if (seen.has(name)) continue

    const fn = resolvedFunctionOf(callee)
    // A helper that is the effect's own callback would be walked twice, and
    // its contents are already the direct observation.
    if (fn === null || fn === callback) continue
    seen.add(name)

    const { calls } = bodyCalls(fn, unit, setterIdentifiers)
    const entry: IndirectCall = {
      callee: name,
      states: unique([
        ...calls
          .filter((row) => row.kind === "state-setter")
          .map((row) => stateOf.get(row.callee) ?? row.callee),
        // `.then(setUser)` never calls the setter here, but the state is
        // written all the same — the direct path already counts this.
        ...[...stateOf.entries()].flatMap(([setter, value]) =>
          calls.some((row) => mentions(row.arguments, setter)) ? [value] : [],
        ),
      ]),
      propCallbacks: unique(
        calls.filter((row) => row.kind === "prop-callback").map((row) => row.callee),
      ),
      outwardCalls: unique(
        calls
          .filter((row) => OUTWARD.has(row.kind) && isRootCall(row))
          .map((row) => `${row.callee}(${row.arguments})`),
      ),
      externals: externalReferences(fn),
    }
    if (
      entry.states.length > 0 ||
      entry.propCallbacks.length > 0 ||
      entry.outwardCalls.length > 0 ||
      entry.externals.length > 0
    ) {
      found.push(entry)
    }
  }
  return found
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)]
}

/** Whole-word match, so `setUser` is not found inside `setUsername`. */
function mentions(text: string, name: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_$])${name}([^A-Za-z0-9_$]|$)`).test(text)
}
