import type { RunStats } from "../core/index.js"
import { estimateCostUsd, rateFor } from "../judge/pricing.js"
import type { ModelRate } from "../judge/pricing.js"

/**
 * What a run cost, in the two shapes the output needs: a clause for humans
 * and a record for machines.
 *
 * The numbers already existed — the API returns them, the judge reads them,
 * the runner accumulates them — and nothing printed them. A linter that
 * spends money per run and never says how much is asking to be trusted on a
 * number nobody can see.
 */

/** `842` · `1.2k` · `133.4k` · `1.4M`. One decimal, so the magnitude reads at a glance. */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0"
  if (count < 1_000) return String(Math.round(count))
  // Promote before the `k` figure would reach four digits: `1000.0k` is a
  // worse way of writing `1.0M`.
  if (count / 1_000 < 999.95) return `${(count / 1_000).toFixed(1)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/**
 * Dollars, at a precision that never rounds a real cost to nothing.
 *
 * `$0.00` for a run that spent something is the one output worse than no
 * figure at all: it reads as "free" and is wrong. Below a hundredth of a
 * cent the honest thing is to say the run cost less than the smallest amount
 * this format can show.
 */
export function formatCostUsd(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0.0000"
  if (cost >= 0.01) return `$${cost.toFixed(2)}`
  if (cost >= 0.0001) return `$${cost.toFixed(4)}`
  return "<$0.0001"
}

/** `$0.042/M`, or both halves when output tokens are not free. */
export function formatRate(rate: ModelRate): string {
  if (rate.outputPerMTok === 0) return `$${rate.inputPerMTok}/M`
  return `$${rate.inputPerMTok}/M in · $${rate.outputPerMTok}/M out`
}

/**
 * The clause appended to the stats line, or null when there is nothing to
 * say.
 *
 * Null on a run that spent nothing — a dry run, or (one day) a run served
 * entirely from cache. Printing `0 tokens · $0.0000` there would invite the
 * reader to check a number that means "we did not ask", not "it was free".
 */
export function usageClause(stats: RunStats): string | null {
  const total = stats.inputTokens + stats.outputTokens
  if (total === 0) return null

  const tokens = `${formatTokens(total)} tokens`
  const rate = rateFor(stats.model)
  // An unpriced model gets tokens and no dollars. Guessing with another
  // model's rate would print a figure that looks checked and is not.
  if (rate === null) return tokens
  const cost = estimateCostUsd(rate, stats.inputTokens, stats.outputTokens)
  return `${tokens} · ${formatCostUsd(cost)} @ ${formatRate(rate)}`
}

export interface UsageMetadata {
  readonly model: string | null
  readonly requests: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly estimatedCostUsd?: number
  readonly rate?: ModelRate
}

/** Full precision: rounding is a display concern and JSON is not a display. */
export function usageMetadata(stats: RunStats): UsageMetadata {
  const rate = rateFor(stats.model)
  return {
    model: stats.model,
    requests: stats.requests,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    // Omitted rather than zeroed or nulled for an unpriced model: a consumer
    // summing these must not silently add a zero it thinks is a measurement.
    ...(rate === null
      ? {}
      : {
          estimatedCostUsd: estimateCostUsd(rate, stats.inputTokens, stats.outputTokens),
          rate,
        }),
  }
}
