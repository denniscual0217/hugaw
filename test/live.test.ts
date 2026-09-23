import { describe, expect, it } from "vitest"
import { resolveConfig } from "../src/core/config.js"
import { runLint } from "../src/core/runner.js"
import type { Judge, JudgeRequest, JudgeResponse } from "../src/core/judge.js"
import { typescriptAdapter } from "../src/adapters/typescript/index.js"
import { react } from "../src/plugins/react/index.js"
import { TypeSafeJudge } from "../src/judge/typesafe.js"
import { fixturePath, REPO_ROOT } from "./helpers/run-fixture.js"

const live = process.env["HUGAW_LIVE"] === "1" && (process.env["TYPESAFE_API_KEY"] ?? "") !== ""

/** One opt-in integration test against the real API (SPEC §9). */
describe.skipIf(!live)("live TypeSafe judgment", () => {
  it("warns on the constant-object fixture and matches calibration case A", async () => {
    const seen: { request: JudgeRequest; response: JudgeResponse | null }[] = []
    const inner = new TypeSafeJudge({ model: "jev-1.13.0" })
    const judge: Judge = {
      async judge(request) {
        const response = await inner.judge(request)
        seen.push({ request, response })
        return response
      },
    }

    const report = await runLint({
      config: resolveConfig({ files: ["**/*.tsx"], model: "jev-1.13.0", plugins: [react] }),
      adapters: [typescriptAdapter],
      judge,
      cwd: REPO_ROOT,
      files: [fixturePath("should-warn/constant-object.tsx")],
    })

    expect(report.errors).toEqual([])
    expect(seen.length).toBe(1)

    const answers = seen[0]!.response!.answers
    const cost = answers["react/pointless-usememo::cost"]!
    const identity = answers["react/pointless-usememo::identity_matters"]!
    expect(cost.type).toBe("score")
    expect(identity.type).toBe("noul")
    if (cost.type !== "score" || identity.type !== "noul") throw new Error("unreachable")

    // Calibration case A: cost 0.00 / conf 1.00 / identity 0.08 → WARN.
    expect(cost.score).toBeLessThan(1.2)
    expect(cost.confidence).toBeGreaterThanOrEqual(0.6)
    expect(identity.noul).toBeLessThanOrEqual(0.4)

    expect(report.findings.length).toBe(1)
    expect(report.findings[0]!.message).toContain("useMemo has no effect")
    expect(report.stats.inputTokens).toBeGreaterThan(0)
  })

  it("stays silent on an expensive computation (calibration case E)", async () => {
    const report = await runLint({
      config: resolveConfig({ files: ["**/*.tsx"], model: "jev-1.13.0", plugins: [react] }),
      adapters: [typescriptAdapter],
      judge: new TypeSafeJudge({ model: "jev-1.13.0" }),
      cwd: REPO_ROOT,
      files: [fixturePath("should-pass/sort-and-group.tsx")],
    })
    expect(report.errors).toEqual([])
    expect(report.stats.judged).toBe(1)
    expect(report.findings).toEqual([])
  })
})
