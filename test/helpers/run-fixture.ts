import { resolve } from "node:path"
import { typescriptAdapter } from "../../src/adapters/typescript/index.js"
import { resolveConfig } from "../../src/core/config.js"
import type { Judge } from "../../src/core/judge.js"
import type { RunReport } from "../../src/core/report.js"
import { runLint } from "../../src/core/runner.js"
import { react } from "../../src/plugins/react/index.js"

export const REPO_ROOT = resolve(import.meta.dirname, "../..")

export function fixturePath(relative: string): string {
  return resolve(REPO_ROOT, "fixtures", relative)
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
