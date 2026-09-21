/**
 * What the vendor charges, per model.
 *
 * Lives beside the TypeSafe judge rather than in `src/core` because a price
 * list is a fact about one vendor, and core must stay free of vendor
 * knowledge (SPEC §1). The formatters import it; nothing else does.
 */

export interface ModelRate {
  readonly inputPerMTok: number
  readonly outputPerMTok: number
}

/**
 * Keyed by the *resolved* model id, never by an alias.
 *
 * `jev-latest` is an alias, so the key that can be trusted is the id the
 * response reports back, which is what `RunStats.model` records. An alias
 * silently pointing at a differently priced model is precisely the failure
 * this table must not paper over.
 */
export const PRICING: Record<string, ModelRate> = {
  "jev-1.13.0": { inputPerMTok: 0.042, outputPerMTok: 0 },
}

/**
 * The rate for a model, or null when we do not know it.
 *
 * Null is a real answer and the callers must honour it by printing tokens
 * and no dollar figure. Falling back to another model's rate would produce a
 * number that looks authoritative and is not, which is worse than silence —
 * and the run is the only place anyone would ever check it.
 */
export function rateFor(model: string | null | undefined): ModelRate | null {
  if (model === null || model === undefined) return null
  return PRICING[model] ?? null
}

/** Cost in dollars. Exact — rounding is the formatter's business. */
export function estimateCostUsd(rate: ModelRate, inputTokens: number, outputTokens: number): number {
  return (inputTokens * rate.inputPerMTok + outputTokens * rate.outputPerMTok) / 1_000_000
}
