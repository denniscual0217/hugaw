import { resolve } from "node:path"
import { typescriptAdapter } from "../../src/adapters/typescript/index.js"
import { resolveConfig } from "../../src/core/config.js"
import type { Judge } from "../../src/core/judge.js"
import type { RunReport } from "../../src/core/report.js"
import { runLint } from "../../src/core/runner.js"
import { react } from "../../src/plugins/react/index.js"

export const REPO_ROOT = resolve(import.meta.dirname, "../..")
export const FIXTURES_ROOT = resolve(REPO_ROOT, "fixtures")

/**
 * Fixtures are grouped per rule, then per bucket:
 * `fixtures/<rule name>/should-warn/…`. This helper is scoped to one rule so
 * its callers pass bucket-relative paths; rule #2 passes its own `rule`
 * rather than repeating the path munging.
 */
export const DEFAULT_RULE = "pointless-usememo"

export function fixturePath(relative: string, rule: string = DEFAULT_RULE): string {
  return resolve(FIXTURES_ROOT, rule, relative)
}

export interface RunFixtureOptions {
  readonly judge: Judge
  /**
   * The rule the fixture belongs to: both the directory under `fixtures/` and,
   * by default, the only rule allowed to run.
   *
   * This is a *redefinition*. The field used to be a bare `ruleFilter`
   * passthrough taking a full rule id, with the fixture directory always the
   * default — no caller ever set it, so nothing moves, but the two meanings
   * are easy to confuse and only one of them is now supported.
   *
   * The filter matters because rules are batched per unit, not per file.
   * `fixtures/pointless-usememo/should-pass/dep-array.tsx` contains a
   * `useEffect`; once a second rule selects those, the memo suite's requests
   * carry two candidates, `stats.judged` counts participants rather than
   * candidates-of-the-rule-under-test (`runner.ts`), and assertions like
   * `expect(report.stats.judged).toBe(1)` fail for a reason that has nothing
   * to do with what the test is about. Scoping each fixture run to its own
   * rule keeps a suite measuring its own rule.
   */
  readonly rule?: string
  /**
   * Overrides the filter `rule` implies: a full rule id, or `null` to run
   * every enabled rule. `null` is how the batching proof — one request, two
   * rules, one unit — gets written.
   */
  readonly ruleFilter?: string | null
  readonly model?: string
}

/**
 * Tests never go through the config file — they build a ResolvedConfig
 * directly, so a fixture failure is never a config-loading failure.
 */
export async function runFixture(relative: string, options: RunFixtureOptions): Promise<RunReport> {
  const rule = options.rule ?? DEFAULT_RULE
  const config = resolveConfig({
    files: ["**/*.{ts,tsx}"],
    model: options.model ?? "jev-1.13.0",
    plugins: [react],
  })
  // `resolveRules` defaults every unlisted rule to its own `defaultSeverity`,
  // so the filter — not the config's `rules` map — is what scopes a run.
  const ruleFilter = options.ruleFilter === undefined ? `react/${rule}` : options.ruleFilter
  return runLint({
    config,
    adapters: [typescriptAdapter],
    judge: options.judge,
    cwd: REPO_ROOT,
    files: [fixturePath(relative, rule)],
    ...(ruleFilter === null ? {} : { ruleFilter }),
  })
}
