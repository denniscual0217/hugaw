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
  readonly rule?: string
  readonly model?: string
}

/**
 * Tests never go through the config file — they build a ResolvedConfig
 * directly, so a fixture failure is never a config-loading failure.
 */
export async function runFixture(relative: string, options: RunFixtureOptions): Promise<RunReport> {
  const config = resolveConfig({
    files: ["**/*.{ts,tsx}"],
    model: options.model ?? "jev-1.13.0",
    plugins: [react],
  })
  return runLint({
    config,
    adapters: [typescriptAdapter],
    judge: options.judge,
    cwd: REPO_ROOT,
    files: [fixturePath(relative)],
    ...(options.rule === undefined ? {} : { ruleFilter: options.rule }),
  })
}
