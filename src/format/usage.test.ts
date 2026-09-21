import { describe, expect, it } from "vitest"
import type { RunStats } from "../core/index.js"
import { emptyStats } from "../core/index.js"
import { PRICING } from "../judge/pricing.js"
import { formatCostUsd, formatRate, formatTokens, usageClause, usageMetadata } from "./usage.js"

function stats(over: Partial<RunStats> = {}): RunStats {
  return { ...emptyStats(), ...over }
}

describe("formatTokens", () => {
  const cases: [number, string][] = [
    [0, "0"],
    [1, "1"],
    [999, "999"],
    // The boundaries: the unit changes at exactly 1_000 and 1_000_000.
    [1_000, "1.0k"],
    [1_200, "1.2k"],
    [133_402, "133.4k"],
    // Promoted rather than printed as `1000.0k`.
    [999_999, "1.0M"],
    [1_000_000, "1.0M"],
    [1_400_000, "1.4M"],
  ]
  it.each(cases)("%i -> %s", (count, expected) => {
    expect(formatTokens(count)).toBe(expected)
  })

  it("does not print a negative or a NaN count", () => {
    expect(formatTokens(-5)).toBe("0")
    expect(formatTokens(Number.NaN)).toBe("0")
  })
})

describe("formatCostUsd", () => {
  it("never rounds a real cost to zero", () => {
    // `$0.00` on a run that spent something reads as "free" and is wrong.
    expect(formatCostUsd(0.005586)).toBe("$0.0056")
    expect(formatCostUsd(0.000153)).toBe("$0.0002")
    expect(formatCostUsd(0.00001)).toBe("<$0.0001")
    expect(formatCostUsd(0.0000001)).toBe("<$0.0001")
  })

  it("uses cents once there are cents to show", () => {
    expect(formatCostUsd(0.01)).toBe("$0.01")
    expect(formatCostUsd(1.239)).toBe("$1.24")
  })

  it("prints an exact zero as zero", () => {
    expect(formatCostUsd(0)).toBe("$0.0000")
  })
})

describe("formatRate", () => {
  it("prints one figure when output tokens are free", () => {
    expect(formatRate({ inputPerMTok: 0.042, outputPerMTok: 0 })).toBe("$0.042/M")
  })

  it("prints both when they are not", () => {
    expect(formatRate({ inputPerMTok: 3, outputPerMTok: 15 })).toBe("$3/M in · $15/M out")
  })
})

describe("usageClause", () => {
  it("names the rate beside the total, so a stale price is visible", () => {
    expect(
      usageClause(stats({ model: "jev-1.13.0", inputTokens: 133_402, outputTokens: 0 })),
    ).toBe("133.4k tokens · $0.0056 @ $0.042/M")
  })

  it("prints tokens and no dollars for a model it has no price for", () => {
    // Guessing with another model's rate would print a figure that looks
    // checked and is not.
    const clause = usageClause(stats({ model: "jev-9.9.9", inputTokens: 12_000 }))
    expect(clause).toBe("12.0k tokens")
    expect(clause).not.toContain("$")
  })

  it("prints tokens and no dollars when no model was reported at all", () => {
    expect(usageClause(stats({ model: null, inputTokens: 500 }))).toBe("500 tokens")
  })

  it("says nothing at all when the run spent nothing", () => {
    // A dry run asked for no judgment. "0 tokens · $0.0000" invites the
    // reader to check a number that means "we did not ask".
    expect(usageClause(stats({ model: "jev-1.13.0" }))).toBe(null)
    expect(usageClause(emptyStats())).toBe(null)
  })

  it("counts output tokens in the total even though they are free here", () => {
    expect(
      usageClause(stats({ model: "jev-1.13.0", inputTokens: 1_000, outputTokens: 500 })),
    ).toBe("1.5k tokens · <$0.0001 @ $0.042/M")
  })
})

describe("usageMetadata", () => {
  it("carries full precision, because rounding is a display concern", () => {
    expect(
      usageMetadata(
        stats({ model: "jev-1.13.0", requests: 38, inputTokens: 133_402, outputTokens: 4_180 }),
      ),
    ).toEqual({
      model: "jev-1.13.0",
      requests: 38,
      inputTokens: 133_402,
      outputTokens: 4_180,
      estimatedCostUsd: (133_402 * 0.042) / 1_000_000,
      rate: { inputPerMTok: 0.042, outputPerMTok: 0 },
    })
  })

  it("omits the cost and the rate for an unpriced model rather than zeroing them", () => {
    // A consumer summing these must not silently add a zero it believes is a
    // measurement.
    const metadata = usageMetadata(stats({ model: "mystery-1", requests: 2, inputTokens: 90 }))
    expect(metadata).toEqual({
      model: "mystery-1",
      requests: 2,
      inputTokens: 90,
      outputTokens: 0,
    })
    expect("estimatedCostUsd" in metadata).toBe(false)
    expect("rate" in metadata).toBe(false)
  })
})

describe("the price table", () => {
  it("is keyed by resolved model ids, not aliases", () => {
    // `jev-latest` resolves to whatever is current; pricing it would mean
    // pricing whatever it pointed at when this table was written.
    expect(Object.keys(PRICING)).not.toContain("jev-latest")
    for (const id of Object.keys(PRICING)) expect(id).toMatch(/\d+\.\d+\.\d+$/)
  })
})
