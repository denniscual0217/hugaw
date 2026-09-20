import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { dryRunJudge } from "../judge/dry-run.js"
import {
  fakeTextAdapter,
  fakeTextPlugin,
  resetSliceCalls,
  sliceCalls,
} from "../../test/helpers/fake-language.js"
import { createMockJudge } from "../../test/helpers/mock-judge.js"
import { resolveConfig } from "./config.js"
import type { ResolvedConfig } from "./config.js"
import { runLint } from "./runner.js"

let cwd: string

const SAMPLE = [
  "component alpha",
  "  TODO wire the button",
  "  FIXME null check",
  "",
  "component beta",
  "  TODO polish copy (ok)",
  "",
  "component gamma",
  "  TODO one",
  "  TODO two",
].join("\n")

function config(overrides: Record<string, unknown> = {}): ResolvedConfig {
  return resolveConfig({
    files: ["**/*.txt"],
    model: "fake-model",
    plugins: [fakeTextPlugin],
    ...overrides,
  })
}

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "hugaw-core-"))
  writeFileSync(join(cwd, "sample.txt"), SAMPLE, "utf8")
})

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true })
})

beforeEach(() => {
  resetSliceCalls()
})

describe("runLint with a non-TypeScript language", () => {
  it("namespaces questions per rule and demultiplexes answers back", async () => {
    const { judge, calls } = createMockJudge(() => ({ important: 0.9, urgency: 1 }))
    const report = await runLint({ config: config(), adapters: [fakeTextAdapter], judge, cwd })

    expect(report.errors).toEqual([])

    // One unit holds both a TODO and a FIXME: one request, both rules merged.
    const alpha = calls.find((c) => c.state["unit_text"]?.toString().includes("alpha"))
    expect(alpha).toBeDefined()
    expect(Object.keys(alpha!.questions).sort()).toEqual([
      "fake/fixme::urgency",
      "fake/todo::important",
    ])

    const messages = report.findings.map((f) => `${f.ruleId} ${f.message}`)
    expect(messages).toContain("fake/todo important TODO: TODO wire the button")
    expect(messages).toContain("fake/fixme urgent FIXME (1)")
    // Severity comes from meta.defaultSeverity when config says nothing.
    expect(report.findings.find((f) => f.ruleId === "fake/fixme")?.severity).toBe(2)
    expect(report.findings.find((f) => f.ruleId === "fake/todo")?.severity).toBe(1)
  })

  it("passes each rule only its own answers", async () => {
    const seen: Record<string, string[]> = {}
    const plugin = {
      ...fakeTextPlugin,
      rules: fakeTextPlugin.rules.map((rule) => ({
        ...rule,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy wrapper
        decide(answers: any, input: any) {
          seen[rule.name] = Object.keys(answers).sort()
          return rule.decide(answers, input)
        },
      })),
    }
    const { judge } = createMockJudge(() => ({ important: 0.9, urgency: 1 }))
    await runLint({
      config: config({ plugins: [plugin] }),
      adapters: [fakeTextAdapter],
      judge,
      cwd,
    })
    expect(seen["todo"]).toEqual(["important"])
    expect(seen["fixme"]).toEqual(["urgency"])
  })

  it("builds a unit-scoped slice at most once per unit", async () => {
    const { judge, calls } = createMockJudge(() => ({ important: 0, urgency: 0 }))
    await runLint({ config: config(), adapters: [fakeTextAdapter], judge, cwd })

    // alpha => 1 request (todo + fixme merged), beta => 0 (its only candidate
    // was skipped), gamma => 2 slots because one rule has two candidates.
    expect(calls.length).toBe(3)
    // `unit_text` is unit-scoped: once for alpha, once for gamma — not per slot.
    expect(sliceCalls.unit_text).toBe(2)
    // `line_text` is candidate-scoped: one per surviving TODO candidate.
    expect(sliceCalls.line_text).toBe(3)
  })

  it("records skips with the rule's exact reason and never judges them", async () => {
    const { judge, calls } = createMockJudge(() => ({ important: 0.9, urgency: 0 }))
    const report = await runLint({
      config: config(),
      adapters: [fakeTextAdapter],
      judge,
      cwd,
      ruleFilter: "fake/todo",
    })
    expect(report.skipped.map((s) => s.reason)).toEqual(["explicitly marked ok"])
    expect(report.stats.skippedStatically).toBe(1)
    expect(calls.every((c) => !JSON.stringify(c.state).includes("(ok)"))).toBe(true)
  })

  it("short-circuits on a declining judge (dry run) without deciding", async () => {
    const report = await runLint({
      config: config(),
      adapters: [fakeTextAdapter],
      judge: dryRunJudge,
      cwd,
    })
    expect(report.findings).toEqual([])
    expect(report.requests.length).toBe(3)
    expect(report.requests.every((r) => r.judged === false)).toBe(true)
    expect(report.stats.judged).toBe(0)
    expect(report.stats.requests).toBe(0)
    // Payloads are still fully built, which is the point of --dry-run.
    expect(report.requests[0]?.request.state["unit_text"]).toBeTypeOf("string")
  })

  it("fails fatally when a plugin's language has no adapter", async () => {
    const { judge } = createMockJudge()
    const report = await runLint({ config: config(), adapters: [], judge, cwd })
    expect(report.errors[0]?.fatal).toBe(true)
    expect(report.errors[0]?.message).toContain('targets language "text"')
  })

  it("fails fatally on an unknown --rule", async () => {
    const { judge } = createMockJudge()
    const report = await runLint({
      config: config(),
      adapters: [fakeTextAdapter],
      judge,
      cwd,
      ruleFilter: "fake/nope",
    })
    expect(report.errors[0]?.fatal).toBe(true)
    expect(report.errors[0]?.message).toContain('Unknown rule "fake/nope"')
  })

  it("honours rule severity and messageSuffix from config", async () => {
    const { judge } = createMockJudge(() => ({ important: 0.9 }))
    const report = await runLint({
      config: config({
        rules: {
          "fake/todo": ["error", { messageSuffix: "See docs/todo.md." }],
          "fake/fixme": "off",
        },
      }),
      adapters: [fakeTextAdapter],
      judge,
      cwd,
    })
    expect(report.findings.every((f) => f.ruleId === "fake/todo")).toBe(true)
    expect(report.findings[0]?.severity).toBe(2)
    expect(report.findings[0]?.message.endsWith("See docs/todo.md.")).toBe(true)
  })

  it("accumulates usage from the judge", async () => {
    const { judge } = createMockJudge(() => ({ important: 0, urgency: 0 }))
    const report = await runLint({ config: config(), adapters: [fakeTextAdapter], judge, cwd })
    expect(report.stats.requests).toBe(3)
    expect(report.stats.inputTokens).toBe(300)
  })
})
