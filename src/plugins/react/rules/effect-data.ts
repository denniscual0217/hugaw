/**
 * What `select` learns about a candidate and `decide` would otherwise have to
 * re-derive.
 *
 * Deliberately not the callback node itself. The three slices resolve the
 * callback from the call for their own purposes and are tested standalone; a
 * node carried here as well would be a second source of truth for the same
 * fact, and the only thing `decide` needs is whether the body was reachable —
 * which is what the "defined elsewhere, verify before removing" caveat is
 * built from.
 */
export interface EffectData {
  /** The identifier the callback was passed as, or null when written inline. */
  readonly callbackName: string | null
  /** False when `callbackName` could not be followed to a function body. */
  readonly callbackResolved: boolean
}
